// SPDX-License-Identifier: AGPL-3.0-or-later

pragma solidity ^0.8.18;

import {DAO, IDAO, Action} from "@aragon/osx/core/dao/DAO.sol";
import {IProposal} from "@aragon/osx-commons-contracts/src/plugin/extensions/proposal/IProposal.sol";
import {MajorityVotingBase} from "../upstream/token/base/MajorityVotingBase.sol";
import {PluginUUPSUpgradeable} from "@aragon/osx/framework/plugin/setup/PluginSetupProcessor.sol";
import {IMembership} from "@aragon/osx-commons-contracts/src/plugin/extensions/membership/IMembership.sol";
import {_applyRatioCeiled} from "@aragon/osx-commons-contracts/src/utils/math/Ratio.sol";

import {IVotesUpgradeable} from "@openzeppelin/contracts-upgradeable/governance/utils/IVotesUpgradeable.sol";
import {SafeCastUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {IERC6372Upgradeable} from "@openzeppelin/contracts-upgradeable/interfaces/IERC6372Upgradeable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {WbtcCollateralRegistry} from "./WbtcCollateralRegistry_v2.sol";
import {BokkyPooBahsDateTimeLibrary as DateTime} from "../lib/BokkyPooBahsDateTimeLibrary.sol";

interface IWbtcCollateralProofVerifier {
    function verifySnapshot(bytes calldata seal, bytes calldata journal) external view returns (bool);
    function votingPlugin() external view returns (address);
    function dao() external view returns (address);
}

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

interface IWbtcDelegatedShareToken {
    function delegateBySig(address delegatee, uint256 nonce, uint256 expiry,
        uint8 v, bytes32 r, bytes32 s) external;
}

interface IWbtcParentSPP {
    struct TargetConfigResult {
        address target;
        uint8 operation;
    }
    // MUST match the original SPP Proposal field order exactly. Its dynamic
    // actions array means truncated tuple decoding is never safe.
    struct ParentProposal {
        uint128 allowFailureMap;
        uint64 lastStageTransition;
        uint16 currentStage;
        uint16 stageConfigIndex;
        bool executed;
        bool canceled;
        address creator;
        Action[] actions;
        TargetConfigResult targetConfig;
    }
    function dao() external view returns (IDAO);
    function createProposal(bytes memory, Action[] memory, uint128, uint64,
        bytes[][] memory) external returns (uint256);
    function getBodyResult(uint256, uint16, address) external view returns (uint8);
    function getBodyProposalId(uint256, uint16, address) external view returns (uint256);
    function state(uint256) external view returns (uint8);
    function getProposal(uint256) external view returns (ParentProposal memory);
}

interface IWbtcStandardProcess {
    function guardianRemoved() external view returns (bool);
    function configuredGuardianSafe() external view returns (address);
}

/// @title TokenVoting
/// @author Aragon X - 2021-2025
/// @notice The majority voting implementation using an
///         [OpenZeppelin `Votes`](https://docs.openzeppelin.com/contracts/4.x/api/governance#Votes)
///         compatible governance token.
/// @dev v1.4 (Release 1, Build 4). For each upgrade, if the reinitialization step is required,
///      increment the version numbers in the modifier for both the initialize and initializeFrom functions.
/// @custom:security-contact sirt@aragon.org
contract WbtcCollateralTokenVoting is IMembership, MajorityVotingBase, WbtcCollateralRegistry {
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

    /// @notice Emitted when an account's balance is considered as non-circulating supply. Its balance will be excluded from the token supply computation.
    /// @param accounts The addresses whose balance is considered as not circulating
    event ExcludedFromSupply(address[] accounts);

    /// @notice Thrown if the voting power is zero
    error NoVotingPower();

    /// @notice Thrown if the token reports an inconsistent clock mode and clock value
    error TokenClockMismatch();

    // ---- WBTC IPOR governance additions; original Aragon base is unmodified ----
    bytes32 public constant PROVED_COLLATERAL_JOURNAL_DOMAIN =
        keccak256("WBTC_IPOR_COLLATERAL_CENSUS_V2");
    uint256 private constant SAFE_BONUS_BPS = 1500; // 15% of activated economic power
    uint256 private constant SPAM_THRESHOLD_BPS = 3300; // strictly >33% of CAST weighted voting power

    enum ParentKind { None, Standard, GuardianRemoval }

    // Stored when the *SPP parent* is created; never refreshed when a child
    // ballot is created after the optimistic Safe stage.
    struct ParentContext {
        address proposer;
        address slashRecipient;
        uint256 escrowedShares;
        uint64 snapshotBlock;
        uint16 penaltyBps;
        ParentKind kind;
        bool merkleMode;
        bool settled;
        bool safeSpam;
        uint256 activeDirectShares;
        uint256 fullIssuedShares;
        uint256 activeWeightedShares;
        // Only a frozen Standard quorum adjustment; does NOT remove votes.
        uint256 inactiveExcludedShares;
        uint256 safeBonusShares;
        uint256 childId;
        bool guardianBonusEligibleAtCreation;
    }

    struct PendingCreation {
        address proposer;
        address processor;
        uint64 snapshotBlock;
        ParentKind kind;
        bool merkleMode;
    }

    struct ProofState {
        bytes32 root;
        bytes32 marketDigest;
        uint64 snapshotBlock;
        bool pending;
        bool verified;
        uint256 certifiedRawShares;
        uint256 activeDelegatedShares;
        uint256 certifiedWeightedCollateral;
    }

    // V2 guest must authenticate ALL active direct delegation and the complete
    // registered collateral census at the original historical snapshot.
    struct ProofJournal {
        bytes32 domain;
        uint256 chainId;
        address dao;
        address votingPlugin;
        address vaultShareToken;
        address parentProcessor;
        uint256 parentId;
        uint64 snapshotBlock;
        bytes32 marketConfigurationDigest;
        bytes32 collateralMerkleRoot;
        uint256 rawCollateralShares;
        uint256 weightedCollateralShares;
        uint256 activeDelegatedShares;
        uint256 fullIssuedShares;
        // Proved excluded Standard quorum voting weight at the SAME snapshot.
        // The guest must certify participant history; no untrusted input.
        uint256 inactiveExcludedShares;
        uint256 creatorEconomicShares;
        uint16 collateralPenaltyBps;
    }


    IWbtcCollateralProofVerifier public collateralProofVerifier;
    address public standardSPP;
    address public guardianRemovalSPP;
    address public guardianSafe;
    address public slashedDepositRecipient;
    uint256 public proposalDepositShares; // 0.001 ERC20 shares by default, in raw units
    uint256 public maxAutomaticDirectDelegates;

    // Keep the complete 16-field context internal: Solidity's autogenerated
    // public mapping getter exceeds the via-IR ABI encoder stack limit.
    // Narrow explicit views can be introduced as needed without touching the
    // original Aragon interfaces or creating an unbounded public getter.
    mapping(bytes32 => ParentContext) internal parentContexts;
    mapping(bytes32 => ProofState) public parentProofStates;
    mapping(bytes32 => bool) public parentBondsExist;
    mapping(uint256 => bytes32) public childToParent;
    mapping(uint256 => mapping(address => bool)) public spamBallot;
    mapping(uint256 => uint256) public spamWeightedVotes;
    mapping(bytes32 => mapping(address => bool)) public proofWeightRegistered;

    address[] private directDelegates;
    mapping(address => uint64) public directDelegateFirstRegisteredBlock;

    // A community ballot is counted as missed only AFTER it has finished, and
    // only if the delegate had positive frozen voting weight on that ballot.
    // No operator can revoke token delegation, voting eligibility or past votes.
    uint256[] private communityBallotHistory;
    mapping(address => uint256) public inactivityProcessedBallots;
    mapping(address => uint64) public lastCommunityVoteAt;
    mapping(address => uint64) public firstMissedBallotAt;
    mapping(address => uint32) public missedEligibleBallots;
    mapping(bytes32 => mapping(address => bool)) private inactiveCollateralAlreadyCounted;
    uint256 public maxAutomaticInactivityChecks;

    PendingCreation private pendingCreation;
    bool private _bondLock;

    error InvalidCollateralProofPath();
    error CollateralProofNotReady(uint256 proposalId);
    error CollateralProofAlreadyRegistered();
    error CollateralMerkleMembershipInvalid();
    error InvalidProposalRoute();
    error GovernanceProcessorsNotConfigured();
    error CreatorNotEligible();
    error DepositTransferFailed();
    error DepositNotFinal();
    error DepositAlreadySettled();
    error ReentrantDepositOperation();
    error InvalidVotingConfiguration();
    error InvalidVotingParticipant();
    error InactivityCheckpointRequired(address delegatee);
    error InvalidInactivityCheckLimit();

    event CollateralProofVerifierBound(address verifier);
    event CollateralProofRequested(address indexed processor, uint256 indexed parentId, bytes32 root, uint64 snapshotBlock);
    event CollateralProofVerified(address indexed processor, uint256 indexed parentId, bytes32 root, uint256 weightedShares);
    event CollateralProofMemberRegistered(address indexed processor, uint256 indexed parentId, address delegate, uint256 weightedShares);
    event ParentProposalCreated(address indexed processor, uint256 indexed parentId, address indexed proposer, uint256 depositedShares, uint64 snapshotBlock, ParentKind kind);
    event ProposalDepositSettled(address indexed processor, uint256 indexed parentId, address recipient, bool slashed, uint256 shares);
    event GovernanceProcessorsBound(address standard, address removal, address guardianSafe);
    event ProposalDepositConfigured(uint256 rawShareUnits, address slashedRecipient);
    event DirectDelegateRegistered(address indexed delegate, uint64 registeredBlock);
    event SpamExploitVoteCast(uint256 indexed childId, address indexed voter, bool spamFlag, uint256 votingPower);
    event SafeSpamExploitVeto(address indexed standardProcessor, uint256 indexed parentId);
    event DelegateCommunityActivityUpdated(address indexed delegatee, uint64 lastVoteAt, uint32 missed);
    event AutomaticInactivityLimitUpdated(uint256 maximum);

    modifier depositProtected() {
        if (_bondLock) revert ReentrantDepositOperation();
        _bondLock = true;
        _;
        _bondLock = false;
    }

    function _votingShareToken() internal view override returns (address) {
        return address(votingToken);
    }

    function _governanceDAO() internal view override returns (address) {
        return address(dao());
    }

    /// @notice A proposal is created only through this plugin; the two SPPs
    ///         must grant CREATE_PROPOSAL_PERMISSION_ID only to this address.
    function bindProposalProcessors(address standard, address removal, address safe)
        external onlyGovernanceDAO
    {
        if (standardSPP != address(0) || guardianRemovalSPP != address(0)
            || standard == address(0) || removal == address(0) || safe == address(0)
            || standard == removal || standard.code.length == 0 || removal.code.length == 0
            || address(IWbtcParentSPP(standard).dao()) != address(dao())
            || address(IWbtcParentSPP(removal).dao()) != address(dao())
            || IWbtcStandardProcess(standard).configuredGuardianSafe() != safe)
            revert GovernanceProcessorsNotConfigured();
        standardSPP = standard;
        guardianRemovalSPP = removal;
        guardianSafe = safe;
        emit GovernanceProcessorsBound(standard, removal, safe);
    }

    /// @notice DAO-only future-bond settings. Existing bonds snapshot the old
    ///         amount and slashing destination so they cannot be repriced.
    function configureProposalDeposit(uint256 rawShareAmount, address slashRecipient)
        external onlyGovernanceDAO
    {
        if (rawShareAmount == 0 || slashRecipient == address(0)) revert InvalidVotingConfiguration();
        proposalDepositShares = rawShareAmount;
        slashedDepositRecipient = slashRecipient;
        emit ProposalDepositConfigured(rawShareAmount, slashRecipient);
    }

    function setMaxAutomaticDirectDelegates(uint256 maxDelegates) external onlyGovernanceDAO {
        if (maxDelegates == 0) revert InvalidVotingConfiguration();
        maxAutomaticDirectDelegates = maxDelegates;
    }

    /// @notice Only known delegatees are included in the *automatic* active
    ///         direct-supply denominator. Registration is public but requires
    ///         demonstrable active IPOR vote delegation; no holder scans.
    function registerDirectDelegate(address delegatee) public {
        if (delegatee == address(0) || votingToken.getVotes(delegatee) == 0)
            revert InvalidVotingParticipant();
        if (directDelegateFirstRegisteredBlock[delegatee] == 0) {
            directDelegateFirstRegisteredBlock[delegatee] = uint64(block.number);
            directDelegates.push(delegatee);
            emit DirectDelegateRegistered(delegatee, uint64(block.number));
        }
    }

    /// @notice One-transaction signed vault delegation + registration. The
    ///         signature is verified by the ORIGINAL IPOR share Votes plugin.
    function activateAndRegisterDelegateBySig(
        address delegatee, uint256 nonce, uint256 expiry, uint8 v, bytes32 r, bytes32 s
    ) external {
        IWbtcDelegatedShareToken(address(votingToken)).delegateBySig(delegatee, nonce, expiry, v, r, s);
        registerDirectDelegate(delegatee);
    }

    function registeredDirectDelegateCount() external view returns (uint256) {
        return directDelegates.length;
    }

    function registeredDirectDelegateAt(uint256 index) external view returns (address) {
        return directDelegates[index];
    }

    function _directVotingPowerAt(address delegatee, uint64 snapshot, bool merkleMode)
        internal view returns (uint256)
    {
        if (excludedAccounts.contains(delegatee)) return 0;
        if (!merkleMode) {
            uint64 registeredBlock = directDelegateFirstRegisteredBlock[delegatee];
            if (registeredBlock == 0 || registeredBlock > snapshot) return 0;
        }
        return votingToken.getPastVotes(delegatee, snapshot);
    }

    /// @dev Standard active-vote totals and the inactive subtotal are
    /// computed together. Quorum exclusion NEVER alters getPastVotes or the
    /// per-voter ballot weight.
    function _activeDirectSupply(uint64 snapshot, uint64 atTime, bool checkInactivity)
        internal returns (uint256 active, uint256 inactive)
    {
        if (directDelegates.length > maxAutomaticDirectDelegates)
            revert InvalidVotingConfiguration(); // use authenticated proof path
        for (uint256 i; i < directDelegates.length; ++i) {
            address delegatee = directDelegates[i];
            uint256 power = _directVotingPowerAt(delegatee, snapshot, false);
            if (power == 0) continue;
            active += power;
            if (checkInactivity && _inactiveAtCreation(delegatee, atTime)) inactive += power;
        }
    }

    /// @dev Inactive means at least two COMPLETED, eligible community ballots
    /// missed since the delegate last voted, together with three calendar
    /// months since that last vote (or since the first missed ballot if never
    /// voted). All calculations are fixed before this parent is created.
    function _inactiveAtCreation(address delegatee, uint64 atTime)
        internal returns (bool)
    {
        _checkpointActivity(delegatee, atTime, maxAutomaticInactivityChecks, true);
        if (missedEligibleBallots[delegatee] < 2) return false;
        uint64 base = lastCommunityVoteAt[delegatee];
        if (base == 0) base = firstMissedBallotAt[delegatee];
        return base != 0 && block.timestamp >= DateTime.addMonths(base, 3);
    }

    /// @notice Permissionless amortized catch-up for inactive status. It only
    /// caches finalized community-ballot participation, never changes votes.
    /// A pending earlier ballot is left unprocessed so later completion cannot
    /// be retroactively skipped. Keepers can catch up before proposal creation.
    function checkpointDelegateActivity(address delegatee, uint256 maximum)
        external returns (uint256 next, uint32 missed)
    {
        if (maximum == 0 || maximum > 4096) revert InvalidInactivityCheckLimit();
        _checkpointActivity(delegatee, uint64(block.timestamp), maximum, false);
        return (inactivityProcessedBallots[delegatee], missedEligibleBallots[delegatee]);
    }

    function configureAutomaticInactivityChecks(uint256 maximum) external onlyGovernanceDAO {
        if (maximum == 0 || maximum > 4096) revert InvalidInactivityCheckLimit();
        maxAutomaticInactivityChecks = maximum;
        emit AutomaticInactivityLimitUpdated(maximum);
    }

    function communityBallotCount() external view returns (uint256) {
        return communityBallotHistory.length;
    }

    function _checkpointActivity(address delegatee, uint64 atTime, uint256 maximum, bool exact)
        internal
    {
        uint256 cursor = inactivityProcessedBallots[delegatee];
        uint256 processed;
        while (cursor < communityBallotHistory.length && processed < maximum) {
            uint256 ballotId = communityBallotHistory[cursor];
            Proposal storage past = proposals[ballotId];
            if (past.parameters.endDate >= atTime) break;
            // A ballot that never had its required proof cannot count as
            // missed, because eligible holders could not vote.
            bytes32 pastKey = childToParent[ballotId];
            ParentContext storage context_ = parentContexts[pastKey];
            if (!(context_.merkleMode && parentProofStates[pastKey].pending)
                && past.voters[delegatee] == VoteOption.None
                && past.parameters.endDate > lastCommunityVoteAt[delegatee]
                && _ballotPower(ballotId, delegatee) > 0)
            {
                if (missedEligibleBallots[delegatee] == 0)
                    firstMissedBallotAt[delegatee] = past.parameters.endDate;
                if (missedEligibleBallots[delegatee] < type(uint32).max)
                    ++missedEligibleBallots[delegatee];
            }
            ++cursor;
            ++processed;
        }
        inactivityProcessedBallots[delegatee] = cursor;
        // No partial evaluation is allowed to silently lower the Standard
        // denominator; a large registry can use a pre-checkpoint or proof.
        if (exact && cursor < communityBallotHistory.length
            && proposals[communityBallotHistory[cursor]].parameters.endDate < atTime)
            revert InactivityCheckpointRequired(delegatee);
        if (processed != 0)
            emit DelegateCommunityActivityUpdated(
                delegatee, lastCommunityVoteAt[delegatee], missedEligibleBallots[delegatee]
            );
    }

    /// @dev Every collateral source for one delegate contributes only once.
    /// Uses already-frozen collateral weights; no additional external market
    /// calls or changes to the collateral registry's sweep behavior.
    function _inactiveCollateralSupply(bytes32 key, uint64 atTime)
        internal returns (uint256 inactive)
    {
        for (uint256 i; i < entries.length; ++i) {
            address delegatee = entries[i].delegate;
            if (inactiveCollateralAlreadyCounted[key][delegatee]) continue;
            inactiveCollateralAlreadyCounted[key][delegatee] = true;
            uint256 weight = frozenCollateralVotingPower[uint256(key)][delegatee];
            if (weight != 0 && _inactiveAtCreation(delegatee, atTime))
                inactive += weight;
        }
    }

    function bindCollateralProofVerifier(address verifier) external onlyGovernanceDAO {
        if (address(collateralProofVerifier) != address(0) || verifier.code.length == 0
            || IWbtcCollateralProofVerifier(verifier).votingPlugin() != address(this)
            || IWbtcCollateralProofVerifier(verifier).dao() != address(dao()))
            revert InvalidCollateralProofPath();
        collateralProofVerifier = IWbtcCollateralProofVerifier(verifier);
        emit CollateralProofVerifierBound(verifier);
    }

    /// @notice User-facing parent creation; deposits and both kinds of voting
    ///         authorization are owned by this SAME weighted voting plugin.
    function initiateStandardProposal(
        bytes calldata metadata, Action[] calldata actions, uint64 startDate,
        bool merkleMode, bytes32 expectedRoot
    ) external depositProtected returns (uint256 parentId) {
        parentId = _initiate(standardSPP, ParentKind.Standard,
            metadata, actions, startDate, merkleMode, expectedRoot);
    }

    function initiateGuardianRemovalProposal(
        bytes calldata metadata, uint64 startDate, bool merkleMode, bytes32 expectedRoot
    ) external depositProtected returns (uint256 parentId) {
        Action[] memory none = new Action[](0);
        parentId = _initiate(guardianRemovalSPP, ParentKind.GuardianRemoval,
            metadata, none, startDate, merkleMode, expectedRoot);
    }

    function _initiate(address processor, ParentKind kind,
        bytes calldata metadata, Action[] memory actions, uint64 startDate,
        bool merkleMode, bytes32 expectedRoot
    ) internal returns (uint256 parentId) {
        if (processor == address(0) || kind == ParentKind.None
            || address(votingToken) == address(0) || proposalDepositShares == 0
            || pendingCreation.processor != address(0)) revert GovernanceProcessorsNotConfigured();
        // A successful removal is one-way: only the Standard process remains
        // open for NEW proposals. Existing parent snapshots are untouched.
        if (kind == ParentKind.GuardianRemoval
            && IWbtcStandardProcess(standardSPP).guardianRemoved())
            revert InvalidProposalRoute();
        if (merkleMode && address(collateralProofVerifier) == address(0))
            revert InvalidCollateralProofPath();
        if (!merkleMode && expectedRoot != bytes32(0)) revert InvalidCollateralProofPath();
        uint64 snapshotBlock = uint64(block.number - 1);
        address proposer = _msgSender();

        // Before touching external contracts, bind the only expected callback.
        pendingCreation = PendingCreation(proposer, processor, snapshotBlock, kind, merkleMode);
        uint256 startingBalance = IERC20Upgradeable(address(votingToken)).balanceOf(address(this));
        if (!IERC20Upgradeable(address(votingToken)).transferFrom(proposer, address(this), proposalDepositShares))
            revert DepositTransferFailed();
        if (IERC20Upgradeable(address(votingToken)).balanceOf(address(this)) - startingBalance != proposalDepositShares)
            revert DepositTransferFailed();

        bytes[][] memory params = new bytes[][](kind == ParentKind.Standard ? 2 : 1);
        // The only automatic child has no unrestricted user-chosen options.
        if (kind == ParentKind.Standard) params[1] = new bytes[](1);
        else params[0] = new bytes[](1);
        // Native SPP still performs ALL process and action authorization.
        parentId = IWbtcParentSPP(processor).createProposal(metadata, actions, 0, startDate, params);

        bytes32 key = _parentKey(processor, parentId);
        if (parentBondsExist[key]) revert InvalidProposalRoute();
        ParentContext storage p = parentContexts[key];
        p.proposer = proposer;
        p.slashRecipient = slashedDepositRecipient;
        p.escrowedShares = proposalDepositShares;
        p.snapshotBlock = snapshotBlock;
        p.penaltyBps = collateralPenaltyBps;
        p.kind = kind;
        p.merkleMode = merkleMode;
        p.fullIssuedShares = votingToken.getPastTotalSupply(snapshotBlock);
        p.guardianBonusEligibleAtCreation = kind == ParentKind.Standard
            && !IWbtcStandardProcess(standardSPP).guardianRemoved();
        parentBondsExist[key] = true;

        if (!merkleMode) {
            _freezeListedCollateral(uint256(key));
            if (kind == ParentKind.Standard) {
                uint256 inactiveDirect;
                (p.activeDirectShares, inactiveDirect) = _activeDirectSupply(
                    snapshotBlock, uint64(block.timestamp), true
                );
                p.inactiveExcludedShares = inactiveDirect
                    + _inactiveCollateralSupply(key, uint64(block.timestamp));
            } else {
                // Guardian removal uses the unchanged FULL-SUPPLY quorum;
                // inactive holders remain in its denominator.
                (p.activeDirectShares,) = _activeDirectSupply(snapshotBlock, 0, false);
            }
            p.activeWeightedShares = p.activeDirectShares + frozenCollateralTotal[uint256(key)];
            if (p.activeWeightedShares == 0) revert NoVotingPower();
            _requireCreatorEconomicPower(proposer, key, p);
            p.safeBonusShares = p.guardianBonusEligibleAtCreation
                ? p.activeWeightedShares * SAFE_BONUS_BPS / 10000 : 0;
            if (kind == ParentKind.Standard && p.safeBonusShares != 0
                && _inactiveAtCreation(guardianSafe, uint64(block.timestamp)))
                p.inactiveExcludedShares += p.safeBonusShares;
        } else {
            parentProofStates[key] = ProofState({
                root: expectedRoot,
                marketDigest: collateralMarketConfigurationDigest,
                snapshotBlock: snapshotBlock,
                pending: true,
                verified: false,
                certifiedRawShares: 0,
                activeDelegatedShares: 0,
                certifiedWeightedCollateral: 0
            });
            emit CollateralProofRequested(processor, parentId, expectedRoot, snapshotBlock);
        }

        // Guardian child is created synchronously by native SPP before this
        // function regains control; now finalize its immutable voting rules.
        if (p.childId != 0) _finishChildParameters(p.childId, key);
        delete pendingCreation;
        emit ParentProposalCreated(processor, parentId, proposer, p.escrowedShares, snapshotBlock, kind);
    }

    function _requireCreatorEconomicPower(address proposer, bytes32 key, ParentContext storage p)
        internal view
    {
        // Preserve the intended 10% creation floor for automatic proposals.
        uint256 economic = _directVotingPowerAt(proposer, p.snapshotBlock, false)
            + frozenCollateralVotingPower[uint256(key)][proposer];
        if (economic == 0 || economic * 10 < p.activeWeightedShares) revert CreatorNotEligible();
    }

    function _parentKey(address processor, uint256 parentId) internal pure returns (bytes32) {
        return keccak256(abi.encode(processor, parentId));
    }

    /// @notice All proof verification belongs to the weighted plugin. Proof
    ///         submission cannot change the parent's original snapshot block.
    function verifyCollateralProof(
        address processor, uint256 parentId, bytes calldata seal, bytes calldata journal
    ) external {
        bytes32 key = _parentKey(processor, parentId);
        ParentContext storage p = parentContexts[key];
        ProofState storage q = parentProofStates[key];
        if (!parentBondsExist[key] || !p.merkleMode || !q.pending || q.verified
            || address(collateralProofVerifier) == address(0)) revert InvalidCollateralProofPath();
        ProofJournal memory j = abi.decode(journal, (ProofJournal));
        if (j.domain != PROVED_COLLATERAL_JOURNAL_DOMAIN || j.chainId != block.chainid
            || j.dao != address(dao()) || j.votingPlugin != address(this)
            || j.vaultShareToken != address(votingToken) || j.parentProcessor != processor
            || j.parentId != parentId || j.snapshotBlock != p.snapshotBlock
            || j.marketConfigurationDigest != q.marketDigest
            || j.collateralPenaltyBps != p.penaltyBps
            || j.fullIssuedShares != p.fullIssuedShares
            || (q.root != bytes32(0) && j.collateralMerkleRoot != q.root)
            || j.collateralMerkleRoot == bytes32(0)
            || j.weightedCollateralShares > j.rawCollateralShares
            || (p.kind == ParentKind.GuardianRemoval && j.inactiveExcludedShares != 0)
            || (p.kind == ParentKind.Standard && j.inactiveExcludedShares
                > j.activeDelegatedShares + j.weightedCollateralShares
                    + (p.guardianBonusEligibleAtCreation
                        ? (j.activeDelegatedShares + j.weightedCollateralShares)
                            * SAFE_BONUS_BPS / 10000 : 0)))
            revert InvalidCollateralProofPath();
        if (!collateralProofVerifier.verifySnapshot(seal, journal)) revert InvalidCollateralProofPath();
        q.root = j.collateralMerkleRoot;
        q.pending = false;
        q.verified = true;
        q.certifiedRawShares = j.rawCollateralShares;
        q.activeDelegatedShares = j.activeDelegatedShares;
        q.certifiedWeightedCollateral = j.weightedCollateralShares;
        p.activeDirectShares = j.activeDelegatedShares;
        p.activeWeightedShares = j.activeDelegatedShares + j.weightedCollateralShares;
        // The trusted guest must authenticate inactivity against the exact
        // historic proposal roster and frozen votes; this field is not a
        // discretionary proposer-supplied discount.
        p.inactiveExcludedShares = j.inactiveExcludedShares;
        if (p.activeWeightedShares == 0) revert InvalidCollateralProofPath();
        if (j.creatorEconomicShares * 10 < p.activeWeightedShares)
            revert CreatorNotEligible();
        p.safeBonusShares = p.guardianBonusEligibleAtCreation
            ? p.activeWeightedShares * SAFE_BONUS_BPS / 10000 : 0;
        // Guest's inactive subtotal includes the Safe bonus only if inactive
        // at snapshot; never alter the live Safe's ballot weight.
        if (p.kind == ParentKind.Standard
            && p.inactiveExcludedShares > p.activeWeightedShares + p.safeBonusShares)
            revert InvalidCollateralProofPath();
        // Proof must certify the creator's >=10% floor in the guest. Until
        // proof verification completes, no voter can cast or settle this parent.
        if (p.childId != 0) _finishChildParameters(p.childId, key);
        emit CollateralProofVerified(processor, parentId, q.root, j.weightedCollateralShares);
    }

    function registerProvedCollateralWeight(
        address processor, uint256 parentId, address delegatee,
        uint256 rawShares, bytes32[] calldata siblings
    ) external {
        bytes32 key = _parentKey(processor, parentId);
        ProofState storage q = parentProofStates[key];
        ParentContext storage p = parentContexts[key];
        if (!parentBondsExist[key] || !q.verified || q.pending || delegatee == address(0)
            || rawShares == 0) revert CollateralProofNotReady(parentId);
        if (proofWeightRegistered[key][delegatee]) revert CollateralProofAlreadyRegistered();
        if (p.childId != 0 && block.timestamp >= proposals[p.childId].parameters.endDate)
            revert InvalidCollateralProofPath();
        if (p.childId != 0 && proposals[p.childId].voters[delegatee] != VoteOption.None)
            revert InvalidCollateralProofPath();
        bytes32 node = keccak256(abi.encode(processor, parentId, delegatee, rawShares));
        for (uint256 i; i < siblings.length; ++i) {
            bytes32 sibling = siblings[i];
            node = node < sibling ? keccak256(abi.encodePacked(node, sibling))
                : keccak256(abi.encodePacked(sibling, node));
        }
        if (node != q.root) revert CollateralMerkleMembershipInvalid();
        proofWeightRegistered[key][delegatee] = true;
        uint256 weighted = _weightedCollateral(rawShares, p.penaltyBps);
        frozenCollateralVotingPower[uint256(key)][delegatee] = weighted;
        emit CollateralProofMemberRegistered(processor, parentId, delegatee, weighted);
    }

    /// @notice Standard and Guardian child create requests are authenticated
    ///         by their exact native SPP sender and parent metadata.
    function _resolveNativeParent(bytes calldata metadata)
        internal view returns (bytes32 key, address processor, uint256 parentId)
    {
        if (metadata.length != 96) revert InvalidProposalRoute();
        uint16 stage;
        (processor, parentId, stage) = abi.decode(metadata, (address,uint256,uint16));
        if (processor != msg.sender || (processor != standardSPP && processor != guardianRemovalSPP))
            revert InvalidProposalRoute();
        IWbtcParentSPP.ParentProposal memory linked = IWbtcParentSPP(processor).getProposal(parentId);
        if (processor == standardSPP) {
            // The stage is fixed by this PARENT's version, never by the
            // mutable default process configuration.
            if (linked.stageConfigIndex == 1 && stage != 1) revert InvalidProposalRoute();
            if (linked.stageConfigIndex > 1 && stage != 0) revert InvalidProposalRoute();
            if (linked.stageConfigIndex == 0) revert InvalidProposalRoute();
        } else if (stage != 0 || linked.stageConfigIndex != 1) {
            revert InvalidProposalRoute();
        }
        key = _parentKey(processor, parentId);
        if (!parentBondsExist[key]) {
            // The Guardian child and a POST-removal Standard child both
            // begin synchronously inside the native parent creation call.
            ParentKind expectedKind = processor == standardSPP
                ? ParentKind.Standard : ParentKind.GuardianRemoval;
            if (pendingCreation.processor != processor || pendingCreation.proposer == address(0)
                || pendingCreation.kind != expectedKind || stage != 0)
                revert InvalidProposalRoute();
        }
        if (linked.creator != address(this)) revert InvalidProposalRoute();
    }

    function _finishChildParameters(uint256 childId, bytes32 key) internal {
        ParentContext storage p = parentContexts[key];
        if (p.merkleMode && parentProofStates[key].pending) return;
        Proposal storage child = proposals[childId];
        if (p.kind == ParentKind.GuardianRemoval) {
            // Guardian removal quorum is 33.33% of ALL issued shares,
            // including undelegated shares. No Safe bonus.
            child.parameters.supportThreshold = 750000;
            child.parameters.minVotingPower = _applyRatioCeiled(p.fullIssuedShares, 330000);
        } else {
            child.parameters.supportThreshold = 670000;
            // Standard quorum excludes undelegated raw vault share balances:
            // only snapshot-registered activated delegations count.
            // The Guardian's temporary 15% allocation is voting power in this
            // ballot; include it in the Standard active-power denominator.
            // Undelegated share supply remains excluded.
            // Only Standard's QUORUM DENOMINATOR excludes inactive power.
            // It does not change who can vote, their actual vote weight, or
            // Guardian-removal's full-supply denominator. Frozen once.
            uint256 activeForQuorum = p.activeWeightedShares + p.safeBonusShares;
            if (p.inactiveExcludedShares > activeForQuorum)
                revert InvalidVotingConfiguration();
            activeForQuorum -= p.inactiveExcludedShares;
            child.parameters.minVotingPower = activeForQuorum == 0
                ? 1 : _applyRatioCeiled(activeForQuorum, 250000);
        }
        child.minApprovalPower = 0;
        // No early community execution; ballots are immutable until deadline.
        child.parameters.votingMode = VotingMode.VoteReplacement;
    }

    /// @notice Spam/Exploit Attempt is an extra UI option that is counted
    ///         as a native NO vote, with separately weighted punishment signal.
    /// @dev 33% is measured by voting POWER cast rather than unique addresses;
    ///      otherwise splitting one delegated position into many wallets would
    ///      change the slashing threshold without changing economic exposure.
    function voteSpamExploit(uint256 childId, bool tryEarlyExecution) external {
        _castVoteWithSpam(childId, VoteOption.No, true, tryEarlyExecution);
    }

    function vote(uint256 proposalId, VoteOption option, bool tryEarlyExecution)
        public virtual override
    {
        _castVoteWithSpam(proposalId, option, false, tryEarlyExecution);
    }

    function _castVoteWithSpam(uint256 childId, VoteOption option, bool spam,
        bool tryEarlyExecution) internal
    {
        address voter = _msgSender();
        if (!_canVote(childId, voter, option))
            revert VoteCastForbidden({proposalId: childId, account: voter, voteOption: option});
        uint256 power = _ballotPower(childId, voter);
        if (spamBallot[childId][voter]) spamWeightedVotes[childId] -= power;
        spamBallot[childId][voter] = spam;
        if (spam) spamWeightedVotes[childId] += power;
        _vote(childId, option, voter, tryEarlyExecution);
        // A successful community vote resets inactivity for FUTURE
        // proposals only. Previously frozen quorum remains immutable.
        lastCommunityVoteAt[voter] = uint64(block.timestamp);
        missedEligibleBallots[voter] = 0;
        firstMissedBallotAt[voter] = 0;
        emit SpamExploitVoteCast(childId, voter, spam, power);
    }

    function _ballotPower(uint256 childId, address voter) internal view returns (uint256) {
        bytes32 key = childToParent[childId];
        ParentContext storage p = parentContexts[key];
        uint256 directPower = _directVotingPowerAt(voter, p.snapshotBlock, p.merkleMode);
        uint256 collateralPower = frozenCollateralVotingPower[uint256(key)][voter];
        uint256 safeBonus = p.kind == ParentKind.Standard && voter == guardianSafe
            ? p.safeBonusShares : 0;
        return directPower + collateralPower + safeBonus;
    }

    /// @notice Called only by the Standard SPP from its single manual Safe
    ///         veto stage, after recording the underlying native Veto result.
    function recordSafeSpamExploitVeto(uint256 parentId) external {
        if (msg.sender != standardSPP) revert InvalidProposalRoute();
        bytes32 key = _parentKey(standardSPP, parentId);
        ParentContext storage p = parentContexts[key];
        if (!parentBondsExist[key] || p.kind != ParentKind.Standard || p.safeSpam)
            revert InvalidProposalRoute();
        if (IWbtcParentSPP(standardSPP).getBodyResult(parentId, 0, guardianSafe) != 2)
            revert InvalidProposalRoute();
        p.safeSpam = true;
        emit SafeSpamExploitVeto(standardSPP, parentId);
    }

    /// @notice Anyone may settle a final bond, but only the original creator
    ///         receives refunds. Slashed shares go to the recipient snapshotted
    ///         AT CREATION, never to the caller of this permissionless method.
    function settleProposalDeposit(address processor, uint256 parentId) external depositProtected {
        bytes32 key = _parentKey(processor, parentId);
        ParentContext storage p = parentContexts[key];
        if (!parentBondsExist[key] || p.settled) revert DepositAlreadySettled();
        IWbtcParentSPP parent = IWbtcParentSPP(processor);
        IWbtcParentSPP.ParentProposal memory state_ = parent.getProposal(parentId);
        bool resolved;
        bool rejected;
        bool spamFlag;
        if (state_.executed || state_.canceled) {
            resolved = true;
        } else if (p.kind == ParentKind.Standard && state_.currentStage == 0
            && state_.lastStageTransition + 7 days <= block.timestamp
            && parent.getBodyResult(parentId, 0, guardianSafe) == 2) {
            resolved = true;
            rejected = true;
            spamFlag = p.safeSpam;
        } else if (p.childId != 0 && block.timestamp >= proposals[p.childId].parameters.endDate
            && !(p.merkleMode && parentProofStates[key].pending)) {
            resolved = true;
            rejected = !hasSucceeded(p.childId);
            uint256 cast = proposals[p.childId].tally.yes
                + proposals[p.childId].tally.no + proposals[p.childId].tally.abstain;
            spamFlag = cast != 0 && spamWeightedVotes[p.childId] * 10000
                > cast * SPAM_THRESHOLD_BPS;
        } else if (parent.state(parentId) == 4) { // native Expired state
            resolved = true;
        }
        if (!resolved) revert DepositNotFinal();
        bool slash = rejected && spamFlag;
        p.settled = true;
        address recipient = slash ? p.slashRecipient : p.proposer;
        if (!IERC20Upgradeable(address(votingToken)).transfer(recipient, p.escrowedShares))
            revert DepositTransferFailed();
        emit ProposalDepositSettled(processor, parentId, recipient, slash, p.escrowedShares);
    }

    /// @dev Pending proof blocks any child from being a successful SPP body.
    function hasSucceeded(uint256 proposalId) public view virtual override returns (bool) {
        bytes32 key = childToParent[proposalId];
        if (key == bytes32(0) || !parentBondsExist[key]
            || (parentContexts[key].merkleMode && parentProofStates[key].pending)) return false;
        return super.hasSucceeded(proposalId);
    }

    function _canExecute(uint256 proposalId) internal view virtual override returns (bool) {
        bytes32 key = childToParent[proposalId];
        if (key == bytes32(0) || !parentBondsExist[key]
            || (parentContexts[key].merkleMode && parentProofStates[key].pending)) return false;
        return super._canExecute(proposalId);
    }

    /// @notice Initializes the component.
    /// @dev This method is required to support [ERC-1822](https://eips.ethereum.org/EIPS/eip-1822).
    /// @param _dao The IDAO interface of the associated DAO.
    /// @param _votingSettings The voting settings.
    /// @param _token The [ERC-20](https://eips.ethereum.org/EIPS/eip-20) token to use for voting.
    ///     If the given token implements https://eips.ethereum.org/EIPS/eip-6372,
    ///     then `CLOCK_MODE()` or `clock()` will determine the clock type used by the plugin.
    ///     The token will be assumed to use a block number based clock otherwise.
    /// @param _targetConfig Configuration for the execution target, specifying the target address and operation type
    ///     (either `Call` or `DelegateCall`). Defined by `TargetConfig` in the `IPlugin` interface,
    ///     part of the `osx-commons-contracts` package, added in build 3.
    /// @param _minApprovals The minimal amount of approvals the proposal needs to succeed.
    /// @param _pluginMetadata The plugin specific information encoded in bytes.
    ///     This can also be an ipfs cid encoded in bytes.
    function initialize(
        IDAO _dao,
        VotingSettings calldata _votingSettings,
        IVotesUpgradeable _token,
        TargetConfig calldata _targetConfig,
        uint256 _minApprovals,
        bytes calldata _pluginMetadata,
        address[] memory _excludedAccounts
    ) external onlyCallAtInitialization reinitializer(3) {
        __MajorityVotingBase_init(_dao, _votingSettings, _targetConfig, _minApprovals, _pluginMetadata);
        // ERC1967/UUPS proxy storage does not inherit constructor-time
        // declaration initializers from the implementation contract.
        maxAutomaticSnapshotEntries = 128;
        maxAutomaticDirectDelegates = 128;
        maxAutomaticInactivityChecks = 64;
        collateralPenaltyBps = 5000;
        uint8 shareDecimals = IERC20Decimals(address(_token)).decimals();
        if (shareDecimals < 3 || shareDecimals > 36) revert InvalidVotingConfiguration();
        proposalDepositShares = 10 ** (shareDecimals - 3); // exactly 0.001 share
        slashedDepositRecipient = address(_dao);
        emit ProposalDepositConfigured(proposalDepositShares, address(_dao));

        votingToken = _token;

        _detectTokenClock();

        for (uint256 i; i < _excludedAccounts.length;) {
            excludedAccounts.add(_excludedAccounts[i]);

            unchecked {
                ++i;
            }
        }
        if (_excludedAccounts.length > 0) {
            emit ExcludedFromSupply(_excludedAccounts);
        }

        emit MembershipContractAnnounced({definingContract: address(_token)});
    }

    /// @notice Reinitializes the TokenVoting after an upgrade from a previous build version. For each
    ///         reinitialization step, use the `_fromBuild` version to decide which internal functions to
    ///         call for reinitialization.
    /// @dev WARNING: The contract should only be upgradeable through PSP to ensure that _fromBuild is not
    ///      incorrectly passed, and that the appropriate permissions for the upgrade are properly configured.
    /// @param _fromBuild Build version number of previous implementation contract this upgrade is transitioning from.
    /// @param _initData The initialization data to be passed to via `upgradeToAndCall`
    ///     (see [ERC-1967](https://docs.openzeppelin.com/contracts/4.x/api/proxy#ERC1967Upgrade)).
    function initializeFrom(uint16 _fromBuild, bytes calldata _initData) external reinitializer(3) {
        if (_fromBuild < 3) {
            (uint256 minApprovals, TargetConfig memory targetConfig, bytes memory pluginMetadata) =
                abi.decode(_initData, (uint256, TargetConfig, bytes));

            _updateMinApprovals(minApprovals);

            _setTargetConfig(targetConfig);

            _setMetadata(pluginMetadata);
        }
        if (_fromBuild < 4) {
            _detectTokenClock();

            // @dev The list of excluded accounts are intentionally skipped here
            //      Changing the excluded supply on the fly could break important governance invariants,
            //      therefore such feature is only allowed during the first initialization.
        }
    }

    /// @notice Checks if this or the parent contract supports an interface by its ID.
    /// @param _interfaceId The ID of the interface.
    /// @return Returns `true` if the interface is supported.
    function supportsInterface(bytes4 _interfaceId) public view virtual override returns (bool) {
        return _interfaceId == TOKEN_VOTING_INTERFACE_ID || _interfaceId == type(IMembership).interfaceId
            || super.supportsInterface(_interfaceId);
    }

    /// @notice getter function for the voting token.
    /// @dev public function also useful for registering interfaceId
    ///      and for distinguishing from majority voting interface.
    /// @return The token used for voting.
    function getVotingToken() public view returns (IVotesUpgradeable) {
        return votingToken;
    }

    /// @notice Returns the total voting power checkpointed for a specific timestamp or block number, subtracting the balance of excluded addresses.
    /// @param _timePoint The block number or timestamp.
    /// @return The effective voting power.
    function totalVotingPower(uint256 _timePoint) public view override returns (uint256) {
        uint256 _excludedSupply;
        for (uint256 i; i < excludedAccounts.length();) {
            _excludedSupply += votingToken.getPastVotes(excludedAccounts.at(i), _timePoint);

            unchecked {
                ++i;
            }
        }
        return votingToken.getPastTotalSupply(_timePoint) - _excludedSupply;
    }

    /// @inheritdoc MajorityVotingBase
    /// @dev Unparented original TokenVoting creation is intentionally disabled:
    ///      a proposal must first escrow shares and obtain its immutable
    ///      snapshot through initiateStandard/GuardianRemovalProposal.
    function createProposal(bytes calldata, Action[] calldata, uint256, uint64, uint64,
        VoteOption, bool) public pure virtual override returns (uint256)
    {
        revert InvalidProposalRoute();
    }

    /// @inheritdoc IProposal
    /// @dev Only the two installed Aragon SPP instances may construct the
    ///      community child. Both use the original five-argument IProposal ABI.
    function createProposal(
        bytes calldata metadata, Action[] calldata actions,
        uint64 startDate, uint64 endDate, bytes memory data
    ) external override auth(CREATE_PROPOSAL_PERMISSION_ID) returns (uint256 proposalId) {
        (bytes32 key, address processor, uint256 parentId) = _resolveNativeParent(metadata);
        if (data.length != 0) revert InvalidProposalRoute(); // fixed system settings
        ParentContext storage parent = parentContexts[key];
        uint64 snapshotBlock = parentBondsExist[key]
            ? parent.snapshotBlock : pendingCreation.snapshotBlock;
        (startDate, endDate) = _validateProposalDates(startDate, endDate);
        proposalId = _createProposalId(keccak256(abi.encode(actions, metadata)));
        Proposal storage proposal_ = proposals[proposalId];
        if (proposal_.parameters.snapshotTimepoint != 0) revert ProposalAlreadyExists(proposalId);
        proposal_.parameters.startDate = startDate;
        proposal_.parameters.endDate = endDate;
        proposal_.parameters.snapshotTimepoint = snapshotBlock;
        proposal_.parameters.votingMode = VotingMode.VoteReplacement;
        proposal_.parameters.supportThreshold = 670000;
        proposal_.parameters.minVotingPower = type(uint256).max; // blocked until parent snapshot ready
        proposal_.minApprovalPower = 0;
        proposal_.targetConfig = getTargetConfig();
        for (uint256 i; i < actions.length; ++i) proposal_.actions.push(actions[i]);
        childToParent[proposalId] = key;
        parent.childId = proposalId;
        communityBallotHistory.push(proposalId);
        // Guardian creation occurs DURING SPP's first-stage callback; the
        // calling initiation finalizes denominators after SPP returns.
        if (parentBondsExist[key]) _finishChildParameters(proposalId, key);
        _emitProposalCreatedEvent(metadata, actions, 0, proposalId, startDate, endDate);
    }

    /// @inheritdoc IProposal
    function customProposalParamsABI() external pure override returns (string memory) {
        return "(uint256 allowFailureMap, uint8 voteOption, bool tryEarlyExecution)";
    }

    /// @inheritdoc IMembership
    function isMember(address _account) external view returns (bool) {
        // A member must own at least one token or have at least one token delegated to her/him.
        return votingToken.getVotes(_account) > 0
            || IERC20Upgradeable(address(votingToken)).balanceOf(_account) > 0
            || registeredCollateralPositions[_account] > 0;
    }

    /// @inheritdoc MajorityVotingBase
    function _vote(uint256 proposalId, VoteOption option, address voter, bool tryEarlyExecution)
        internal override
    {
        Proposal storage proposal_ = proposals[proposalId];
        uint256 votingPower = _ballotPower(proposalId, voter);
        VoteOption previous = proposal_.voters[voter];
        if (previous == VoteOption.Yes) proposal_.tally.yes -= votingPower;
        else if (previous == VoteOption.No) proposal_.tally.no -= votingPower;
        else if (previous == VoteOption.Abstain) proposal_.tally.abstain -= votingPower;
        if (option == VoteOption.Yes) proposal_.tally.yes += votingPower;
        else if (option == VoteOption.No) proposal_.tally.no += votingPower;
        else if (option == VoteOption.Abstain) proposal_.tally.abstain += votingPower;
        proposal_.voters[voter] = option;
        emit VoteCast({proposalId: proposalId, voter: voter, voteOption: option, votingPower: votingPower});
        if (tryEarlyExecution && _canExecute(proposalId)
            && dao().hasPermission(address(this), voter, EXECUTE_PROPOSAL_PERMISSION_ID, _msgData()))
            _execute(proposalId);
    }

    function _canVote(uint256 proposalId, address voter, VoteOption option)
        internal view override returns (bool)
    {
        Proposal storage proposal_ = proposals[proposalId];
        bytes32 key = childToParent[proposalId];
        if (key == bytes32(0) || !parentBondsExist[key]
            || (parentContexts[key].merkleMode && parentProofStates[key].pending)
            || !_isProposalOpen(proposal_) || option == VoteOption.None
            || _ballotPower(proposalId, voter) == 0)
            return false;
        return proposal_.voters[voter] == VoteOption.None
            || proposal_.parameters.votingMode == VotingMode.VoteReplacement;
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
    uint256[32] private __gap;
}
