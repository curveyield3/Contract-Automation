// SPDX-License-Identifier: AGPL-3.0-or-later

pragma solidity ^0.8.8;

import {DAO, IDAO, Action} from "@aragon/osx/core/dao/DAO.sol";
import {IProposal} from "@aragon/osx-commons-contracts/src/plugin/extensions/proposal/IProposal.sol";
import {MajorityVotingBase} from "./base/MajorityVotingBase.sol";
import {PluginUUPSUpgradeable} from "@aragon/osx/framework/plugin/setup/PluginSetupProcessor.sol";
import {IMembership} from "@aragon/osx-commons-contracts/src/plugin/extensions/membership/IMembership.sol";
import {_applyRatioCeiled} from "@aragon/osx-commons-contracts/src/utils/math/Ratio.sol";

import {IVotesUpgradeable} from "@openzeppelin/contracts-upgradeable/governance/utils/IVotesUpgradeable.sol";
import {SafeCastUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {IERC6372Upgradeable} from "@openzeppelin/contracts-upgradeable/interfaces/IERC6372Upgradeable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {BokkyPooBahsDateTimeLibrary} from "./lib/BokkyPooBahsDateTimeLibrary.sol";

interface IParentSPP {
    function isGuardianRemoval(uint256 id) external view returns (bool);
    function getProposalCreator(uint256 id) external view returns (address);
}
interface IMorphoMarketRead {
    function position(bytes32 id, address user) external view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);
    function idToMarketParams(bytes32 id) external view
        returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv);
}
interface ICurveMarketRead {
    function collateral_token() external view returns (address);
    function amm() external view returns (address);
}
interface ICurveAmmRead {
    function coins(uint256 i) external view returns (address);
    function get_sum_xy(address user) external view returns (uint256[2] memory values);
}
interface INonceSource { function nonces(address) external view returns (uint256); }


/// @title TokenVoting
/// @author Aragon X - 2021-2025
/// @notice The majority voting implementation using an
///         [OpenZeppelin `Votes`](https://docs.openzeppelin.com/contracts/4.x/api/governance#Votes)
///         compatible governance token.
/// @dev v1.4 (Release 1, Build 4). For each upgrade, if the reinitialization step is required,
///      increment the version numbers in the modifier for both the initialize and initializeFrom functions.
/// @custom:security-contact sirt@aragon.org
contract WbtcIporTokenVoting is IMembership, MajorityVotingBase {
    using SafeCastUpgradeable for uint256;
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @notice The [ERC-165](https://eips.ethereum.org/EIPS/eip-165) interface ID of the contract.
    bytes4 internal constant TOKEN_VOTING_INTERFACE_ID = this.getVotingToken.selector;

    /// @notice An [OpenZeppelin `Votes`](https://docs.openzeppelin.com/contracts/4.x/api/governance#Votes)
    ///         compatible contract referencing the token being used for voting.
    IVotesUpgradeable private votingToken; // Slot 0

    /// @notice Wether the token contract indexes past voting power by timestamp.
    bool public tokenIndexedByTimestamp; // Slot 0

    /// @notice The list of addresses excluded from voting
    EnumerableSet.AddressSet internal excludedAccounts; // Slot 1

    // Only vault-specific sources and voter eligibility are added.
    address public immutable stagedProcessor;
    address public immutable guardianSafe;
    IMorphoMarketRead public immutable morphoBlue;
    bool public guardianRemoved;
    uint8 public inactivityMonths = 3;
    uint8 public missedProposalLimit = 2;
    uint8 public removalQualificationMonths = 3;

    enum MarketKind { Invalid, MorphoBlue, CurveLend }
    struct Market {
        MarketKind kind;
        address market;
        address custody;
        bytes32 id;
        bool enabled;
    }
    struct Voter {
        uint64 activeSince;
        uint64 lastVote;
        bool enrolled;
    }
    Market[] private markets;
    address[] private registered;
    uint256[] private priorBallots;
    mapping(address => Voter) private voters;
    mapping(uint256 => mapping(address => uint256)) private frozen;
    mapping(uint256 => bool) private bonusAt;
    mapping(uint256 => bool) private removalAt;
    mapping(uint256 => uint256) private parentSnapshotTotal;
    mapping(uint256 => uint256) private childToParent;
    mapping(uint256 => uint64) private parentSnapshotMoment;
    mapping(uint256 => uint256) private spamWeight;

    event VoterActivated(address indexed voter, uint64 continuousSince);
    event VotingMarketAdded(address indexed market, bytes32 marketId, MarketKind kind);
    event GuardianPermanentlyRemoved();
    error IncompleteCensus();
    error UnauthorizedParent();
    error InvalidMarket();

    /// @notice Emitted when an account's balance is considered as non-circulating supply. Its balance will be excluded from the token supply computation.
    /// @param accounts The addresses whose balance is considered as not circulating
    event ExcludedFromSupply(address[] accounts);

    /// @notice Thrown if the voting power is zero
    error NoVotingPower();

    /// @notice Thrown if the token reports an inconsistent clock mode and clock value
    error TokenClockMismatch();

    /// @dev Unlike the old UUPS implementation, this plugin is directly DAO
    /// bound through the existing non-upgradeable Aragon Plugin constructor.
    constructor(
        IDAO dao_,
        IVotesUpgradeable shares_,
        address spp_,
        address guardian_,
        address morpho_
    ) MajorityVotingBase(dao_) {
        if (address(shares_).code.length == 0 || spp_.code.length == 0
            || guardian_ == address(0) || morpho_.code.length == 0)
            revert NoVotingPower();
        votingToken = shares_;
        stagedProcessor = spp_;
        guardianSafe = guardian_;
        morphoBlue = IMorphoMarketRead(morpho_);
        _detectTokenClock();
        emit MembershipContractAnnounced({definingContract: address(shares_)});
    }

    /// @notice Checks if this or the parent contract supports an interface by its ID.
    /// @param _interfaceId The ID of the interface.
    /// @return Returns `true` if the interface is supported.
    function supportsInterface(bytes4 _interfaceId) public view virtual override returns (bool) {
        return _interfaceId == TOKEN_VOTING_INTERFACE_ID || _interfaceId == type(IMembership).interfaceId
            || super.supportsInterface(_interfaceId);
    }

    /// @notice Immutable Guardian removal is executed by the DAO through
    /// the native SPP plugin, never by Guardian or the token voting body.
    function permanentlyRemoveDaoGuardian() external {
        if (msg.sender != address(dao())) revert UnauthorizedParent();
        if (guardianRemoved) return; // idempotent for pre-existing proposals
        guardianRemoved = true;
        emit GuardianPermanentlyRemoved();
    }

    /// @notice Activation and IPOR-native EIP-712 self-delegation in one tx.
    function activateVotingPower(
        uint256 nonce, uint256 expiry, uint8 v, bytes32 r, bytes32 sigS
    ) external {
        address account = _msgSender();
        if (INonceSource(address(votingToken)).nonces(account) != nonce)
            revert UnauthorizedParent();
        votingToken.delegateBySig(account, nonce, expiry, v, r, sigS);
        if (INonceSource(address(votingToken)).nonces(account) != nonce + 1
            || votingToken.delegates(account) != account) revert UnauthorizedParent();
        _activate(account);
    }

    function activateVotingPower() external {
        address account = _msgSender();
        if (votingToken.delegates(account) != account) revert UnauthorizedParent();
        _activate(account);
    }

    function _activate(address account) private {
        Voter storage m = voters[account];
        if (!m.enrolled) { m.enrolled = true; registered.push(account); }
        if (!_active(account)) {
            m.activeSince = uint64(block.timestamp);
            m.lastVote = uint64(block.timestamp);
        }
        emit VoterActivated(account, m.activeSince);
    }

    function _active(address account) private view returns (bool) {
        Voter storage m = voters[account];
        if (!m.enrolled || votingToken.delegates(account) != account) return false;
        // No changes to historical participation without genuine records.
        // No unbounded voter*history scans: old data requires a ZK checkpoint.
        if (priorBallots.length > 64) revert IncompleteCensus();
        uint256 firstMiss;
        uint256 count;
        for (uint256 i; i < priorBallots.length; ++i) {
            uint256 id = priorBallots[i];
            Proposal storage proposal_ = proposals[id];
            if (proposal_.parameters.endDate <= block.timestamp
                && proposal_.parameters.endDate > m.lastVote
                && frozen[childToParent[id]][account] != 0
                && proposal_.voters[account] == VoteOption.None) {
                ++count;
                if (firstMiss == 0) firstMiss = proposal_.parameters.endDate;
            }
        }
        return count < missedProposalLimit || firstMiss == 0
            || block.timestamp < BokkyPooBahsDateTimeLibrary.addMonths(firstMiss, inactivityMonths);
    }

    function getRegisteredVoterCount() external view returns (uint256) { return registered.length; }
    function getMarketCount() external view returns (uint256) { return markets.length; }

    /// @notice DAO-approved ordinary parent proposals authorize additions.
    /// Only Morpho markets whose exact collateral is the IPOR vault share
    /// token can currently pass source authentication. Curve factory
    /// membership needs an authenticated canonical factory and is blocked.
    function addVotingMarket(MarketKind kind, address market, bytes32 id) external {
        if (msg.sender != address(dao()) || markets.length >= 20)
            revert UnauthorizedParent();
        if (kind != MarketKind.MorphoBlue
            || market != address(morphoBlue) || id == bytes32(0)) revert InvalidMarket();
        (address loanToken, address collateralToken,,,) = morphoBlue.idToMarketParams(id);
        if (loanToken == address(0) || collateralToken != address(votingToken))
            revert InvalidMarket();
        for (uint256 i; i < markets.length; ++i) {
            if (markets[i].market == market && markets[i].id == id) revert InvalidMarket();
        }
        markets.push(Market(kind, market, market, id, true));
        emit VotingMarketAdded(market, id, kind);
    }

    function _walletAndMarkets(address account) private view returns (uint256 weight) {
        bool custody = account == address(morphoBlue);
        for (uint256 i; i < markets.length; ++i) {
            if (markets[i].custody == account) custody = true;
        }
        if (!custody) weight = IERC20Upgradeable(address(votingToken)).balanceOf(account);
        uint256 marketTotal;
        for (uint256 i; i < markets.length; ++i) {
            Market storage market = markets[i];
            if (!market.enabled) continue;
            if (market.kind == MarketKind.MorphoBlue) {
                (,, uint128 collateral) = morphoBlue.position(market.id, account);
                marketTotal += uint256(collateral);
            } else if (market.kind == MarketKind.CurveLend) {
                uint256[2] memory amounts = ICurveAmmRead(market.custody).get_sum_xy(account);
                marketTotal += amounts[1];
            }
        }
        return weight + marketTotal / 2;
    }

    /// @dev For normal proposals, the registered non-Safe community is 85%
    /// and the Safe receives 15%. The formula is integer exact.
    function _freezeAtomic(uint256 id, bool removal) private returns (uint256 total) {
        if (removal) revert IncompleteCensus(); // supply-wide ZK proof required
        if (registered.length > 64 || priorBallots.length >= 64) revert IncompleteCensus();
        uint256 sum;
        for (uint256 i; i < registered.length; ++i) {
            address account = registered[i];
            if (_active(account) && (account != guardianSafe || guardianRemoved)) {
                uint256 economic = _walletAndMarkets(account);
                frozen[id][account] = guardianRemoved ? economic : 85 * economic;
                sum += economic;
            }
        }
        if (sum == 0) revert NoVotingPower();
        if (guardianRemoved) total = sum;
        else {
            frozen[id][guardianSafe] = 15 * sum;
            bonusAt[id] = true;
            total = 100 * sum;
        }
        parentSnapshotTotal[id] = total;
        parentSnapshotMoment[id] = uint64(tokenIndexedByTimestamp ? block.timestamp : block.number);
    }

    /// @notice SPP creates a parent ID first, and freezes the eligible
    /// community at that exact transaction. Stage 2 later reuses the
    /// immutable original proposal weights, not today's market balances.
    function reserveParentSnapshot(uint256 parentId, address creator, bool removal)
        external
    {
        if (msg.sender != stagedProcessor || parentSnapshotTotal[parentId] != 0)
            revert UnauthorizedParent();
        uint256 eligible = _freezeAtomic(parentId, removal);
        if (frozen[parentId][creator] * 10 < eligible) revert NoVotingPower();
    }

    /// @notice One spam bit on Aragon's original ballot, not another vote.
    function voteWithSpamFlag(uint256 id, VoteOption option) external {
        address account = _msgSender();
        vote(id, option, false);
        spamWeight[id] += frozen[childToParent[id]][account];
    }

    function isSpamApproved(uint256 id) external view returns (bool) {
        Proposal storage p = proposals[id];
        uint256 castWeight = p.tally.yes + p.tally.no + p.tally.abstain;
        return castWeight != 0 && isMinParticipationReached(id)
            && spamWeight[id] * 2 > castWeight;
    }

    /// @notice getter function for the voting token.
    /// @dev public function also useful for registering interfaceId
    ///      and for distinguishing from majority voting interface.
    /// @return The token used for voting.
    function getVotingToken() public view returns (IVotesUpgradeable) {
        return votingToken;
    }

    /// @notice Market-adjusted historic supply cannot safely be inferred
    /// from ERC20Votes.getPastTotalSupply alone. Per-proposal frozen supply
    /// is stored in Proposal.parameters.minVotingPower.
    function totalVotingPower(uint256) public pure override returns (uint256) {
        revert IncompleteCensus();
    }

    function isSupportThresholdReachedEarly(uint256) public pure override returns (bool) {
        return false; // full 14/30-day community ballots
    }

    function isSupportThresholdReached(uint256 id) public view override returns (bool) {
        Proposal storage p = proposals[id];
        if (p.tally.yes == 0) return false;
        return (1_000_000 - p.parameters.supportThreshold) * p.tally.yes
            >= p.parameters.supportThreshold * p.tally.no;
    }

    /// @inheritdoc MajorityVotingBase
    /// @dev Requires the `CREATE_PROPOSAL_PERMISSION_ID` permission.
    function createProposal(
        bytes calldata _metadata,
        Action[] calldata _actions,
        uint256 _allowFailureMap,
        uint64 _startDate,
        uint64 _endDate,
        VoteOption _voteOption,
        bool _tryEarlyExecution
    ) public override auth(CREATE_PROPOSAL_PERMISSION_ID) returns (uint256 proposalId) {
        if (_msgSender() != stagedProcessor || _allowFailureMap != 0
            || _voteOption != VoteOption.None || _tryEarlyExecution
            || _actions.length != 1 || _actions[0].to != stagedProcessor
            || _actions[0].value != 0 || _actions[0].data.length < 4)
            revert UnauthorizedParent();
        (address declaredParent, uint256 parentId, uint16 stageIndex)
            = abi.decode(_metadata, (address, uint256, uint16));
        if (declaredParent != stagedProcessor || stageIndex > 1
            || bytes4(_actions[0].data[:4])
                != bytes4(keccak256("reportProposalResult(uint256,uint16,uint8,bool)")))
            revert UnauthorizedParent();
        bool special = IParentSPP(stagedProcessor).isGuardianRemoval(parentId);
        (_startDate, _endDate) = _validateProposalDates(_startDate, _endDate);
        if (_endDate - _startDate != (special ? 30 days : 14 days))
            revert UnauthorizedParent();
        proposalId = _createProposalId(keccak256(abi.encode(_actions, _metadata)));
        Proposal storage existing_ = proposals[proposalId];
        if (existing_.parameters.snapshotTimepoint != 0)
            revert ProposalAlreadyExists(proposalId);
        uint256 totalVotingPower_ = parentSnapshotTotal[parentId];
        if (totalVotingPower_ == 0) revert IncompleteCensus();
        childToParent[proposalId] = parentId;
        priorBallots.push(proposalId);
        uint256 snapshotTimepoint = parentSnapshotMoment[parentId];

        // Store proposal related information
        Proposal storage proposal_ = proposals[proposalId];

        if (proposal_.parameters.snapshotTimepoint != 0) {
            revert ProposalAlreadyExists(proposalId);
        }

        proposal_.parameters.startDate = _startDate;
        proposal_.parameters.endDate = _endDate;
        proposal_.parameters.snapshotTimepoint = snapshotTimepoint.toUint64();
        proposal_.parameters.votingMode = VotingMode.Standard;
        proposal_.parameters.supportThreshold = special ? 750000 : 670000;
        proposal_.parameters.minVotingPower = _applyRatioCeiled(
            totalVotingPower_, special ? 330000 : 250000
        );

        proposal_.minApprovalPower = _applyRatioCeiled(totalVotingPower_, minApproval());

        proposal_.targetConfig = getTargetConfig();

        // Reduce costs
        if (_allowFailureMap != 0) {
            proposal_.allowFailureMap = _allowFailureMap;
        }

        for (uint256 i; i < _actions.length;) {
            proposal_.actions.push(_actions[i]);
            unchecked {
                ++i;
            }
        }

        if (_voteOption != VoteOption.None) {
            vote(proposalId, _voteOption, _tryEarlyExecution);
        }

        _emitProposalCreatedEvent(_metadata, _actions, _allowFailureMap, proposalId, _startDate, _endDate);
    }

    /// @inheritdoc IProposal
    function createProposal(
        bytes calldata _metadata,
        Action[] calldata _actions,
        uint64 _startDate,
        uint64 _endDate,
        bytes memory _data
    ) external override returns (uint256 proposalId) {
        // Note that this calls public function for permission check.
        uint256 allowFailureMap;
        VoteOption _voteOption = VoteOption.None;
        bool tryEarlyExecution;

        if (_data.length != 0) {
            (allowFailureMap, _voteOption, tryEarlyExecution) = abi.decode(_data, (uint256, VoteOption, bool));
        }

        proposalId =
            createProposal(_metadata, _actions, allowFailureMap, _startDate, _endDate, _voteOption, tryEarlyExecution);
    }

    /// @inheritdoc IProposal
    function customProposalParamsABI() external pure override returns (string memory) {
        return "(uint256 allowFailureMap, uint8 voteOption, bool tryEarlyExecution)";
    }

    /// @inheritdoc IMembership
    function isMember(address _account) external view returns (bool) {
        // A member must own at least one token or have at least one token delegated to her/him.
        return votingToken.getVotes(_account) > 0 || IERC20Upgradeable(address(votingToken)).balanceOf(_account) > 0;
    }

    /// @inheritdoc MajorityVotingBase
    function _vote(uint256 id, VoteOption option, address voter, bool) internal override {
        Proposal storage p = proposals[id];
        uint256 w = frozen[childToParent[id]][voter];
        if (w == 0 || p.voters[voter] != VoteOption.None) revert UnauthorizedParent();
        if (option == VoteOption.Yes) p.tally.yes += w;
        else if (option == VoteOption.No) p.tally.no += w;
        else if (option == VoteOption.Abstain) p.tally.abstain += w;
        else revert UnauthorizedParent();
        p.voters[voter] = option;
        if (voters[voter].enrolled) voters[voter].lastVote = uint64(block.timestamp);
        emit VoteCast({proposalId: id, voter: voter, voteOption: option, votingPower: w});
    }

    /// @inheritdoc MajorityVotingBase
    function _canVote(uint256 id, address voter, VoteOption option)
        internal view override returns (bool)
    {
        Proposal storage p = proposals[id];
        return _isProposalOpen(p) && option != VoteOption.None
            && p.voters[voter] == VoteOption.None
            && frozen[childToParent[id]][voter] != 0
            && !(guardianRemoved && bonusAt[childToParent[id]] && voter == guardianSafe);
    }

    /// @dev Helper function to identify the clock mode used by the given voting token.
    function _detectTokenClock() private {
        bool clockModeTimestamp;
        bool clockTimestamp;

        try IERC6372Upgradeable(address(votingToken)).CLOCK_MODE() returns (string memory clockMode) {
            clockModeTimestamp = keccak256(bytes(clockMode)) == keccak256(bytes("mode=timestamp"));
        } catch {}
        try IERC6372Upgradeable(address(votingToken)).clock() returns (uint48 timePoint) {
            clockTimestamp = (timePoint == block.timestamp);
        } catch {}

        if (clockModeTimestamp != clockTimestamp) {
            revert TokenClockMismatch();
        } else if (clockModeTimestamp) {
            tokenIndexedByTimestamp = true;
        } else {
            // Assuming that the token indexes by block number
        }
    }

    /// @dev Helper function to avoid stack too deep in non via-ir compilation mode.
    function _emitProposalCreatedEvent(
        bytes calldata _metadata,
        Action[] calldata _actions,
        uint256 _allowFailureMap,
        uint256 proposalId,
        uint64 _startDate,
        uint64 _endDate
    ) private {
        emit ProposalCreated(proposalId, _msgSender(), _startDate, _endDate, _metadata, _actions, _allowFailureMap);
    }

    /// @dev This empty reserved space is put in place to allow future versions to add new
    /// variables without shifting down storage in the inheritance chain.
    /// https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
    // This constructable plugin is not upgradeable; no storage gap.
}
