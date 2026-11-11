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
import {IERC20MetadataUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20MetadataUpgradeable.sol";

/// @dev A separately implemented, plugin-authorized, source-bound census.
///      It MUST freeze a complete consistent snapshot and never return unverified
///      externally supplied totals. Not supplied by this contract-development step.
interface IWbtcIporSnapshotSource {
    function freezeAtomic(
        uint256 proposalId, uint8 kind, uint256 anchorBlock, address proposer, address guardian,
        bool guardianRemoved
    ) external returns (uint256 eligibleWeight, uint256 quorumDenominator, uint256 proposerWeight);
    function frozenVotingPower(uint256 proposalId, address voter) external view returns (uint256);
    function activated(address voter) external view returns (bool);
    function activate(address voter) external;
    function recordVote(uint256 proposalId, address voter) external;
    function previewStandardTotalVotingPower(uint256 timepoint) external view returns (uint256);
}

/// @dev Must be non-upgradeable and permanently enforce one-way removal; deployment
///      must deny alternate DAO execution/permission routes that could bypass it.
interface IWbtcIporGuardianConstitution {
    function permanentlyRemoveDaoGuardian() external;
    function isGuardianRemoved() external view returns (bool);
}

/// @dev Immutable, restrictive execution policy. A governance proposal may call
///      only exact, explicitly authorized target/selector/value combinations.
interface IWbtcIporActionPolicy {
    function isAllowed(address target, uint256 value, bytes calldata data) external view returns (bool);
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

    // Source-fork additions (appended after existing Aragon storage).
    enum ProposalKind { Standard, RemoveDaoGuardian }

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

    GovernanceConfig public governanceConfig;
    IWbtcIporSnapshotSource public snapshotSource;
    IWbtcIporGuardianConstitution public guardianConstitution;
    IWbtcIporActionPolicy public actionPolicy;
    address public guardianSafe;
    bytes32 public actionPolicyCodeHash;
    uint256 private governanceEntryLock;

    mapping(uint256 => ProposalKind) public proposalKind;
    mapping(uint256 => bool) public guardianVetoed;
    mapping(uint256 => bool) public guardianApprovedEarly;
    mapping(uint256 => address) public proposer;
    mapping(uint256 => uint256) public bondAmount;
    mapping(uint256 => bool) public bondSettled;
    mapping(uint256 => uint256) public spamFlaggedPower;
    mapping(uint256 => uint256) public frozenEligiblePower;
    mapping(uint256 => uint256) public frozenQuorumDenominator;

    event GuardianReview(uint256 indexed proposalId, bool approved);
    event ProposalBondSettled(uint256 indexed proposalId, bool forfeited, uint256 amount);
    event GovernanceConfigurationUpdated();
    event FrozenGovernanceSnapshot(uint256 indexed proposalId, ProposalKind kind, uint256 eligiblePower, uint256 denominator);

    error SnapshotIntegrationRequired();
    error InvalidGovernanceProposal();
    error GuardianAlreadyRemoved();
    error InvalidGovernanceAction();
    error OnlyGuardianOrDAO();
    error ProposalBondNotReady();
    error ProposalAlreadySettled();

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
    error NoVotingPower();

    /// @notice Thrown if the token reports an inconsistent clock mode and clock value
    error TokenClockMismatch();

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
        address[] memory _excludedAccounts,
        address _guardianSafe,
        IWbtcIporGuardianConstitution _constitution,
        IWbtcIporSnapshotSource _snapshotSource,
        IWbtcIporActionPolicy _actionPolicy
    ) external onlyCallAtInitialization reinitializer(3) {
        // Preserve the Aragon base initializer with immutable default boundaries.
        require(
            _votingSettings.votingMode == VotingMode.Standard
                && _votingSettings.supportThreshold == 670000
                && _votingSettings.minParticipation == 250000
                && _votingSettings.minDuration == 14 days
                && _votingSettings.minProposerVotingPower == 0 && _minApprovals == 0,
            "NONSTANDARD_INITIAL_SETTINGS"
        );
        require(
            _guardianSafe != address(0) && address(_constitution).code.length != 0
                && address(_snapshotSource).code.length != 0 && address(_actionPolicy).code.length != 0,
            "MISSING_GOVERNANCE_DEPENDENCY"
        );
        // EVM action operation must be Call (not DelegateCall). The setup
        // contract must additionally ensure only this plugin holds DAO executor rights.
        require(uint8(_targetConfig.operation) == 0, "DELEGATECALL_NOT_ALLOWED");
        __MajorityVotingBase_init(_dao, _votingSettings, _targetConfig, _minApprovals, _pluginMetadata);

        votingToken = _token;
        _detectTokenClock();
        for (uint256 i; i < _excludedAccounts.length;) {
            excludedAccounts.add(_excludedAccounts[i]);
            unchecked { ++i; }
        }
        if (_excludedAccounts.length > 0) emit ExcludedFromSupply(_excludedAccounts);

        guardianSafe = _guardianSafe;
        guardianConstitution = _constitution;
        snapshotSource = _snapshotSource;
        actionPolicy = _actionPolicy;
        actionPolicyCodeHash = address(_actionPolicy).codehash;
        uint8 decimals_ = IERC20MetadataUpgradeable(address(_token)).decimals();
        require(decimals_ >= 3 && decimals_ <= 36, "UNSUPPORTED_SHARE_DECIMALS");
        uint256 bond = 10 ** uint256(decimals_ - 3); // 0.001 actual vault shares
        governanceConfig = GovernanceConfig({
            standardQuorumPpm: 250000,
            standardSupportPpm: 670000,
            removalQuorumPpm: 330000,
            removalSupportPpm: 750000,
            proposerThresholdPpm: 100000,
            securityReviewDuration: 7 days,
            standardVoteDuration: 14 days,
            removalVoteDuration: 30 days,
            standardBond: bond
        });
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
    /// @notice Fresh deployment only. The original Aragon upgrade-migration entrypoint
    /// is intentionally disabled until a complete upgrade/guardian immutability
    /// policy has been proven against the DAO permission graph.
    function initializeFrom(uint16, bytes calldata) external pure {
        revert("UNSUPPORTED_MIGRATION");
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
        return snapshotSource.previewStandardTotalVotingPower(_timePoint);
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
        if (guardianConstitution.isGuardianRemoved()) revert GuardianAlreadyRemoved();
        Action[] memory actions_ = new Action[](1);
        actions_[0] = Action({
            to: address(guardianConstitution),
            value: 0,
            data: abi.encodeCall(IWbtcIporGuardianConstitution.permanentlyRemoveDaoGuardian, ())
        });
        proposalId = _createWeightedProposal(ProposalKind.RemoveDaoGuardian, _metadata, actions_, _msgSender());
    }

    function _createWeightedProposal(
        ProposalKind kind, bytes memory metadata, Action[] memory actions_, address creator
    ) private returns (uint256 id) {
        bool removed = guardianConstitution.isGuardianRemoved();
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
        id = _createProposalId(keccak256(abi.encode(kind, actions_, metadata)));
        Proposal storage proposal_ = proposals[id];
        if (proposal_.parameters.snapshotTimepoint != 0) revert ProposalAlreadyExists(id);
        (
            uint256 eligiblePower,
            uint256 denominator,
            uint256 creatorPower
        ) = snapshotSource.freezeAtomic(id, uint8(kind), block.number, creator, guardianSafe, removed);

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
        return snapshotSource.activated(_account) || (_account == guardianSafe && !guardianConstitution.isGuardianRemoved());
    }

    /// @notice Single transaction: EIP712 self delegation and registry activation.
    /// The vault's native delegateBySig authenticates the exact account.
    function activateVotingPower(
        uint256 nonce, uint256 expiry, uint8 v, bytes32 r, bytes32 s
    ) external singleGovernanceEntry {
        address voter = _msgSender();
        votingToken.delegateBySig(voter, nonce, expiry, v, r, s);
        if (votingToken.delegates(voter) != voter) revert InvalidGovernanceProposal();
        snapshotSource.activate(voter);
    }

    /// @notice Already self-delegated accounts can activate without a new signature.
    function activateVotingPower() external singleGovernanceEntry {
        address voter = _msgSender();
        if (votingToken.delegates(voter) != voter) revert InvalidGovernanceProposal();
        snapshotSource.activate(voter);
    }

    /// @notice Guardian's stage-one veto/approval never contributes a voting tally.
    function reviewStandardProposal(uint256 id, bool approve) external singleGovernanceEntry {
        if (_msgSender() != guardianSafe || guardianConstitution.isGuardianRemoved()) {
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
        } else {
            guardianVetoed[id] = true;
        }
        emit GuardianReview(id, approve);
    }

    /// @notice Optional spam classification on the same irreversible ballot.
    function voteWithSpamFlag(uint256 id, VoteOption choice, bool markSpam) external {
        if (!markSpam) revert InvalidGovernanceProposal();
        vote(id, choice, false); // uses Aragon's existing permission/eligibility path
        spamFlaggedPower[id] += snapshotSource.frozenVotingPower(id, _msgSender());
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
        if (bondSettled[id]) revert ProposalAlreadySettled();
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
        if (proposer[id] == address(0)) return false;
        if (proposalKind[id] == ProposalKind.Standard) {
            if (guardianVetoed[id]) return false;
        } else {
            // No duplicate irreversible removal execution after a prior removal.
            if (guardianConstitution.isGuardianRemoved()) return false;
            if (!_isExactRemovalAction(id)) return false;
        }
        if (block.timestamp < proposals[id].parameters.endDate) return false;
        return super._canExecute(id);
    }

    function _execute(uint256 id) internal override {
        // The execution policy must be exactly the immutable code approved at
        // initialization. Merely checking the policy address is insufficient.
        if (address(actionPolicy).codehash != actionPolicyCodeHash) revert InvalidGovernanceAction();
        if (proposalKind[id] == ProposalKind.RemoveDaoGuardian) {
            if (!_isExactRemovalAction(id)) revert InvalidGovernanceAction();
        } else {
            _checkStandardStorageActions(id);
        }
        super._execute(id);
        if (proposalKind[id] == ProposalKind.RemoveDaoGuardian
            && !guardianConstitution.isGuardianRemoved()) revert InvalidGovernanceAction();
    }

    function _isExactRemovalAction(uint256 id) private view returns (bool) {
        Proposal storage p = proposals[id];
        return p.actions.length == 1 && p.allowFailureMap == 0
            && p.actions[0].to == address(guardianConstitution) && p.actions[0].value == 0
            && keccak256(p.actions[0].data) == keccak256(
                abi.encodeCall(IWbtcIporGuardianConstitution.permanentlyRemoveDaoGuardian, ())
            );
    }

    function _checkStandardActions(Action[] memory actions_) private view {
        if (address(actionPolicy).codehash != actionPolicyCodeHash) revert InvalidGovernanceAction();
        for (uint256 i; i < actions_.length;) {
            if (!actionPolicy.isAllowed(actions_[i].to, actions_[i].value, actions_[i].data)) {
                revert InvalidGovernanceAction();
            }
            unchecked { ++i; }
        }
    }

    function _checkStandardStorageActions(uint256 id) private view {
        Proposal storage p = proposals[id];
        if (p.allowFailureMap != 0) revert InvalidGovernanceAction();
        for (uint256 i; i < p.actions.length;) {
            Action storage a = p.actions[i];
            if (!actionPolicy.isAllowed(a.to, a.value, a.data)) revert InvalidGovernanceAction();
            unchecked { ++i; }
        }
    }

    /// @inheritdoc MajorityVotingBase
    function _vote(uint256 _proposalId, VoteOption _voteOption, address _voter, bool)
        internal override
    {
        Proposal storage p = proposals[_proposalId];
        uint256 weight = snapshotSource.frozenVotingPower(_proposalId, _voter);
        // No replacements: the frozen voting snapshot can be counted only once.
        if (_voteOption == VoteOption.Yes) p.tally.yes += weight;
        else if (_voteOption == VoteOption.No) p.tally.no += weight;
        else if (_voteOption == VoteOption.Abstain) p.tally.abstain += weight;
        else revert InvalidGovernanceProposal();
        p.voters[_voter] = _voteOption;
        snapshotSource.recordVote(_proposalId, _voter);
        emit VoteCast({proposalId: _proposalId, voter: _voter, voteOption: _voteOption, votingPower: weight});
    }

    /// @inheritdoc MajorityVotingBase
    function _canVote(uint256 _proposalId, address _account, VoteOption _voteOption)
        internal view override returns (bool)
    {
        Proposal storage p = proposals[_proposalId];
        return proposer[_proposalId] != address(0) && !guardianVetoed[_proposalId]
            && _isProposalOpen(p) && _voteOption != VoteOption.None
            && p.voters[_account] == VoteOption.None
            && snapshotSource.frozenVotingPower(_proposalId, _account) != 0;
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
        emit ProposalCreated(proposalId, _msgSender(), _startDate, _endDate, _metadata, _actions, _allowFailureMap);
    }

    /// @dev This empty reserved space is put in place to allow future versions to add new
    /// variables without shifting down storage in the inheritance chain.
    /// https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
    uint256[24] private __gap;
}
