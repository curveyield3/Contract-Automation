// SPDX-License-Identifier: AGPL-3.0-or-later

pragma solidity ^0.8.8;

import {DAO, IDAO, Action} from "@aragon/osx/core/dao/DAO.sol";
import {IProposal} from "@aragon/osx-commons-contracts/src/plugin/extensions/proposal/IProposal.sol";
import {MajorityVotingBase} from "./base/MajorityVotingBase.sol";
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
interface INonceSource { function nonces(address) external view returns (uint256); }
interface IProvedSnapshot {
    function verifySnapshot(bytes calldata seal, bytes calldata journal) external view returns (bool);
    function validateMarket(uint8 kind, address market, bytes32 id) external view returns (address);
    function validateEconomicExclusion(address account) external view;
    function sourceMarketHash(bytes32 digest) external view returns (bytes32);
    function economicWeight(address account) external view returns (uint256);
    function wholeEconomicSupply() external view returns (uint256);
    function verifyVoterLeaf(bytes32 root, uint256 parentId, address voter,
        uint256 economic, uint64 activeSince, bytes32[] calldata proof) external view returns (bool);
}
interface IParentSnapshotCallback {
    function onParentSnapshotFinalized(uint256 parentId) external;
}


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
    address public immutable morphoBlue;
    address public immutable curveLendFactory;
    IProvedSnapshot public snapshotVerifier;
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
        uint16 missedVotes;
        uint64 firstMissAt;
        uint256 nextBallot;
    }
    Market[] private markets;
    address[] private registered;
    // 1-based index never changes; zero means not enrolled at the anchor.
    mapping(address => uint256) public registrationIndexPlusOne;
    mapping(uint256 => mapping(address => bool)) public verifiedWeightProved;
    uint256[] private priorBallots;
    mapping(address => Voter) private voters;
    mapping(uint256 => mapping(address => uint256)) private frozen;
    mapping(uint256 => bool) private bonusAt;
    mapping(uint256 => bool) private removalAt;
    mapping(uint256 => uint256) private parentSnapshotTotal;
    mapping(uint256 => uint256) private childToParent;
    mapping(uint256 => uint64) private parentSnapshotMoment;
    mapping(uint256 => uint256) private spamWeight;
    mapping(uint256 => bytes32) public verifiedRoot;
    mapping(uint256 => bytes32) public snapshotSourceHash;
    mapping(uint256 => bytes32) public snapshotBlockHash;
    mapping(uint256 => uint256) public snapshotBlockNumber;
    mapping(uint256 => uint256) public qualifiedElectorate;
    mapping(uint256 => uint256) public economicDenominator;
    mapping(uint256 => bool) public snapshotPending;
    mapping(uint256 => bool) public snapshotReady;
    mapping(uint256 => bool) public verifiedSnapshot;
    mapping(uint256 => uint256) public snapshotRosterSize;
    mapping(uint256 => uint256) public snapshotAnchorTimestamp;
    bytes32 public economicExclusionDigest;
    address[] private economicExclusionRoster;
    mapping(address => bool) private excludedAccountIndexed;
    mapping(address => bool) public excludedEconomicAccounts;
    struct SnapshotJournal {
        uint256 chainId;
        address dao;
        address plugin;
        uint256 parentId;
        uint256 anchorBlock;
        uint256 anchorTimestamp;
        bytes32 anchorBlockHash;
        bytes32 sourceHash;
        bytes32 rosterRoot;
        uint256 qualifiedEconomicWeight;
        uint256 wholeSupplyEconomicWeight;
        uint256 rosterSize;
        bool removal;
        bool guardianBonus;
    }
    event VerifiedSnapshotAccepted(uint256 indexed parentId, bytes32 indexed root, uint256 electorate, uint256 denominator);
    event VoterActivityCheckpointed(address indexed voter, uint256 nextBallot, uint16 missedVotes);
    event SnapshotVerifierBound(address indexed verifier);
    event EconomicAddressExcluded(address indexed account, bool excluded);

    event VoterActivated(address indexed voter, uint64 continuousSince);
    event VotingMarketAdded(address indexed market, bytes32 marketId, MarketKind kind);
    event GuardianPermanentlyRemoved();
    error IncompleteCensus();
    error UnauthorizedParent();
    error InvalidMarket();
    error UnverifiedCensus();
    error InvalidProof();
    error SnapshotPending();
    error InvalidSnapshotAnchor();

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
        address morpho_,
        address curveFactory_
    ) MajorityVotingBase(dao_) {
        if (address(shares_).code.length == 0 || spp_.code.length == 0
            || guardian_ == address(0) || morpho_.code.length == 0
            || curveFactory_.code.length == 0)
            revert NoVotingPower();
        votingToken = shares_;
        stagedProcessor = spp_;
        guardianSafe = guardian_;
        morphoBlue = morpho_;
        curveLendFactory = curveFactory_;
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

    /// @notice Permissionless bounded checkpoint for ballots that have already
    /// completed. No O(total history) work is needed on each snapshot.
    /// Checkpointing stops at the first unfinished ballot so it cannot skip a
    /// ballot that ends later than one created after it.
    function checkpointVoter(address account, uint256 maxBallots) public {
        if (maxBallots == 0 || maxBallots > 128) revert IncompleteCensus();
        Voter storage m = voters[account];
        if (!m.enrolled) revert NoVotingPower();
        uint256 cursor = m.nextBallot;
        uint256 examined;
        while (cursor < priorBallots.length && examined < maxBallots) {
            uint256 childId = priorBallots[cursor];
            Proposal storage p = proposals[childId];
            if (p.parameters.endDate > block.timestamp) break;
            uint256 parentId = childToParent[childId];
            if (verifiedSnapshot[parentId] && registrationIndexPlusOne[account] != 0
                && registrationIndexPlusOne[account] <= snapshotRosterSize[parentId]
                && !verifiedWeightProved[parentId][account])
                revert UnverifiedCensus();
            if (p.parameters.endDate > m.lastVote
                && frozen[parentId][account] != 0
                && !(account == guardianSafe && bonusAt[parentId])
                && p.voters[account] == VoteOption.None) {
                if (m.missedVotes == 0) m.firstMissAt = p.parameters.endDate;
                if (m.missedVotes < type(uint16).max) ++m.missedVotes;
            }
            ++cursor;
            ++examined;
        }
        m.nextBallot = cursor;
        emit VoterActivityCheckpointed(account, cursor, m.missedVotes);
    }

    function _activityCaughtUp(address account) private view returns (bool) {
        Voter storage m = voters[account];
        return m.nextBallot == priorBallots.length
            || proposals[priorBallots[m.nextBallot]].parameters.endDate > block.timestamp;
    }

    function _active(address account) private view returns (bool) {
        Voter storage m = voters[account];
        if (!m.enrolled || votingToken.delegates(account) != account) return false;
        if (!_activityCaughtUp(account)) revert IncompleteCensus();
        return !(_expired(m));
    }

    function _expired(Voter storage m) private view returns (bool) {
        return m.missedVotes >= missedProposalLimit && m.firstMissAt != 0
            && block.timestamp >= BokkyPooBahsDateTimeLibrary.addMonths(m.firstMissAt, inactivityMonths);
    }

    function _activate(address account) private {
        Voter storage m = voters[account];
        if (!m.enrolled) {
            m.enrolled = true;
            m.nextBallot = priorBallots.length;
            registered.push(account);
            registrationIndexPlusOne[account] = registered.length;
        }
        if (!_activityCaughtUp(account)) revert IncompleteCensus();
        if (_expired(m) || m.activeSince == 0) {
            m.activeSince = uint64(block.timestamp);
            m.lastVote = uint64(block.timestamp);
            m.missedVotes = 0;
            m.firstMissAt = 0;
            m.nextBallot = priorBallots.length;
        }
        emit VoterActivated(account, m.activeSince);
    }

    function getVoterStatus(address account) external view
        returns (uint64 activeSince, uint64 lastVote, uint16 missedVotes, uint64 firstMissAt, uint256 nextBallot)
    {
        Voter storage m = voters[account];
        return (m.activeSince, m.lastVote, m.missedVotes, m.firstMissAt, m.nextBallot);
    }

    function getRegisteredVoterCount() external view returns (uint256) { return registered.length; }
    function getMarketCount() external view returns (uint256) { return markets.length; }

    /// @notice Immutable enrollment order for an authenticated historical
    /// EVM execution. Every index, not merely witness-selected accounts, is
    /// consumed by the pinned RISC Zero guest at the proposal's anchor block.
    function getRegisteredVoterAt(uint256 index) external view returns (address) {
        return registered[index];
    }

    function getSnapshotMode(uint256 parentId) external view
        returns (bool removal, bool guardianBonus, bool verified, bool pending)
    {
        return (removalAt[parentId], bonusAt[parentId],
            verifiedSnapshot[parentId], snapshotPending[parentId]);
    }

    function getVotingMarketAt(uint256 index) external view
        returns (MarketKind kind, address market, address custody, bytes32 id, bool enabled)
    {
        Market storage m = markets[index];
        return (m.kind, m.market, m.custody, m.id, m.enabled);
    }

    function getEconomicExclusionCount() external view returns (uint256) {
        return economicExclusionRoster.length;
    }

    function getEconomicExclusionAt(uint256 index) external view returns (address) {
        return economicExclusionRoster[index];
    }

    /// @notice Deterministic authenticated-EVM census weight. Execute this
    /// at the frozen historical block: source share balances, Morpho exact
    /// collateral and LLAMMA collateral are read by the EVM, not a JSON file.
    /// A stale activity cursor reverts rather than silently recognizing a
    /// voter who may have missed completed ballots.
    function getQualifiedEconomicAt(address account, bool removal)
        external view returns (uint256 economic, uint64 activeSince, bool qualified)
    {
        Voter storage m = voters[account];
        activeSince = m.activeSince;
        if (excludedEconomicAccounts[account] ||
            (!guardianRemoved && account == guardianSafe) || !_active(account))
            return (0, activeSince, false);
        if (removal && BokkyPooBahsDateTimeLibrary.addMonths(
            activeSince, removalQualificationMonths) > block.timestamp)
            return (0, activeSince, false);
        economic = _walletAndMarkets(account);
        qualified = economic != 0;
    }

    /// @notice All minted economic vault shares, including unregistered,
    /// undelegated and inactive owners. Only explicitly governed
    /// noncirculating balances are excluded, never witness-selected voters.
    /// The removal denominator is conservative: it includes all underlying
    /// shares, even shares used as lending collateral and therefore subject
    /// to a 50% discount when attributable to an individual eligible voter.
    function getFullEconomicSupply() external view returns (uint256) {
        return snapshotVerifier.wholeEconomicSupply();
    }

    /// @notice One-time binding of the RISC Zero adapter, through the DAO
    /// after its official installation. Never replace an accepted verifier.
    function bindSnapshotVerifier(address verifier) external {
        if (msg.sender != address(dao()) || address(snapshotVerifier) != address(0)
            || verifier.code.length == 0) revert UnauthorizedParent();
        snapshotVerifier = IProvedSnapshot(verifier);
        emit SnapshotVerifierBound(verifier);
    }

    /// @notice Prospective source-census exclusions only; previous parent
    /// snapshots retain their own source hash, weights and denominators.
    function setExcludedEconomicAccount(address account, bool excluded) external {
        if (msg.sender != address(dao())
            || excludedEconomicAccounts[account] == excluded) revert UnauthorizedParent();
        snapshotVerifier.validateEconomicExclusion(account);
        if (!excludedAccountIndexed[account]) {
            economicExclusionRoster.push(account);
            excludedAccountIndexed[account] = true;
        }
        excludedEconomicAccounts[account] = excluded;
        economicExclusionDigest = keccak256(abi.encode(economicExclusionDigest, account, excluded));
        emit EconomicAddressExcluded(account, excluded);
    }

    function addVotingMarket(MarketKind kind, address market, bytes32 id) external {
        if (msg.sender != address(dao()) || markets.length >= 20) revert UnauthorizedParent();
        address custody = snapshotVerifier.validateMarket(uint8(kind), market, id);
        for (uint256 i; i < markets.length; ++i) {
            if (markets[i].market == market && markets[i].id == id) revert InvalidMarket();
        }
        markets.push(Market(kind, market, custody, id, true));
        emit VotingMarketAdded(market, id, kind);
    }

    function sourceConfigurationHash() public view returns (bytes32 digest) {
        digest = keccak256(abi.encode(block.chainid, address(dao()), address(votingToken),
            guardianSafe, morphoBlue, curveLendFactory, markets.length,
            registered.length, economicExclusionDigest, economicExclusionRoster.length));
        return snapshotVerifier.sourceMarketHash(digest);
    }

    function _walletAndMarkets(address account) private view returns (uint256) {
        return snapshotVerifier.economicWeight(account);
    }

    /// @dev For normal proposals the registered non-Safe community is 85%
    /// of scaled total eligible power; the Safe is 15%. The removal
    /// denominator, in contrast, is the authenticated FULL economic supply.
    function _freezeAtomic(uint256 id, address creator) private returns (uint256 total) {
        if (registered.length > 64) revert IncompleteCensus();
        uint256 sum;
        bool bonus = !guardianRemoved;
        uint256 creatorWeight;
        for (uint256 i; i < registered.length; ++i) {
            address account = registered[i];
            if ((guardianRemoved || account != guardianSafe)
                && !excludedEconomicAccounts[account] && _active(account)) {
                uint256 economic = _walletAndMarkets(account);
                frozen[id][account] = bonus ? economic * 85 : economic;
                if (account == creator) creatorWeight = economic;
                sum += economic;
            }
        }
        if (sum == 0 || creatorWeight < (sum + 9) / 10) revert NoVotingPower();
        qualifiedElectorate[id] = sum;
        if (bonus) {
            frozen[id][guardianSafe] = 15 * sum;
            bonusAt[id] = true;
            total = 100 * sum;
        } else total = sum;
        parentSnapshotTotal[id] = total;
        economicDenominator[id] = total;
        snapshotReady[id] = true;
        // Atomic weights were read and frozen in THIS execution block.
        // No previous-block RISC Zero commitment is implied for Atomic.
        snapshotBlockNumber[id] = block.number;
        snapshotBlockHash[id] = bytes32(0);
        snapshotAnchorTimestamp[id] = block.timestamp;
        parentSnapshotMoment[id] = uint64(tokenIndexedByTimestamp ? block.timestamp : block.number);
        snapshotSourceHash[id] = sourceConfigurationHash();
    }

    /// @notice The parent may be created while a genuine historical ZK census
    /// is pending, but it cannot activate a TokenVoting body until the proof
    /// and the proposer's membership proof have both been accepted.
    function reserveParentSnapshot(uint256 parentId, address creator, bool removal, bool verified)
        external
    {
        if (msg.sender != stagedProcessor || snapshotReady[parentId] || snapshotPending[parentId]
            || (removal && !verified) || (creator == guardianSafe && !guardianRemoved))
            revert UnauthorizedParent();
        if (!verified) {
            _freezeAtomic(parentId, creator);
            return;
        }
        if (address(snapshotVerifier) == address(0) || !voters[creator].enrolled
            || !_active(creator) || _walletAndMarkets(creator) == 0)
            revert UnverifiedCensus();
        if (removal && BokkyPooBahsDateTimeLibrary.addMonths(
                voters[creator].activeSince, removalQualificationMonths) > block.timestamp)
            revert UnverifiedCensus();
        verifiedSnapshot[parentId] = true;
        removalAt[parentId] = removal;
        bonusAt[parentId] = !guardianRemoved && !removal;
        snapshotSourceHash[parentId] = sourceConfigurationHash();
        snapshotRosterSize[parentId] = registered.length;
        snapshotAnchorTimestamp[parentId] = block.timestamp;
        snapshotBlockNumber[parentId] = block.number - 1;
        snapshotBlockHash[parentId] = blockhash(block.number - 1);
        parentSnapshotMoment[parentId] = uint64(tokenIndexedByTimestamp ? block.timestamp : block.number - 1);
        snapshotPending[parentId] = true;
    }

    /// @notice Accept only a valid pinned-image RISC Zero receipt, with a
    /// historically anchored, domain-separated complete-roster journal.
    /// Receipt authenticity is necessary but guest correctness still depends
    /// on a separately audited source-authenticating guest implementation.
    function submitVerifiedSnapshot(uint256 parentId, bytes calldata seal,
        bytes calldata journal, uint256 creatorEconomic, uint64 creatorActiveSince,
        bytes32[] calldata creatorProof) external {
        if (!snapshotPending[parentId] || snapshotReady[parentId]) revert SnapshotPending();
        SnapshotJournal memory j = abi.decode(journal, (SnapshotJournal));
        bool removal = removalAt[parentId];
        // Pinned verifier authenticates the journal against the pending parent
        // and verifies its RISC Zero Groth16 receipt before any state write.
        if (!snapshotVerifier.verifySnapshot(seal, journal)) revert InvalidProof();
        // The guest obtains this time from the proven historical header.
        // Creation's block.timestamp is merely an upper bound because EVM
        // code cannot synchronously read the previous block's timestamp.
        snapshotAnchorTimestamp[parentId] = j.anchorTimestamp;
        parentSnapshotMoment[parentId] = uint64(tokenIndexedByTimestamp
            ? j.anchorTimestamp : j.anchorBlock);
        address creator = IParentSPP(stagedProcessor).getProposalCreator(parentId);
        if (!snapshotVerifier.verifyVoterLeaf(j.rosterRoot, parentId, creator,
            creatorEconomic, creatorActiveSince, creatorProof)
            || creatorEconomic < (j.qualifiedEconomicWeight + 9) / 10
            || creatorActiveSince == 0 || creatorActiveSince > snapshotAnchorTimestamp[parentId])
            revert InvalidProof();
        if (removal && BokkyPooBahsDateTimeLibrary.addMonths(creatorActiveSince,
                removalQualificationMonths) > snapshotAnchorTimestamp[parentId]) revert InvalidProof();
        // The receipt is verified after local journal/creator constraints, so
        // an invalid receipt cannot lock in a forged total or root.
        verifiedRoot[parentId] = j.rosterRoot;
        qualifiedElectorate[parentId] = j.qualifiedEconomicWeight;
        snapshotRosterSize[parentId] = j.rosterSize;
        uint256 total = j.guardianBonus ? 100 * j.qualifiedEconomicWeight
            : j.qualifiedEconomicWeight;
        economicDenominator[parentId] = removal ? j.wholeSupplyEconomicWeight : total;
        parentSnapshotTotal[parentId] = total;
        if (j.guardianBonus) frozen[parentId][guardianSafe] = 15 * j.qualifiedEconomicWeight;
        snapshotReady[parentId] = true;
        snapshotPending[parentId] = false;
        emit VerifiedSnapshotAccepted(parentId, j.rosterRoot,
            j.qualifiedEconomicWeight, economicDenominator[parentId]);
        IParentSnapshotCallback(stagedProcessor).onParentSnapshotFinalized(parentId);
    }

    /// @notice Lazy, authenticated voter-weight materialization, with only one
    /// Merkle verification for the same historic parent/voter identity.
    function registerVerifiedWeight(uint256 parentId, uint256 economic,
        uint64 activeSince, bytes32[] calldata proof) public {
        _registerVerifiedWeightFor(parentId, _msgSender(), economic, activeSince, proof);
    }

    /// @notice Permissionless authentication for members who did not cast
    /// a vote. A keeper can settle their missed-eligible/ineligible history
    /// without possessing the member's key. Exactly one leaf per historical
    /// account is committed by the source-authenticated RISC Zero guest.
    function registerVerifiedWeightFor(uint256 parentId, address account,
        uint256 economic, uint64 activeSince, bytes32[] calldata proof) external {
        _registerVerifiedWeightFor(parentId, account, economic, activeSince, proof);
    }

    function _registerVerifiedWeightFor(uint256 parentId, address account,
        uint256 economic, uint64 activeSince, bytes32[] calldata proof) private {
        if (!snapshotReady[parentId] || !verifiedSnapshot[parentId]
            || verifiedWeightProved[parentId][account]
            || registrationIndexPlusOne[account] == 0
            || registrationIndexPlusOne[account] > snapshotRosterSize[parentId])
            revert InvalidProof();
        if (!snapshotVerifier.verifyVoterLeaf(verifiedRoot[parentId], parentId,
            account, economic, activeSince, proof)) revert InvalidProof();
        if (removalAt[parentId] && economic != 0 &&
            BokkyPooBahsDateTimeLibrary.addMonths(activeSince, removalQualificationMonths)
                > snapshotAnchorTimestamp[parentId]) revert InvalidProof();
        verifiedWeightProved[parentId][account] = true;
        if (!(bonusAt[parentId] && account == guardianSafe)) {
            frozen[parentId][account] = bonusAt[parentId] ? 85 * economic : economic;
        } else if (economic != 0) revert InvalidProof();
    }

    function voteWithVerifiedProof(uint256 childId, VoteOption option, uint256 economic,
        uint64 activeSince, bytes32[] calldata proof, bool spam) external {
        uint256 parentId = childToParent[childId];
        if (verifiedSnapshot[parentId] && frozen[parentId][msg.sender] == 0)
            registerVerifiedWeight(parentId, economic, activeSince, proof);
        vote(childId, option, false);
        if (spam) spamWeight[childId] += frozen[parentId][_msgSender()];
    }

    function getFrozenPower(uint256 parentId, address account)
        external view returns (uint256) {
        return frozen[parentId][account];
    }

    function isParentSnapshotReady(uint256 parentId) external view returns (bool) {
        return snapshotReady[parentId];
    }

    function getSnapshotAccounting(uint256 parentId) external view
        returns (uint256 qualified, uint256 votingTotal, uint256 quorumDenominator,
                 uint256 anchorBlock, bytes32 root)
    {
        return (qualifiedElectorate[parentId], parentSnapshotTotal[parentId],
            economicDenominator[parentId], snapshotBlockNumber[parentId], verifiedRoot[parentId]);
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
            || _actions[0].data.length != 4 + 4 * 32
            || bytes4(_actions[0].data[:4])
                != bytes4(keccak256("reportProposalResult(uint256,uint16,uint8,bool)")))
            revert UnauthorizedParent();
        (uint256 calledParent, uint16 calledStage, uint8 reportedType, bool tryAdvance)
            = abi.decode(_actions[0].data[4:], (uint256, uint16, uint8, bool));
        if (calledParent != parentId || calledStage != stageIndex || reportedType != 1
            || tryAdvance) revert UnauthorizedParent();
        bool special = IParentSPP(stagedProcessor).isGuardianRemoval(parentId);
        (_startDate, _endDate) = _validateProposalDates(_startDate, _endDate);
        if (_endDate - _startDate != (special ? 30 days : 14 days))
            revert UnauthorizedParent();
        proposalId = _createProposalId(keccak256(abi.encode(_actions, _metadata)));
        Proposal storage existing_ = proposals[proposalId];
        if (existing_.parameters.snapshotTimepoint != 0)
            revert ProposalAlreadyExists(proposalId);
        uint256 totalVotingPower_ = parentSnapshotTotal[parentId];
        if (!snapshotReady[parentId] || totalVotingPower_ == 0) revert IncompleteCensus();
        if (special != removalAt[parentId] && verifiedSnapshot[parentId]) revert UnauthorizedParent();
        childToParent[proposalId] = parentId;
        if (!special) priorBallots.push(proposalId);
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
            economicDenominator[parentId], special ? 330000 : 250000
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

    /// @notice TokenVoting cannot independently send arbitrary DAO actions.
    /// SPP consumes `hasSucceeded` as an external voting body instead.
    function execute(uint256) public pure override { revert UnauthorizedParent(); }

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
        if (voters[voter].enrolled) {
            Voter storage m = voters[voter];
            m.lastVote = uint64(block.timestamp);
            m.firstMissAt = 0;
            m.missedVotes = 0;
        }
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
            && !(guardianRemoved && bonusAt[childToParent[id]] && voter == guardianSafe)
            && ((bonusAt[childToParent[id]] && voter == guardianSafe)
                || _activityCaughtUp(voter));
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
