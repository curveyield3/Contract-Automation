// SPDX-License-Identifier: AGPL-3.0-or-later

pragma solidity ^0.8.8;

import {DAO, IDAO, Action} from "@aragon/osx/core/dao/DAO.sol";
import {IProposal} from "@aragon/osx-commons-contracts/src/plugin/extensions/proposal/IProposal.sol";
import {MajorityVotingBase} from "./base/MajorityVotingBase.sol";
import {BokkyPooBahsDateTimeLibrary} from "./lib/BokkyPooBahsDateTimeLibrary.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IMembership} from "@aragon/osx-commons-contracts/src/plugin/extensions/membership/IMembership.sol";
import {_applyRatioCeiled} from "@aragon/osx-commons-contracts/src/utils/math/Ratio.sol";

import {IVotesUpgradeable} from "@openzeppelin/contracts-upgradeable/governance/utils/IVotesUpgradeable.sol";
import {SafeCastUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {IERC6372Upgradeable} from "@openzeppelin/contracts-upgradeable/interfaces/IERC6372Upgradeable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IERC20MetadataUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20MetadataUpgradeable.sol";

/// @notice The sole auxiliary contract is a fixed-image RISC Zero proof verifier.
interface IWbtcIporZkProofVerifier {
    function dao() external view returns (address);
    function votingPlugin() external view returns (address);
    function guestImageId() external view returns (bytes32);
    function verifySnapshot(bytes calldata seal, bytes calldata journal) external view returns (bool);
}
interface IMorphoBlueMarket {
    function position(bytes32 id, address user)
        external view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);
    function idToMarketParams(bytes32 id)
        external view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv);
}
interface ICurveLendController {
    function collateral_token() external view returns (address);
    function amm() external view returns (address);
}
interface ICurveLendAMM {
    function coins(uint256 index) external view returns (address);
    function get_sum_xy(address user) external view returns (uint256[2] memory amounts);
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

    // Source-derived from deployed Aragon TokenVoting v1.4. Added storage
    // subsumes the old standalone registry/market-policy/guardian contracts.
    enum ProposalKind { Standard, RemoveDaoGuardian }
    enum MarketType { None, MorphoBlue, CurveLend }

    struct GovernanceConfig {
        uint32 standardQuorumPpm;
        uint32 standardSupportPpm;
        uint32 removalQuorumPpm;
        uint32 removalSupportPpm;
        uint32 proposerThresholdPpm;
        uint64 securityReviewDuration;
        uint64 standardVoteDuration;
        uint64 removalVoteDuration;
        uint256 standardBond;
    }
    struct Market {
        MarketType marketType;
        address market;
        address custody;
        bytes32 marketId;
        bool enabled;
    }
    struct Voter {
        uint64 activeSince;
        uint64 lastParticipationAt;
        bool registered;
    }
    struct Tracked {
        uint64 end;
        bool canceled;
        bool exists;
    }
    struct SnapshotJournal {
        uint256 chainId;
        address dao;
        address plugin;
        uint256 proposalId;
        uint256 anchorBlock;
        bytes32 anchorHash;
        bytes32 sourceConfigHash;
        bytes32 votingRoot;
        uint256 eligibleTotal;
        uint256 quorumDenominator;
        address proposer;
        uint256 proposerWeight;
        uint8 proposalKind;
    }

    GovernanceConfig public governanceConfig;
    address public immutable guardianSafe;
    IMorphoBlueMarket public immutable morphoBlue;
    IWbtcIporZkProofVerifier public proofVerifier;
    bool public guardianRemoved;
    uint256 private governanceEntryLock;
    uint8 public inactivityMonths = 3;
    uint8 public minimumMissedProposals = 2;
    uint8 public guardianQualificationMonths = 3;

    Market[] private trackedMarkets;
    mapping(bytes32 => bool) public marketRegistered;
    mapping(bytes4 => bool) public allowedVaultSelector;
    address[] private knownVoters;
    uint256[] private allProposals;
    mapping(address => Voter) public voterState;
    mapping(uint256 => Tracked) public tracked;
    mapping(uint256 => mapping(address => uint256)) public frozenWeight;
    mapping(uint256 => mapping(address => bool)) public cast;
    mapping(uint256 => bool) public merkleSnapshot;
    mapping(uint256 => bool) public zkSnapshotPending;
    mapping(uint256 => bytes32) public merkleRoot;
    mapping(uint256 => bytes32) public snapshotBlockHash;
    mapping(uint256 => bytes32) public sourceConfigHashAt;
    mapping(uint256 => bool) public censusFrozen;
    uint256 public sourceConfigVersion;

    mapping(uint256 => ProposalKind) public proposalKind;
    mapping(uint256 => bool) public guardianVetoed;
    mapping(uint256 => bool) public guardianApprovedEarly;
    mapping(uint256 => address) public proposer;
    mapping(uint256 => uint256) public bondAmount;
    mapping(uint256 => bool) public bondSettled;
    mapping(uint256 => uint256) public spamFlaggedPower;
    mapping(uint256 => uint256) public frozenEligiblePower;
    mapping(uint256 => uint256) public frozenQuorumDenominator;
    mapping(uint256 => uint64) public proofDeadline;
    mapping(uint256 => bytes) private pendingMetadata;
    mapping(uint256 => uint64) private proposalDuration;
    mapping(uint256 => uint64) private proposalReviewDuration;
    mapping(uint256 => uint32) private proposalQuorumPpm;
    mapping(uint256 => uint32) private proposerThresholdPpmAt;
    uint256 private proposalSerial;

    event GuardianReview(uint256 indexed proposalId, bool approved);
    event ProposalBondSettled(uint256 indexed proposalId, bool forfeited, uint256 amount);
    event GovernanceConfigurationUpdated();
    event FrozenGovernanceSnapshot(uint256 indexed proposalId, ProposalKind kind, uint256 eligible, uint256 denominator);
    event VerifiedMerkleSnapshot(uint256 indexed proposalId, bytes32 root, uint256 eligible, uint256 denominator);
    event MarketChanged(uint256 indexed index, MarketType kind, address market, bool enabled);
    event VoterActivated(address indexed voter, uint64 since);
    event GuardianPermanentlyRemoved();
    event ProofVerifierBound(address verifier);

    error NoVotingPower();
    error InvalidGovernanceProposal();
    error GuardianAlreadyRemoved();
    error InvalidGovernanceAction();
    error OnlyGuardianOrDAO();
    error ProposalBondNotReady();
    error ProposalAlreadySettled();
    error IncompleteEconomicCensus();
    error ProofNotReady();

    modifier singleGovernanceEntry() {
        if (governanceEntryLock != 0) revert InvalidGovernanceProposal();
        governanceEntryLock = 1;
        _;
        governanceEntryLock = 0;
    }
    modifier onlyDaoExecution() {
        if (msg.sender != address(dao())) revert OnlyGuardianOrDAO();
        _;
    }

    /// @notice Emitted when an account's balance is considered as non-circulating supply. Its balance will be excluded from the token supply computation.
    /// @param accounts The addresses whose balance is considered as not circulating
    event ExcludedFromSupply(address[] accounts);

    /// @notice Thrown if the voting power is zero
    /// @notice Thrown if the token reports an inconsistent clock mode and clock value
    error TokenClockMismatch();

    /// @notice Directly deployed, non-upgradeable Aragon plugin (no UUPS proxy).
    /// Deploy after DAOFactory.createDao(settings, []). The creator's temporary
    /// EXECUTE permission is relinquished after granting EXECUTE to this plugin.
    constructor(
        IDAO boundDao,
        IVotesUpgradeable vaultShareToken,
        address guardian,
        address morphoBlueSingleton
    ) MajorityVotingBase(boundDao) {
        if (address(boundDao).code.length == 0 || address(vaultShareToken).code.length == 0
            || guardian == address(0) || morphoBlueSingleton.code.length == 0)
            revert InvalidGovernanceProposal();
        guardianSafe = guardian;
        morphoBlue = IMorphoBlueMarket(morphoBlueSingleton);
        votingToken = vaultShareToken;
        _detectTokenClock();
        uint8 d = IERC20MetadataUpgradeable(address(vaultShareToken)).decimals();
        if (d < 3 || d > 36) revert InvalidGovernanceProposal();
        governanceConfig = GovernanceConfig({
            standardQuorumPpm: 250000,
            standardSupportPpm: 670000,
            removalQuorumPpm: 330000,
            removalSupportPpm: 750000,
            proposerThresholdPpm: 100000,
            securityReviewDuration: 7 days,
            standardVoteDuration: 14 days,
            removalVoteDuration: 30 days,
            standardBond: 10 ** uint256(d - 3)
        });
        emit MembershipContractAnnounced({definingContract: address(vaultShareToken)});
    }

    /// @notice Bind the only custom verification contract once, after it is
    /// deployed with this plugin's address and a nonzero pinned guest image.
    function bindProofVerifier(IWbtcIporZkProofVerifier verifier) external onlyDaoExecution {
        if (address(proofVerifier) != address(0) || address(verifier).code.length == 0)
            revert InvalidGovernanceProposal();
        if (verifier.dao() != address(dao()) || verifier.votingPlugin() != address(this)
            || verifier.guestImageId() == bytes32(0)) revert InvalidGovernanceProposal();
        proofVerifier = verifier;
        emit ProofVerifierBound(address(verifier));
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
        // Preview is informational. Proposal quorum uses freezeAtomic's
        // immutable, kind-specific denominator instead of token total supply.
        if (_timePoint != block.number) revert InvalidGovernanceProposal();
        uint256 activeShares;
        for (uint256 i; i < knownVoters.length;) {
            address v = knownVoters[i];
            if (_active(v) && (v != guardianSafe || guardianRemoved)) {
                activeShares += _rawVotingPower(v);
            }
            unchecked { ++i; }
        }
        return guardianRemoved ? activeShares : 100 * activeShares;
    }

    /// @inheritdoc MajorityVotingBase
    /// @dev Requires the `CREATE_PROPOSAL_PERMISSION_ID` permission.
    /// @notice Standard proposals retain Aragon's base ABI and its permission.
    function createProposal(
        bytes calldata _metadata,
        Action[] calldata _actions,
        uint256 _allowFailureMap,
        uint64 _startDate,
        uint64 _endDate,
        VoteOption _voteOption,
        bool _tryEarlyExecution
    ) public override auth(CREATE_PROPOSAL_PERMISSION_ID) singleGovernanceEntry returns (uint256 proposalId) {
        // The required security window and vote period are non-bypassable.
        if (
            _allowFailureMap != 0 || _startDate != 0 || _endDate != 0
                || _voteOption != VoteOption.None || _tryEarlyExecution
        ) revert InvalidGovernanceProposal();

        Action[] memory actions_ = _actions;
        _checkStandardActions(actions_);
        proposalId = _createWeightedProposal(ProposalKind.Standard, _metadata, actions_, _msgSender());
    }

    /// @notice The only allowed guardian-removal call is constructed by code.
    /// No caller-controlled action array is accepted for this proposal type.
    function createGuardianRemovalProposal(bytes calldata _metadata)
        external auth(CREATE_PROPOSAL_PERMISSION_ID) singleGovernanceEntry returns (uint256 proposalId)
    {
        if (guardianRemoved) revert GuardianAlreadyRemoved();
        Action[] memory actions_ = new Action[](1);
        actions_[0] = Action({
            to: address(this),
            value: 0,
            data: abi.encodeWithSelector(this.permanentlyRemoveDaoGuardian.selector)
        });
        proposalId = _createPendingMerkle(ProposalKind.RemoveDaoGuardian, _metadata, actions_, _msgSender());
    }

    /// @notice Optional authenticated Merkle snapshot; default remains atomic.
    function createMerkleStandardProposal(bytes calldata metadata, Action[] calldata actions)
        external auth(CREATE_PROPOSAL_PERMISSION_ID) singleGovernanceEntry returns (uint256 id)
    {
        Action[] memory a = actions;
        _checkStandardActions(a);
        id = _createPendingMerkle(ProposalKind.Standard, metadata, a, _msgSender());
    }

    /// @dev Guardian removal uses only this complete, proven economic census.
    function _createPendingMerkle(ProposalKind kind, bytes memory metadata, Action[] memory a, address creator)
        private returns (uint256 id)
    {
        if (address(proofVerifier) == address(0)) revert ProofNotReady();
        if (kind == ProposalKind.RemoveDaoGuardian && guardianRemoved) revert GuardianAlreadyRemoved();
        id = _createProposalId(keccak256(abi.encode(kind, a, metadata, ++proposalSerial)));
        Proposal storage p = proposals[id];
        if (p.parameters.snapshotTimepoint != 0) revert ProposalAlreadyExists(id);
        uint256 anchorBlock = block.number - 1;
        bytes32 anchorHash = blockhash(anchorBlock);
        if (anchorHash == bytes32(0)) revert InvalidGovernanceProposal();
        p.parameters.snapshotTimepoint = anchorBlock.toUint64();
        p.parameters.votingMode = VotingMode.Standard;
        p.parameters.supportThreshold = kind == ProposalKind.Standard
            ? governanceConfig.standardSupportPpm : governanceConfig.removalSupportPpm;
        p.targetConfig = getTargetConfig();
        for (uint256 i; i < a.length;) { p.actions.push(a[i]); unchecked { ++i; } }
        proposer[id] = creator;
        proposalKind[id] = kind;
        pendingMetadata[id] = metadata;
        sourceConfigHashAt[id] = _configurationDigest();
        snapshotBlockHash[id] = anchorHash;
        proposalDuration[id] = kind == ProposalKind.Standard
            ? governanceConfig.standardVoteDuration : governanceConfig.removalVoteDuration;
        proposalReviewDuration[id] = kind == ProposalKind.Standard && !guardianRemoved
            ? governanceConfig.securityReviewDuration : 0;
        proposalQuorumPpm[id] = kind == ProposalKind.Standard
            ? governanceConfig.standardQuorumPpm : governanceConfig.removalQuorumPpm;
        proposerThresholdPpmAt[id] = governanceConfig.proposerThresholdPpm;
        proofDeadline[id] = uint64(block.timestamp) + 7 days;
        zkSnapshotPending[id] = true;
        uint256 bond = governanceConfig.standardBond * (kind == ProposalKind.Standard ? 1 : 5);
        bondAmount[id] = bond;
        if (!IERC20Upgradeable(address(votingToken)).transferFrom(creator, address(this), bond))
            revert InvalidGovernanceProposal();
    }

    function submitVerifiedMerkleSnapshot(
        uint256 id, bytes calldata journal, bytes calldata seal, bytes32[] calldata proposerProof
    ) external singleGovernanceEntry {
        if (!zkSnapshotPending[id] || block.timestamp >= proofDeadline[id]
            || address(proofVerifier) == address(0)) revert ProofNotReady();
        SnapshotJournal memory v = abi.decode(journal, (SnapshotJournal));
        if (v.chainId != block.chainid || v.dao != address(dao()) || v.plugin != address(this)
            || v.proposalId != id || v.anchorBlock != proposals[id].parameters.snapshotTimepoint
            || v.anchorHash != snapshotBlockHash[id] || v.sourceConfigHash != sourceConfigHashAt[id]
            || v.proposalKind != uint8(proposalKind[id]) || v.proposer != proposer[id]
            || v.votingRoot == bytes32(0) || v.eligibleTotal == 0 || v.quorumDenominator == 0
            || v.proposerWeight == 0 || v.proposerWeight > v.eligibleTotal
            || v.proposerWeight * 1000000 < v.eligibleTotal * proposerThresholdPpmAt[id])
            revert InvalidGovernanceProposal();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(id, proposer[id], v.proposerWeight))));
        if (!MerkleProof.verify(proposerProof, v.votingRoot, leaf)) revert InvalidGovernanceProposal();
        if (!proofVerifier.verifySnapshot(seal, journal)) revert InvalidGovernanceProposal();
        zkSnapshotPending[id] = false;
        merkleSnapshot[id] = true;
        merkleRoot[id] = v.votingRoot;
        censusFrozen[id] = true;
        frozenEligiblePower[id] = v.eligibleTotal;
        frozenQuorumDenominator[id] = v.quorumDenominator;
        Proposal storage p = proposals[id];
        uint64 start = uint64(block.timestamp) + proposalReviewDuration[id];
        uint64 end = start + proposalDuration[id];
        p.parameters.startDate = start;
        p.parameters.endDate = end;
        p.parameters.minVotingPower = _applyRatioCeiled(v.quorumDenominator, proposalQuorumPpm[id]);
        p.minApprovalPower = 0;
        _registerTracked(id, end);
        emit VerifiedMerkleSnapshot(id, v.votingRoot, v.eligibleTotal, v.quorumDenominator);
        Action[] memory actions = p.actions;
        _emitProposalCreatedEvent(pendingMetadata[id], actions, 0, id, start, end);
        delete pendingMetadata[id];
    }

    /// @notice Membership is accepted only against the proven root.
    function voteWithMerkleProof(
        uint256 id, VoteOption choice, uint256 weight, bool spam, bytes32[] calldata proof
    ) external singleGovernanceEntry {
        address voter = _msgSender();
        Proposal storage p = proposals[id];
        if (!merkleSnapshot[id] || zkSnapshotPending[id] || guardianVetoed[id]
            || !_isProposalOpen(p) || choice == VoteOption.None || cast[id][voter] || weight == 0
            || (guardianRemoved && voter == guardianSafe && proposalKind[id] == ProposalKind.Standard
                && !voterState[voter].registered))
            revert VoteCastForbidden(id, voter, choice);
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(id, voter, weight))));
        if (!MerkleProof.verify(proof, merkleRoot[id], leaf)) revert InvalidGovernanceProposal();
        _castWeightedVote(id, choice, voter, weight);
        if (spam) spamFlaggedPower[id] += weight;
    }

    /// @notice The original proposer can reclaim its bond after proof timeout.
    function expireUnprovenProposal(uint256 id) external singleGovernanceEntry {
        if (!zkSnapshotPending[id] || block.timestamp < proofDeadline[id] || bondSettled[id])
            revert ProposalBondNotReady();
        zkSnapshotPending[id] = false;
        bondSettled[id] = true;
        if (!IERC20Upgradeable(address(votingToken)).transfer(proposer[id], bondAmount[id]))
            revert InvalidGovernanceProposal();
        emit ProposalBondSettled(id, false, bondAmount[id]);
    }

    function _configurationDigest() private view returns (bytes32) {
        return keccak256(abi.encode(
            block.chainid, address(dao()), address(votingToken), address(morphoBlue),
            guardianSafe, guardianRemoved, sourceConfigVersion,
            inactivityMonths, minimumMissedProposals, guardianQualificationMonths
        ));
    }

    function _createWeightedProposal(
        ProposalKind kind, bytes memory metadata, Action[] memory actions_, address creator
    ) private returns (uint256 id) {
        bool removed = guardianRemoved;
        uint64 now_ = uint64(block.timestamp);
        uint64 voteStart = now_;
        uint64 voteDuration = kind == ProposalKind.Standard
            ? governanceConfig.standardVoteDuration : governanceConfig.removalVoteDuration;
        if (kind == ProposalKind.Standard && !removed) {
            voteStart += governanceConfig.securityReviewDuration;
        }
        uint64 voteEnd = voteStart + voteDuration;

        // The voting source MUST freeze the complete census from a single
        // state. No current market balances may be re-read when votes arrive.
        id = _createProposalId(keccak256(abi.encode(kind, actions_, metadata, ++proposalSerial)));
        Proposal storage proposal_ = proposals[id];
        if (proposal_.parameters.snapshotTimepoint != 0) revert ProposalAlreadyExists(id);
        if (kind == ProposalKind.RemoveDaoGuardian) revert IncompleteEconomicCensus();
        (
            uint256 eligiblePower,
            uint256 denominator,
            uint256 creatorPower
        ) = _freezeAtomic(id, creator, removed);

        if (denominator == 0 || eligiblePower == 0 || creatorPower * 1000000 <
            eligiblePower * governanceConfig.proposerThresholdPpm) revert NoVotingPower();
        // A guardian-removal quorum denominator includes inactive/undelegated
        // whole-supply economic weight. This total must be source-proven.
        proposalKind[id] = kind;
        proposer[id] = creator;
        frozenEligiblePower[id] = eligiblePower;
        frozenQuorumDenominator[id] = denominator;
        proposal_.parameters.startDate = voteStart;
        proposal_.parameters.endDate = voteEnd;
        proposal_.parameters.snapshotTimepoint = uint256(block.number).toUint64();
        proposal_.parameters.votingMode = VotingMode.Standard;
        proposal_.parameters.supportThreshold = kind == ProposalKind.Standard
            ? governanceConfig.standardSupportPpm : governanceConfig.removalSupportPpm;
        proposal_.parameters.minVotingPower = _applyRatioCeiled(
            denominator, kind == ProposalKind.Standard
                ? governanceConfig.standardQuorumPpm : governanceConfig.removalQuorumPpm
        );
        proposal_.minApprovalPower = 0;
        proposal_.targetConfig = getTargetConfig();
        for (uint256 i; i < actions_.length;) {
            proposal_.actions.push(actions_[i]);
            unchecked { ++i; }
        }
        uint256 bond = governanceConfig.standardBond * (kind == ProposalKind.Standard ? 1 : 5);
        bondAmount[id] = bond;
        if (!IERC20Upgradeable(address(votingToken)).transferFrom(creator, address(this), bond)) {
            revert InvalidGovernanceProposal();
        }
        _registerTracked(id, voteEnd);
        emit FrozenGovernanceSnapshot(id, kind, eligiblePower, denominator);
        _emitProposalCreatedEvent(metadata, actions_, 0, id, voteStart, voteEnd);
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
        return _active(_account) || (_account == guardianSafe && !guardianRemoved);
    }

    /// @notice Single transaction: EIP712 self delegation and registry activation.
    /// The vault's native delegateBySig authenticates the exact account.
    function activateVotingPower(
        uint256 nonce, uint256 expiry, uint8 v, bytes32 r, bytes32 s
    ) external singleGovernanceEntry {
        address voter = _msgSender();
        votingToken.delegateBySig(voter, nonce, expiry, v, r, s);
        if (votingToken.delegates(voter) != voter) revert InvalidGovernanceProposal();
        _activate(voter);
    }

    /// @notice Already self-delegated accounts can activate without a new signature.
    function activateVotingPower() external singleGovernanceEntry {
        address voter = _msgSender();
        if (votingToken.delegates(voter) != voter) revert InvalidGovernanceProposal();
        _activate(voter);
    }

    /// @notice Guardian's stage-one veto/approval never contributes a voting tally.
    function reviewStandardProposal(uint256 id, bool approve) external singleGovernanceEntry {
        if (_msgSender() != guardianSafe || guardianRemoved) {
            revert OnlyGuardianOrDAO();
        }
        if (proposalKind[id] != ProposalKind.Standard || proposer[id] == address(0)
            || guardianVetoed[id] || guardianApprovedEarly[id]) revert InvalidGovernanceProposal();
        Proposal storage p = proposals[id];
        if (block.timestamp >= p.parameters.startDate) revert InvalidGovernanceProposal();

        if (approve) {
            guardianApprovedEarly[id] = true;
            p.parameters.startDate = uint64(block.timestamp);
            p.parameters.endDate = uint64(block.timestamp) + governanceConfig.standardVoteDuration;
            tracked[id].end = p.parameters.endDate;
        } else {
            guardianVetoed[id] = true;
            tracked[id].canceled = true;
        }
        emit GuardianReview(id, approve);
    }

    /// @notice Optional spam classification on the same irreversible ballot.
    function voteWithSpamFlag(uint256 id, VoteOption choice, bool markSpam) external {
        if (!markSpam) revert InvalidGovernanceProposal();
        vote(id, choice, false); // uses Aragon's existing permission/eligibility path
        spamFlaggedPower[id] += frozenWeight[id][_msgSender()];
    }

    /// @notice Governance settings changes must be executed by the DAO itself.
    function updateGovernanceConfiguration(GovernanceConfig calldata next) external onlyDaoExecution {
        require(next.standardQuorumPpm <= 1000000 && next.removalQuorumPpm <= 1000000, "QUORUM");
        require(next.standardSupportPpm >= 500000 && next.standardSupportPpm <= 1000000, "SUPPORT");
        require(next.removalSupportPpm >= 500000 && next.removalSupportPpm <= 1000000, "SUPPORT");
        require(next.proposerThresholdPpm > 0 && next.proposerThresholdPpm <= 1000000, "PROPOSER");
        require(next.securityReviewDuration >= 1 days && next.securityReviewDuration <= 30 days, "REVIEW");
        require(next.standardVoteDuration >= 1 days && next.standardVoteDuration <= 365 days, "DURATION");
        require(next.removalVoteDuration >= 1 days && next.removalVoteDuration <= 365 days, "DURATION");
        require(next.standardBond > 0, "BOND");
        governanceConfig = next;
        emit GovernanceConfigurationUpdated();
    }

    /// @notice Refund on ordinary completion; forfeit only majority-classified
    /// spam when the proposal's frozen quorum has been reached.
    function settleProposalBond(uint256 id) external singleGovernanceEntry {
        if (proposer[id] == address(0)) revert InvalidGovernanceProposal();
        if (bondSettled[id] || zkSnapshotPending[id]) revert ProposalAlreadySettled();
        Proposal storage p = proposals[id];
        if (!guardianVetoed[id] && block.timestamp < p.parameters.endDate) revert ProposalBondNotReady();

        uint256 participating = p.tally.yes + p.tally.no + p.tally.abstain;
        bool forfeited = !guardianVetoed[id] && participating >= p.parameters.minVotingPower
            && spamFlaggedPower[id] * 2 > participating;
        uint256 amount = bondAmount[id];
        bondSettled[id] = true;
        address recipient = forfeited ? address(dao()) : proposer[id];
        if (!IERC20Upgradeable(address(votingToken)).transfer(recipient, amount)) {
            revert InvalidGovernanceProposal();
        }
        emit ProposalBondSettled(id, forfeited, amount);
    }

    /// @notice Supports exact >= threshold ratios, rather than the original
    /// Aragon strictly-greater-than behavior.
    function isSupportThresholdReached(uint256 id) public view override returns (bool) {
        Tally storage votes = proposals[id].tally;
        uint256 y = votes.yes;
        uint256 n = votes.no;
        if (y + n == 0) return false;
        return y * 1000000 >= (y + n) * proposals[id].parameters.supportThreshold;
    }

    function isSupportThresholdReachedEarly(uint256) public pure override returns (bool) {
        return false; // no early execution for either proposal category
    }

    function _canExecute(uint256 id) internal view override returns (bool) {
        if (proposer[id] == address(0) || zkSnapshotPending[id] || !censusFrozen[id]) return false;
        if (proposalKind[id] == ProposalKind.Standard) {
            if (guardianVetoed[id]) return false;
        } else {
            // No duplicate irreversible removal execution after a prior removal.
            if (guardianRemoved) return false;
            if (!_isExactRemovalAction(id)) return false;
        }
        if (block.timestamp < proposals[id].parameters.endDate) return false;
        return super._canExecute(id);
    }

    function _execute(uint256 id) internal override {
        if (proposalKind[id] == ProposalKind.RemoveDaoGuardian) {
            if (!_isExactRemovalAction(id)) revert InvalidGovernanceAction();
        } else {
            _checkStandardStorageActions(id);
        }
        super._execute(id);
        if (proposalKind[id] == ProposalKind.RemoveDaoGuardian && !guardianRemoved)
            revert InvalidGovernanceAction();
    }

    /// @notice Irreversible DAO-executed one-way transition. Only a successful
    /// 30-day, 75%-approval, 33%-quorum guardian-removal ballot may reach this.
    function permanentlyRemoveDaoGuardian() external onlyDaoExecution {
        if (guardianRemoved) revert GuardianAlreadyRemoved();
        guardianRemoved = true;
        emit GuardianPermanentlyRemoved();
    }

    function _isExactRemovalAction(uint256 id) private view returns (bool) {
        Proposal storage p = proposals[id];
        return p.actions.length == 1 && p.allowFailureMap == 0
            && p.actions[0].to == address(this) && p.actions[0].value == 0
            && keccak256(p.actions[0].data)
                == keccak256(abi.encodeWithSelector(this.permanentlyRemoveDaoGuardian.selector));
    }

    function _allowedAction(address target, uint256 value, bytes memory data) private view returns (bool) {
        if (value != 0 || data.length < 4 || target == address(dao())) return false;
        bytes4 selector;
        assembly { selector := mload(add(data, 32)) }
        if (target == address(this)) {
            return selector == this.updateGovernanceConfiguration.selector
                || selector == this.configureVoterActivity.selector
                || selector == this.addVotingMarket.selector
                || selector == this.setMarketEnabled.selector
                || selector == this.setVaultSelectorAllowed.selector;
        }
        return target == address(votingToken) && allowedVaultSelector[selector];
    }

    function _checkStandardActions(Action[] memory a) private view {
        for (uint256 i; i < a.length;) {
            if (!_allowedAction(a[i].to, a[i].value, a[i].data)) revert InvalidGovernanceAction();
            unchecked { ++i; }
        }
    }

    function _checkStandardStorageActions(uint256 id) private view {
        Proposal storage p = proposals[id];
        if (p.allowFailureMap != 0) revert InvalidGovernanceAction();
        for (uint256 i; i < p.actions.length;) {
            Action storage a = p.actions[i];
            if (!_allowedAction(a.to, a.value, a.data)) revert InvalidGovernanceAction();
            unchecked { ++i; }
        }
    }

    function setVaultSelectorAllowed(bytes4 selector, bool allowed) external onlyDaoExecution {
        // No generic execute/upgrade/role/permission function may be whitelisted.
        if (selector == bytes4(0)
            || selector == bytes4(keccak256("upgradeTo(address)"))
            || selector == bytes4(keccak256("upgradeToAndCall(address,bytes)"))
            || selector == bytes4(keccak256("execute(address,bytes)"))
            || selector == bytes4(keccak256("grantRole(bytes32,address)"))
            || selector == bytes4(keccak256("revokeRole(bytes32,address)")))
            revert InvalidGovernanceAction();
        allowedVaultSelector[selector] = allowed;
    }

    /// @inheritdoc MajorityVotingBase
    function _vote(uint256 id, VoteOption option, address voter, bool) internal override {
        uint256 weight = frozenWeight[id][voter];
        if (merkleSnapshot[id] || weight == 0) revert InvalidGovernanceProposal();
        _castWeightedVote(id, option, voter, weight);
    }

    function _castWeightedVote(uint256 id, VoteOption option, address voter, uint256 weight) internal {
        Proposal storage p = proposals[id];
        if (option == VoteOption.Yes) p.tally.yes += weight;
        else if (option == VoteOption.No) p.tally.no += weight;
        else if (option == VoteOption.Abstain) p.tally.abstain += weight;
        else revert InvalidGovernanceProposal();
        p.voters[voter] = option;
        _recordVote(id, voter);
        emit VoteCast({proposalId: id, voter: voter, voteOption: option, votingPower: weight});
    }

    /// @inheritdoc MajorityVotingBase
    function _canVote(uint256 _proposalId, address _account, VoteOption _voteOption)
        internal view override returns (bool)
    {
        Proposal storage p = proposals[_proposalId];
        return proposer[_proposalId] != address(0) && !guardianVetoed[_proposalId]
            && _isProposalOpen(p) && _voteOption != VoteOption.None
            && p.voters[_account] == VoteOption.None
            && frozenWeight[_proposalId][_account] != 0 && !merkleSnapshot[_proposalId];
    }

    // Source-weight calculations are adapted from the original 1Hive /
    // AragonOne VotingAggregator._aggregateAt; the source is the existing
    // WBTC IPOR vault-share token, not another ERC-20 governance token.
    function getMarketCount() external view returns (uint256) { return trackedMarkets.length; }
    function getMarket(uint256 index) external view returns (Market memory) { return trackedMarkets[index]; }
    function getVoterCount() external view returns (uint256) { return knownVoters.length; }
    function getVoter(uint256 index) external view returns (address) { return knownVoters[index]; }

    /// @notice Add a genuinely source-matching market through an Aragon
    /// standard proposal. All such positions receive exactly 50% weight.
    function addVotingMarket(MarketType kind, address market, bytes32 marketId)
        external onlyDaoExecution
    {
        if (trackedMarkets.length >= 20 || market.code.length == 0)
            revert InvalidGovernanceAction();
        address custody;
        if (kind == MarketType.MorphoBlue) {
            if (market != address(morphoBlue) || marketId == bytes32(0))
                revert InvalidGovernanceAction();
            (address loanToken, address collateralToken,,,) = morphoBlue.idToMarketParams(marketId);
            if (loanToken == address(0) || collateralToken != address(votingToken))
                revert InvalidGovernanceAction();
            custody = market;
        } else if (kind == MarketType.CurveLend) {
            if (marketId != bytes32(0)) revert InvalidGovernanceAction();
            ICurveLendController c = ICurveLendController(market);
            if (c.collateral_token() != address(votingToken)) revert InvalidGovernanceAction();
            custody = c.amm();
            if (custody.code.length == 0 || ICurveLendAMM(custody).coins(1) != address(votingToken))
                revert InvalidGovernanceAction();
        } else revert InvalidGovernanceAction();
        bytes32 key = keccak256(abi.encode(kind, market, marketId));
        if (marketRegistered[key]) revert InvalidGovernanceAction();
        marketRegistered[key] = true;
        trackedMarkets.push(Market(kind, market, custody, marketId, true));
        ++sourceConfigVersion;
        emit MarketChanged(trackedMarkets.length - 1, kind, market, true);
    }

    function setMarketEnabled(uint256 index, bool enable) external onlyDaoExecution {
        Market storage m = trackedMarkets[index];
        if (m.enabled == enable) revert InvalidGovernanceAction();
        m.enabled = enable;
        ++sourceConfigVersion;
        emit MarketChanged(index, m.marketType, m.market, enable);
    }

    /// @notice The DAO controls calendar-month inactivity and qualification,
    /// never retroactively changing a frozen proposal's voting weights.
    function configureVoterActivity(uint8 monthsInactive, uint8 minimumMisses, uint8 monthsQualification)
        external onlyDaoExecution
    {
        if (monthsInactive == 0 || monthsInactive > 24 || minimumMisses == 0
            || minimumMisses > 100 || monthsQualification == 0 || monthsQualification > 24)
            revert InvalidGovernanceAction();
        inactivityMonths = monthsInactive;
        minimumMissedProposals = minimumMisses;
        guardianQualificationMonths = monthsQualification;
        ++sourceConfigVersion;
    }

    function _isCustody(address owner) internal view returns (bool) {
        if (owner == address(morphoBlue)) return true;
        for (uint256 i; i < trackedMarkets.length;) {
            if (trackedMarkets[i].custody == owner) return true;
            unchecked { ++i; }
        }
        return false;
    }

    function _rawSources(address voter) internal view returns (uint256 walletShares, uint256 marketShares) {
        if (!_isCustody(voter)) walletShares = IERC20Upgradeable(address(votingToken)).balanceOf(voter);
        for (uint256 i; i < trackedMarkets.length;) {
            Market storage m = trackedMarkets[i];
            if (m.enabled) {
                if (m.marketType == MarketType.MorphoBlue) {
                    (,,uint128 collateral) = morphoBlue.position(m.marketId, voter);
                    marketShares += uint256(collateral);
                } else if (m.marketType == MarketType.CurveLend) {
                    uint256[2] memory xy = ICurveLendAMM(m.custody).get_sum_xy(voter);
                    marketShares += xy[1]; // actual LLAMMA collateral after soft liquidation
                } else revert InvalidGovernanceAction();
            }
            unchecked { ++i; }
        }
    }

    function _rawVotingPower(address voter) internal view returns (uint256) {
        (uint256 direct, uint256 inMarkets) = _rawSources(voter);
        return direct + inMarkets / 2;
    }

    function isActiveVoter(address voter) public view returns (bool) { return _active(voter); }

    function _active(address voter) internal view returns (bool) {
        Voter storage v = voterState[voter];
        if (!v.registered) return false;
        (uint256 missed, uint256 firstMiss) = _misses(voter);
        return missed < minimumMissedProposals || firstMiss == 0
            || block.timestamp < BokkyPooBahsDateTimeLibrary.addMonths(firstMiss, inactivityMonths);
    }

    function _misses(address voter) internal view returns (uint256 missed, uint256 firstMiss) {
        uint64 lastParticipation = voterState[voter].lastParticipationAt;
        for (uint256 i; i < allProposals.length;) {
            uint256 id = allProposals[i];
            Tracked storage p = tracked[id];
            if (p.exists && !p.canceled && p.end <= block.timestamp
                && p.end > lastParticipation && frozenWeight[id][voter] != 0
                && !cast[id][voter]) {
                ++missed;
                if (firstMiss == 0 || p.end < firstMiss) firstMiss = p.end;
            }
            unchecked { ++i; }
        }
    }

    function _activate(address voter) internal {
        if (voter == address(0) || _isCustody(voter)) revert InvalidGovernanceProposal();
        Voter storage v = voterState[voter];
        if (!v.registered) {
            v.registered = true;
            knownVoters.push(voter);
        }
        if (!_active(voter)) {
            v.activeSince = uint64(block.timestamp);
            v.lastParticipationAt = uint64(block.timestamp);
        }
        emit VoterActivated(voter, v.activeSince);
    }

    function _recordVote(uint256 id, address voter) internal {
        if (cast[id][voter]) revert InvalidGovernanceProposal();
        bool previouslyActive = _active(voter);
        cast[id][voter] = true;
        Voter storage v = voterState[voter];
        if (v.registered) {
            if (!previouslyActive) v.activeSince = uint64(block.timestamp);
            v.lastParticipationAt = uint64(block.timestamp);
        }
    }

    function _registerTracked(uint256 id, uint64 end) internal {
        if (tracked[id].exists || end <= block.timestamp) revert InvalidGovernanceProposal();
        tracked[id] = Tracked(end, false, true);
        allProposals.push(id);
    }

    /// @notice Single transaction: all eligible voters and every configured
    /// market are measured before storing any frozen voting allocation.
    /// Scaling by 85 and 15 makes Guardian bonus exactly 15% without rounding.
    function _freezeAtomic(uint256 id, address creator, bool removed)
        internal returns (uint256 eligible, uint256 denominator, uint256 creatorPower)
    {
        if (censusFrozen[id]) revert InvalidGovernanceProposal();
        uint256 community;
        for (uint256 i; i < knownVoters.length;) {
            address voter = knownVoters[i];
            if (_active(voter) && (voter != guardianSafe || removed)) {
                uint256 base = _rawVotingPower(voter);
                if (base != 0) {
                    frozenWeight[id][voter] = removed ? base : 85 * base;
                    community += base;
                }
            }
            unchecked { ++i; }
        }
        if (community == 0) revert NoVotingPower();
        if (removed) eligible = community;
        else {
            frozenWeight[id][guardianSafe] = 15 * community;
            eligible = 100 * community;
        }
        denominator = eligible;
        creatorPower = frozenWeight[id][creator];
        censusFrozen[id] = true;
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
        bytes memory _metadata,
        Action[] memory _actions,
        uint256 _allowFailureMap,
        uint256 proposalId,
        uint64 _startDate,
        uint64 _endDate
    ) private {
        emit ProposalCreated(proposalId, proposer[proposalId], _startDate, _endDate, _metadata, _actions, _allowFailureMap);
    }

    /// @dev This empty reserved space is put in place to allow future versions to add new
    /// variables without shifting down storage in the inheritance chain.
    /// https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
    // Non-upgradeable plugin: no storage gap or UUPS migration.

}
