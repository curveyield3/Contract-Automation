// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.18;

/// @notice Vault's original ERC-20 shares. These units are NOT transferable governance tokens.
interface IWbtcVaultShares {
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

/// @dev Exact Morpho Blue public ABI. The collateral is in the original asset units.
///      Per-user collateral is uint128; supplyShares is NOT collateral.
interface IMorphoBlueCollateral {
    function position(bytes32 id, address user)
        external view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);
    function idToMarketParams(bytes32 id)
        external view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv);
}

/// @dev CurveLend v1/v2 controller common ABI. Curved markets may use
///      distinct controller generations; deployment must source-confirm exact ABI.
interface ICurveLendControllerRead {
    function collateral_token() external view returns (address);
    function amm() external view returns (address);
}

/// @dev LLAMMA's sum_y gives the actual collateral-token units in user bands,
///      NOT the originally deposited shares, and changes with soft liquidation.
interface ICurveLendAmmRead {
    function coins(uint256 index) external view returns (address);
    function get_sum_xy(address user) external view returns (uint256[2] memory xy);
}

/// @title WbtcIporWeightedSources
/// @notice Minimal source-adapter evolution of AragonOne / 1Hive Gardens'
///         original VotingAggregator._aggregateAt source-weighting method.
/// @dev Read-only voting attribution plus DAO-controlled market registration.
///      This is NOT an Aragon plugin and does NOT itself prove an atomic census.
///      Snapshot source may use these per-address reads when it freezes voters.
///
///      Original source:
///      TurmericLabs/voting-aggregator-app/contracts/VotingAggregator.sol
///      commit bec6f0aa472f03e04b5276ca7092c3320095d1cd
///      original licence (GPL-3.0-or-later OR AGPL-3.0-or-later).
contract WbtcIporWeightedSources {
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant DIRECT_SHARE_WEIGHT_BPS = 10000;
    uint256 public constant MARKET_SHARE_WEIGHT_BPS = 5000;
    uint256 public constant MAX_MARKETS = 20; // AragonOne aggregator's original MAX_SOURCES.

    enum SourceType { Invalid, MorphoCollateral, CurveLendCollateral }

    struct PowerSource {
        SourceType sourceType;
        address market; // Morpho Blue singleton or CurveLend controller
        address custody; // Morpho singleton or CurveLend AMM
        bytes32 marketId; // Morpho market ID, 0 for CurveLend
        bool enabled;
    }

    IWbtcVaultShares public immutable shareToken;
    address public immutable dao;
    IMorphoBlueCollateral public immutable morphoBlue;
    PowerSource[] private powerSources;
    mapping(bytes32 => bool) public knownSource;

    error OnlyDAO();
    error InvalidMarketSource();
    error DuplicateMarketSource();
    error MarketLimitReached();
    error WholeSupplyProofRequired();

    event AddPowerSource(uint256 indexed index, address indexed market, SourceType kind, bytes32 id, uint16 weightBps);
    event SetPowerSourceEnabled(uint256 indexed index, bool enabled);

    constructor(address vaultShares, address boundDAO, address canonicalMorphoBlue) {
        require(vaultShares.code.length != 0 && boundDAO != address(0) && canonicalMorphoBlue.code.length != 0,
            "INVALID_SOURCE_BOUNDARY");
        shareToken = IWbtcVaultShares(vaultShares);
        dao = boundDAO;
        morphoBlue = IMorphoBlueCollateral(canonicalMorphoBlue);
    }

    modifier onlyDAO() {
        if (msg.sender != dao) revert OnlyDAO();
        _;
    }

    function getPowerSourcesLength() external view returns (uint256) {
        return powerSources.length;
    }

    function powerSource(uint256 index) external view returns (PowerSource memory) {
        return powerSources[index];
    }

    /// @notice New market registrations occur only through a DAO-executed
    ///         standard proposal, and affect only future proposal snapshots.
    function addVotingMarket(SourceType sourceType, address market, bytes32 marketId) external onlyDAO {
        if (powerSources.length >= MAX_MARKETS) revert MarketLimitReached();
        if (market.code.length == 0) revert InvalidMarketSource();

        address custody;
        if (sourceType == SourceType.MorphoCollateral) {
            if (market != address(morphoBlue) || marketId == bytes32(0)) revert InvalidMarketSource();
            (address loanToken, address collateralToken,,,) = morphoBlue.idToMarketParams(marketId);
            if (loanToken == address(0) || collateralToken != address(shareToken)) revert InvalidMarketSource();
            custody = market;
        } else if (sourceType == SourceType.CurveLendCollateral) {
            if (marketId != bytes32(0)) revert InvalidMarketSource();
            ICurveLendControllerRead controller = ICurveLendControllerRead(market);
            if (controller.collateral_token() != address(shareToken)) revert InvalidMarketSource();
            custody = controller.amm();
            if (custody.code.length == 0 || ICurveLendAmmRead(custody).coins(1) != address(shareToken)) {
                revert InvalidMarketSource();
            }
        } else {
            revert InvalidMarketSource();
        }

        bytes32 key = keccak256(abi.encode(sourceType, market, marketId));
        if (knownSource[key]) revert DuplicateMarketSource();
        knownSource[key] = true;
        powerSources.push(PowerSource(sourceType, market, custody, marketId, true));
        emit AddPowerSource(powerSources.length - 1, market, sourceType, marketId, uint16(MARKET_SHARE_WEIGHT_BPS));
    }

    function setVotingMarketEnabled(uint256 index, bool enabled) external onlyDAO {
        PowerSource storage source = powerSources[index];
        if (source.enabled == enabled) revert InvalidMarketSource();
        source.enabled = enabled;
        emit SetPowerSourceEnabled(index, enabled);
    }

    /// @notice Exact eligible owner's *current* economic shares, not a future
    ///         voting snapshot. Freeze caller must read ALL voters in one tx.
    ///
    ///         Direct shares are weighted 1x, underlying collateral attributed
    ///         to owners in approved markets is weighted 0.5x. Vault shares held
    ///         by the market custody contracts are NOT simultaneously eligible
    ///         as the custody contract's own direct voting shares.
    function baseVotingPower(address owner) external view returns (uint256) {
        (uint256 directShares, uint256 marketShares) = rawSources(owner);
        return directShares + marketShares / 2;
    }

    /// @notice Gardens-style weighted aggregation, split to expose raw values.
    function rawSources(address owner) public view returns (uint256 directShares, uint256 marketShares) {
        // Do not count custodial addresses as ordinary direct-share voters.
        if (owner != address(morphoBlue) && !_isApprovedCustody(owner)) {
            directShares = shareToken.balanceOf(owner);
        }
        for (uint256 i; i < powerSources.length;) {
            PowerSource storage source = powerSources[i];
            if (source.enabled) {
                if (source.sourceType == SourceType.MorphoCollateral) {
                    (,,uint128 collateral) = morphoBlue.position(source.marketId, owner);
                    marketShares += uint256(collateral);
                } else if (source.sourceType == SourceType.CurveLendCollateral) {
                    uint256[2] memory xy = ICurveLendAmmRead(source.custody).get_sum_xy(owner);
                    marketShares += xy[1];
                } else {
                    revert InvalidMarketSource();
                }
            }
            unchecked { ++i; }
        }
    }

    function _isApprovedCustody(address owner) private view returns (bool) {
        for (uint256 i; i < powerSources.length;) {
            if (powerSources[i].custody == owner) return true;
            unchecked { ++i; }
        }
        return false;
    }

    // Activated-voter registry and proposal-frozen snapshots. The original
    // Gardens source-aggregation rule remains rawSources() above.
    address public votingPlugin;
    uint64 public constant INACTIVITY_WINDOW = 90 days;
    uint8 public constant MINIMUM_MISSED_PROPOSALS = 2;

    struct ActivatedVoter {
        uint64 continuousSince;
        uint64 lastVoteOrResetAt;
        bool everRegistered;
    }
    struct TrackedProposal {
        uint64 votingEnd;
        bool canceled;
        bool registered;
    }

    address[] private registeredVoters;
    uint256[] private proposalIds;
    mapping(address => ActivatedVoter) public voterState;
    mapping(uint256 => TrackedProposal) public trackedProposal;
    mapping(uint256 => mapping(address => uint256)) public frozenVotingPower;
    mapping(uint256 => mapping(address => bool)) public votedOnProposal;
    mapping(uint256 => bool) public snapshotFrozen;
    mapping(uint256 => uint256) public snapshotTotalWeight;

    error OnlyVotingPlugin();
    error VotingPluginAlreadyBound();
    error InvalidSnapshot();
    error SnapshotExists();
    error NoActiveCommunity();

    event VotingPluginBound(address indexed plugin);
    event VoterActivated(address indexed voter, uint64 continuousSince);
    event SnapshotFrozen(uint256 indexed proposalId, uint256 totalWeight, uint256 communityMembers);
    event VoterParticipationRecorded(uint256 indexed proposalId, address indexed voter);

    modifier onlyPlugin() {
        if (msg.sender != votingPlugin || votingPlugin == address(0)) revert OnlyVotingPlugin();
        _;
    }

    /// @notice Bind once through the authorized Aragon DAO deployment process.
    function bindVotingPlugin(address plugin) external onlyDAO {
        if (votingPlugin != address(0)) revert VotingPluginAlreadyBound();
        if (plugin.code.length == 0) revert InvalidSnapshot();
        votingPlugin = plugin;
        emit VotingPluginBound(plugin);
    }

    function voterCount() external view returns (uint256) {
        return registeredVoters.length;
    }

    function voterAt(uint256 index) external view returns (address) {
        return registeredVoters[index];
    }

    function trackedProposalCount() external view returns (uint256) {
        return proposalIds.length;
    }

    /// @notice Called after IPOR's existing delegateBySig has confirmed
    /// self-delegation. A second opt-in resets expiry only when expired.
    function activate(address voter) external onlyPlugin {
        if (voter == address(0) || voter == address(morphoBlue) || _isApprovedCustody(voter)) {
            revert InvalidSnapshot();
        }
        ActivatedVoter storage state = voterState[voter];
        if (!state.everRegistered) {
            registeredVoters.push(voter);
            state.everRegistered = true;
        }
        if (!_active(voter)) {
            state.continuousSince = uint64(block.timestamp);
            state.lastVoteOrResetAt = uint64(block.timestamp);
        }
        emit VoterActivated(voter, state.continuousSince);
    }

    function activated(address voter) external view returns (bool) {
        return _active(voter);
    }

    function _active(address voter) internal view returns (bool) {
        if (!voterState[voter].everRegistered) return false;
        (uint256 misses, uint256 firstMissEnd) = _missedSinceLastVote(voter);
        return misses < MINIMUM_MISSED_PROPOSALS
            || firstMissEnd == 0 || block.timestamp < firstMissEnd + INACTIVITY_WINDOW;
    }

    function _missedSinceLastVote(address voter)
        internal view returns (uint256 misses, uint256 firstMissEnd)
    {
        uint64 lastParticipation = voterState[voter].lastVoteOrResetAt;
        for (uint256 i; i < proposalIds.length;) {
            uint256 id = proposalIds[i];
            TrackedProposal storage p = trackedProposal[id];
            if (p.registered && !p.canceled && p.votingEnd != 0
                && p.votingEnd <= block.timestamp && p.votingEnd > lastParticipation
                && frozenVotingPower[id][voter] > 0 && !votedOnProposal[id][voter]) {
                misses += 1;
                if (firstMissEnd == 0 || p.votingEnd < firstMissEnd) firstMissEnd = p.votingEnd;
            }
            unchecked { ++i; }
        }
    }

    function recordVote(uint256 id, address voter) external onlyPlugin {
        if (!snapshotFrozen[id] || frozenVotingPower[id][voter] == 0 || votedOnProposal[id][voter]) {
            revert InvalidSnapshot();
        }
        votedOnProposal[id][voter] = true;
        if (voterState[voter].everRegistered) {
            ActivatedVoter storage state = voterState[voter];
            if (!_active(voter)) state.continuousSince = uint64(block.timestamp);
            state.lastVoteOrResetAt = uint64(block.timestamp);
        }
        emit VoterParticipationRecorded(id, voter);
    }

    function registerProposal(uint256 id, uint64 votingEnd) external onlyPlugin {
        if (!snapshotFrozen[id] || trackedProposal[id].registered || votingEnd <= block.timestamp) {
            revert InvalidSnapshot();
        }
        trackedProposal[id] = TrackedProposal(votingEnd, false, true);
        proposalIds.push(id);
    }

    function updateVotingEnd(uint256 id, uint64 newEnd) external onlyPlugin {
        TrackedProposal storage p = trackedProposal[id];
        if (!p.registered || p.canceled || p.votingEnd <= block.timestamp || newEnd <= block.timestamp) {
            revert InvalidSnapshot();
        }
        p.votingEnd = newEnd;
    }

    function cancelGuardianVeto(uint256 id) external onlyPlugin {
        TrackedProposal storage p = trackedProposal[id];
        if (!p.registered || p.votingEnd <= block.timestamp) revert InvalidSnapshot();
        p.canceled = true;
    }

    /// @notice Full atomic census of currently active registered addresses.
    /// Safe bonus is exactly 15/85 of the non-Safe community (integer exact).
    function freezeAtomic(
        uint256 id, uint8 kind, uint256 anchorBlock, address creator, address guardian, bool removed
    ) external onlyPlugin returns (uint256 eligibleWeight, uint256 denominator, uint256 creatorWeight) {
        if (block.number != anchorBlock || guardian == address(0)) revert InvalidSnapshot();
        if (snapshotFrozen[id]) revert SnapshotExists();
        if (kind != 0) revert WholeSupplyProofRequired(); // special type requires proven whole-supply weight
        uint256 community;
        uint256 members;
        for (uint256 i; i < registeredVoters.length;) {
            address voter = registeredVoters[i];
            if (_active(voter) && (voter != guardian || removed)) {
                (uint256 directShares, uint256 marketShares) = rawSources(voter);
                uint256 basePower = directShares + marketShares / 2;
                if (basePower != 0) {
                    frozenVotingPower[id][voter] = removed ? basePower : basePower * 85;
                    community += basePower;
                    members += 1;
                }
            }
            unchecked { ++i; }
        }
        if (community == 0) revert NoActiveCommunity();
        if (removed) {
            eligibleWeight = community;
        } else {
            frozenVotingPower[id][guardian] = community * 15;
            eligibleWeight = community * 100;
        }
        denominator = eligibleWeight;
        creatorWeight = frozenVotingPower[id][creator];
        snapshotFrozen[id] = true;
        snapshotTotalWeight[id] = eligibleWeight;
        emit SnapshotFrozen(id, eligibleWeight, members);
    }

    /// @notice Historical previews are not authoritative from live balances.
    /// Actual per-proposal denominators are frozen by freezeAtomic().
    function previewStandardTotalVotingPower(uint256) external pure returns (uint256) {
        revert InvalidSnapshot();
    }

    /// @notice Intentionally fail-closed. Morpho Blue exposes a per-user
    ///         collateral field but no simple aggregate per-market collateral
    ///         getter. totalSupply - 0.5 * balanceOf(Morpho) is NOT equivalent
    ///         to the approved-market weighted whole-supply denominator.
    ///         Guardian removal must use a complete authenticated census or
    ///         a separately proven global market sum.
    function guardianRemovalDenominator() external pure returns (uint256) {
        revert WholeSupplyProofRequired();
    }
}
