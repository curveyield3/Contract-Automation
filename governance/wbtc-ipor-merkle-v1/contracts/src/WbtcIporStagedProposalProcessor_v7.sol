// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.18;

import {Errors} from "./libraries/Errors.sol";
import {Permissions} from "./libraries/Permissions.sol";

import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";
import {Plugin} from "@aragon/osx-commons-contracts/src/plugin/Plugin.sol";
import {Action} from "@aragon/osx-commons-contracts/src/executors/IExecutor.sol";
import {
    IProposal
} from "@aragon/osx-commons-contracts/src/plugin/extensions/proposal/IProposal.sol";
import {MetadataExtension} from "@aragon/osx-commons-contracts/src/utils/metadata/MetadataExtension.sol";
import {Proposal as AragonProposalExtension} from "@aragon/osx-commons-contracts/src/plugin/extensions/proposal/Proposal.sol";

import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

interface IWbtcIporGuardianVoting {
    function guardianRemoved() external view returns (bool);
    function permanentlyRemoveDaoGuardian() external;
    function getVotingToken() external view returns (address);
    function snapshotVerifier() external view returns (address);
    function reserveParentSnapshot(uint256 parentId, address proposer, bool removal, bool verified) external;
    function isParentSnapshotReady(uint256 parentId) external view returns (bool);
    function isSpamApproved(uint256 subproposalId) external view returns (bool);
}

interface IWbtcIporBondEscrow {
    function escrowBond(uint256 parentId,address proposer,bool removal) external returns(uint256);
    function settleBond(uint256 parentId,address recipient,bool spam) external returns(uint256);
}
/// @title StagedProposalProcessor
/// @author Aragon X - 2024
/// @notice A multi-stage proposal processor where proposals progress through defined stages.
///         Each stage is evaluated by the responsible bodies, determining whether the proposal advances
///         to the next stage. Once a proposal successfully passes all stages, it can be executed.
contract WbtcIporStagedProposalProcessor is
    AragonProposalExtension,
    MetadataExtension,
    Plugin
{
    using ERC165Checker for address;

    // The DAO's existing UPDATE_STAGES_PERMISSION governs these bindings.
    // Three *native* SPP configurations: Standard review + ballot, Removal
    // ballot alone, and Standard ballot alone after permanent Guardian removal.
    address public guardianSafe;
    IWbtcIporGuardianVoting public guardianVoting;
    uint16 public standardStagesIndex;
    uint16 public removalStagesIndex;
    uint16 public noGuardianStagesIndex;
    mapping(uint256 => bool) public isGuardianRemoval;
    mapping(bytes32 => bool) public allowedStandardAction;
    mapping(uint256 => bool) public hasVerifiedSnapshotMode;
    mapping(uint256 => bool) private bodyProposalStarted;
    event ParentBondSettled(uint256 indexed parentId, uint256 amount, bool forfeited);
    error ParentBondNotSettled();
    event StandardActionPolicyUpdated(address indexed target, bytes4 indexed selector, bool enabled);
    error GovernanceConfigurationMissing();
    error InvalidGuardianReview();
    error InvalidGuardianStageConfiguration();
    error ForbiddenGovernanceAction();

    event GovernanceStageConfigBound(address indexed guardian, address indexed voting, uint16 standardIndex, uint16 removalIndex, uint16 noGuardianIndex);

    /// @notice Uses existing Aragon UPDATE_STAGES_PERMISSION and config versioning.
    /// Called once after installing all three native stage configurations.
    /// @notice Both binding and prospective updates share the same stage validation.
    function _validateGovernanceStages(
        address safe, address voting, uint16 standardIdx, uint16 removalIdx, uint16 noGuardianIdx
    ) private view {
        if (safe == address(0) || voting.code.length == 0 || safe == voting
            || standardIdx == 0 || removalIdx == 0 || noGuardianIdx == 0
            || standardIdx == removalIdx || standardIdx == noGuardianIdx
            || removalIdx == noGuardianIdx || standardIdx > currentConfigIndex
            || removalIdx > currentConfigIndex || noGuardianIdx > currentConfigIndex)
            revert InvalidGuardianStageConfiguration();
        Stage[] storage normal = stages[standardIdx];
        Stage[] storage special = stages[removalIdx];
        Stage[] storage afterRemoval = stages[noGuardianIdx];
        if (normal.length != 2 || special.length != 1 || afterRemoval.length != 1)
            revert InvalidGuardianStageConfiguration();
        Stage storage review = normal[0];
        if (review.bodies.length != 1 || review.bodies[0].addr != safe
            || !review.bodies[0].isManual || review.bodies[0].resultType != ResultType.Veto
            || review.minAdvance != 0 || review.voteDuration != 7 days
            || review.maxAdvance <= 7 days || review.approvalThreshold != 0
            || review.vetoThreshold != 1 || review.cancelable || review.editable
            || !_validVotingStage(normal[1], voting, 14 days)
            || !_validVotingStage(special[0], voting, 30 days)
            || !_validVotingStage(afterRemoval[0], voting, 14 days))
            revert InvalidGuardianStageConfiguration();
    }

    function bindGovernanceStageConfigurations(
        address safe, address voting, uint16 standardIdx, uint16 removalIdx, uint16 noGuardianIdx
    ) external auth(Permissions.UPDATE_STAGES_PERMISSION_ID) {
        if (address(guardianVoting) != address(0)) revert InvalidGuardianStageConfiguration();
        _validateGovernanceStages(safe, voting, standardIdx, removalIdx, noGuardianIdx);
        guardianSafe = safe;
        guardianVoting = IWbtcIporGuardianVoting(voting);
        standardStagesIndex = standardIdx;
        removalStagesIndex = removalIdx;
        noGuardianStagesIndex = noGuardianIdx;
        emit GovernanceStageConfigBound(safe, voting, standardIdx, removalIdx, noGuardianIdx);
    }

    /// @notice Future-only selection, preserving all old parent stage versions.
    function selectFutureStageConfigurations(
        uint16 newStandard, uint16 newRemoval, uint16 newNoGuardian
    ) external {
        if (msg.sender != address(dao()) || address(guardianVoting) == address(0)
            || (guardianVoting.guardianRemoved() && newStandard != standardStagesIndex))
            revert InvalidGuardianStageConfiguration();
        _validateGovernanceStages(
            guardianSafe, address(guardianVoting), newStandard, newRemoval, newNoGuardian
        );
        standardStagesIndex = newStandard;
        removalStagesIndex = newRemoval;
        noGuardianStagesIndex = newNoGuardian;
        emit GovernanceStageConfigBound(
            guardianSafe, address(guardianVoting), newStandard, newRemoval, newNoGuardian
        );
    }

    function setStandardActionAllowed(address target, bytes4 selector, bool enabled) external {
        if (msg.sender != address(dao())
            && !dao().hasPermission(address(this), _msgSender(),
                Permissions.UPDATE_STAGES_PERMISSION_ID, _msgData()))
            revert ForbiddenGovernanceAction();
        if (target == address(dao()) || target == address(this)
            || target == address(guardianVoting) && selector
                == IWbtcIporGuardianVoting.permanentlyRemoveDaoGuardian.selector
            || target.code.length == 0 || selector == bytes4(0)
            || selector == bytes4(keccak256("upgradeTo(address)"))
            || selector == bytes4(keccak256("upgradeToAndCall(address,bytes)"))
            || selector == bytes4(keccak256("execute(address,bytes)"))
            || selector == bytes4(keccak256("grant(bytes32,address)"))
            || selector == bytes4(keccak256("revoke(bytes32,address)")))
            revert ForbiddenGovernanceAction();
        allowedStandardAction[keccak256(abi.encode(target, selector))] = enabled;
        emit StandardActionPolicyUpdated(target, selector, enabled);
    }

    function _allowedStandardActions(Action[] memory actions) private view returns (bool) {
        for (uint256 i; i < actions.length; ++i) {
            Action memory a = actions[i];
            if (a.value != 0 || a.data.length < 4) return false;
            bytes4 selector;
            bytes memory d = a.data;
            assembly { selector := mload(add(d, 32)) }
            if (a.to == address(this)
                && (selector == this.setStandardActionAllowed.selector
                    || selector == this.updateStages.selector
                    || selector == this.selectFutureStageConfigurations.selector)) continue;
            if (!allowedStandardAction[keccak256(abi.encode(a.to, selector))])
                return false;
        }
        return true;
    }

    function _validVotingStage(Stage storage st, address voting, uint64 duration)
        private view returns (bool)
    {
        return st.bodies.length == 1 && st.bodies[0].addr == voting
            && !st.bodies[0].isManual && st.bodies[0].resultType == ResultType.Approval
            && st.minAdvance == duration && st.voteDuration == duration
            && st.maxAdvance > duration && st.approvalThreshold == 1
            && st.vetoThreshold == 0 && !st.cancelable && !st.editable
            && !st.bodies[0].tryAdvance;
    }

    function _isPendingSafeReview(uint256 id, uint16 stageId) private view returns (bool) {
        Proposal storage p = proposals[id];
        if (address(guardianVoting) == address(0) || isGuardianRemoval[id]
            || p.currentStage != 0 || stageId != 0) return false;
        Stage storage original = stages[p.stageConfigIndex][0];
        return original.bodies.length == 1 && original.bodies[0].isManual
            && original.bodies[0].addr == guardianSafe
            && original.bodies[0].resultType == ResultType.Veto
            && original.voteDuration == 7 days;
    }

    /// @notice Stored as a body's sub-proposal id while that sub-proposal is being created.
    /// @dev Written before the external `createProposal` call and replaced by the real id after
    ///      it returns, so a body that reenters from inside that call finds this value instead
    ///      of a default zero that could pass for a real id. `_getProposalTally` treats it as
    ///      "this stage can not be scored yet". A body is not allowed to return this value as an
    ///      id. It deliberately differs from `type(uint256).max`, which earlier versions stored
    ///      for sub-proposals that failed to be created.
    uint256 private constant PROPOSAL_IN_PROGRESS = type(uint256).max - 1;

    /// @notice The different types that bodies can be registered as.
    /// @param None Used to check if the body reported the result or not.
    /// @param Approval Used to allow a body to report approval result.
    /// @param Veto Used to allow a body to report veto result.
    enum ResultType {
        None,
        Approval,
        Veto
    }

    /// @notice The states of the proposal.
    /// @param Active Whether the proposal is not advanceable.
    /// @param Canceled Whether the proposal is canceled.
    /// @param Executed Whether the proposal is executed.
    /// @param Advanceable Whether the proposal can be advanced to the next stage.
    /// @param Expired Whether the proposal's stage maxAdvance time has passed.
    enum ProposalState {
        Active,
        Canceled,
        Executed,
        Advanceable,
        Expired
    }

    /// @notice A container for Body-related information.
    /// @param addr The address responsible for reporting results. For automatic bodies,
    ///     it is also where the SPP creates proposals.
    /// @param isManual Whether SPP should create a proposal on a body. If true, it will not create.
    /// @param tryAdvance Whether to try to automatically advance the stage when a body reports results.
    /// @param resultType The type(`Approval` or `Veto`) this body is registered with.
    struct Body {
        address addr;
        bool isManual;
        bool tryAdvance;
        ResultType resultType;
    }

    /// @notice A container for stage-related information.
    /// @param bodies The bodies that are responsible for advancing the stage.
    /// @param maxAdvance The maximum duration after which stage can not be advanced.
    /// @param minAdvance The minimum duration until when stage can not be advanced.
    /// @param voteDuration The time to give vetoing bodies to make decisions in optimistic stage.
    ///     Note that this also is used as an endDate time for bodies, see `_createBodyProposals`.
    /// @param approvalThreshold The number of bodies that are required to pass to advance the proposal.
    /// @param vetoThreshold If this number of bodies veto, the proposal can never advance
    ///     even if `approvalThreshold` is satisfied.
    /// @param cancelable If the proposal can be cancelled in the stage.
    /// @param editable If the proposal can be edited in the stage.
    struct Stage {
        Body[] bodies;
        uint64 maxAdvance;
        uint64 minAdvance;
        uint64 voteDuration;
        uint16 approvalThreshold;
        uint16 vetoThreshold;
        bool cancelable;
        bool editable;
    }

    /// @notice A container for proposal-related information.
    /// @param allowFailureMap A bitmap allowing the proposal to succeed, even if individual actions might revert.
    /// @param lastStageTransition The timestamp at which proposal's current stage has started.
    /// @param currentStage Which stage the proposal is at.
    /// @param stageConfigIndex The stage configuration that this proposal uses.
    /// @param executed Whether the proposal is executed or not.
    /// @param canceled Whether the proposal is canceled or not.
    /// @param creator The creator of the proposal.
    /// @param actions The actions to be executed when the proposal passes.
    /// @param targetConfig The target to which this contract will pass actions with an operation type.
    struct Proposal {
        uint128 allowFailureMap;
        uint64 lastStageTransition;
        uint16 currentStage;
        uint16 stageConfigIndex;
        bool executed;
        bool canceled;
        address creator;
        Action[] actions;
        TargetConfig targetConfig;
    }

    /// @notice A mapping to track sub-proposal IDs for a given proposal, stage, and body.
    mapping(uint256 proposalId => mapping(uint16 stageId => mapping(address body => uint256 subProposalId)))
        private bodyProposalIds;

    /// @notice A mapping to store the result types reported by bodies for a given proposal and stage.
    mapping(uint256 proposalId => mapping(uint16 stageId => mapping(address body => ResultType resultType)))
        private bodyResults;

    /// @notice A mapping to store custom proposal parameters data for a given proposal, stage, and body index.
    mapping(uint256 proposalId => mapping(uint16 stageId => mapping(uint256 bodyIndex => bytes customParams)))
        private createProposalParams;

    /// @notice A mapping between proposal IDs and their associated proposal information.
    mapping(uint256 proposalId => Proposal) private proposals;

    /// @notice A mapping between stage configuration indices and the corresponding stage configurations.
    mapping(uint256 configIndex => Stage[]) private stages;

    /// @notice The index of the current stage configuration in the `stages` mapping.
    uint16 private currentConfigIndex;

    /// @notice The address of the trusted forwarder.
    /// @dev The trusted forwarder appends the original sender's address to the calldata. If an executor is the
    ///      trusted forwarder, the `_msgSender` function extracts the original sender from the calldata.
    address private trustedForwarder;

    /// @notice Emitted when the proposal is advanced to the next stage.
    /// @param proposalId The proposal id.
    /// @param stageId The stage index.
    /// @param sender The address that advanced the proposal.
    event ProposalAdvanced(
        uint256 indexed proposalId,
        uint16 indexed stageId,
        address indexed sender
    );

    /// @notice Emitted when the proposal gets cancelled.
    /// @param proposalId the proposal id.
    /// @param stageId The stage index in which the proposal was cancelled.
    /// @param sender The sender that canceled the proposal.
    event ProposalCanceled(
        uint256 indexed proposalId,
        uint16 indexed stageId,
        address indexed sender
    );

    /// @notice Emitted when the proposal gets edited.
    /// @param proposalId the proposal id.
    /// @param stageId The stage index in which the proposal was edited.
    /// @param sender The sender that edited the proposal.
    /// @param metadata The new metadata that replaces old metadata.
    /// @param actions The new actions that replaces old actions.
    event ProposalEdited(
        uint256 indexed proposalId,
        uint16 indexed stageId,
        address indexed sender,
        bytes metadata,
        Action[] actions
    );

    /// @notice Emitted when a body reports results by calling `reportProposalResult`.
    /// @param proposalId The proposal id.
    /// @param stageId The stage index.
    /// @param body The sender that reported the result.
    event ProposalResultReported(
        uint256 indexed proposalId,
        uint16 indexed stageId,
        address indexed body
    );

    /// @notice Emitted when this plugin successfully creates a proposal on sub-body.
    /// @param proposalId The proposal id.
    /// @param stageId The stage index.
    /// @param body The sub-body on which sub-proposal has been created.
    /// @param bodyProposalId The proposal id that sub-body returns for later usage by this plugin.
    event SubProposalCreated(
        uint256 indexed proposalId,
        uint16 indexed stageId,
        address indexed body,
        uint256 bodyProposalId
    );

    /// @notice Emitted when the stage configuration is updated for a proposal process.
    /// @param stages The array of `Stage` structs representing the updated stage configuration.
    event StagesUpdated(Stage[] stages);

    /// @notice Emitted when the trusted forwarder is updated.
    /// @param forwarder The new trusted forwarder address.
    event TrustedForwarderUpdated(address indexed forwarder);

    /// @notice Source-derived direct Aragon Plugin bound to the
    /// factory-produced DAO. No voting proxy, upgrade method or custom setup.
    constructor(IDAO boundDao, bytes memory metadata) Plugin(boundDao) {
        if (address(boundDao).code.length == 0) revert GovernanceConfigurationMissing();
        _setMetadata(metadata);
        _setTargetConfig(TargetConfig({target: address(boundDao), operation: Operation.Call}));
    }

    /// @notice Allows to update stage configuration.
    /// @dev Requires the caller to have the `UPDATE_STAGES_PERMISSION_ID` permission.
    ///      Reverts if the provided `_stages` array is empty.
    /// @param _stages The new stage configuration as an array of `Stage` structs.
    function updateStages(
        Stage[] calldata _stages
    ) external auth(Permissions.UPDATE_STAGES_PERMISSION_ID) {
        if (_stages.length == 0) {
            revert Errors.StageCountZero();
        }
        _updateStages(_stages);
    }

    /// @notice Reports and records the result for a proposal at a specific stage.
    /// @dev A body of the `_stageId` may only report its configured result type, or `None` to retract a
    ///      previous result, and reverts with `ResultTypeNotAllowed` otherwise. A call from an address
    ///      that is not a body of the `_stageId` returns without effect.
    ///      If `_tryAdvance` is true, the proposal will attempt to advance to the next stage if eligible.
    ///      Requires the caller to have the `EXECUTE_PERMISSION_ID` permission to execute the final stage.
    ///      Reporting the result does not revert when the proposal is simply not eligible to advance,
    ///      but advancing an eligible proposal can revert, for example when a body on the next stage
    ///      fails to create its sub-proposal. Since this function is typically called by an action of a
    ///      sub-body's own proposal, such a revert also reverts that sub-body's execution. Sub-bodies
    ///      that must not be blocked by a failing next stage should report with `_tryAdvance` set to
    ///      false and advance the proposal in a separate transaction.
    /// @param _proposalId The ID of the proposal.
    /// @param _stageId The index of the stage, being reported on. Must not exceed the current stage of the proposal.
    /// @param _resultType The result type being reported: the body's configured type, or `None` to retract.
    /// @param _tryAdvance Whether to attempt advancing the proposal to the next stage if conditions are met.
    ///        Note that a failed advancement reverts this call, see the note above.
    function reportProposalResult(
        uint256 _proposalId,
        uint16 _stageId,
        ResultType _resultType,
        bool _tryAdvance
    ) external virtual {
        Proposal storage proposal = proposals[_proposalId];

        if (!_proposalExists(proposal)) {
            revert Errors.NonexistentProposal(_proposalId);
        }

        uint16 currentStage = proposal.currentStage;

        // Ensure that result can not be submitted
        // for the stage that has not yet become active.
        if (_stageId != currentStage || proposal.executed || proposal.canceled) {
            revert Errors.StageIdInvalid(currentStage, _stageId);
        }

        address sender = _msgSender();

        Body storage body = stages[proposal.stageConfigIndex][_stageId].bodies[0];
        if (body.addr != sender) return;
        if (_resultType != ResultType.None && _resultType != body.resultType
            && !(_isPendingSafeReview(_proposalId, _stageId)
                && sender == guardianSafe && _resultType == ResultType.Approval))
            revert Errors.ResultTypeNotAllowed(_stageId, sender, uint8(_resultType));

        if (_isPendingSafeReview(_proposalId, _stageId)) {
            if (sender != guardianSafe || guardianVoting.guardianRemoved()
                || block.timestamp < proposal.lastStageTransition
                || block.timestamp >= proposal.lastStageTransition + 7 days
                || _resultType == ResultType.None
                || bodyResults[_proposalId][_stageId][sender] != ResultType.None)
                revert InvalidGuardianReview();
        }
        _processProposalResult(_proposalId, _stageId, _resultType, sender);

        if (!_tryAdvance) {
            return;
        }

        // If the last stage, caller must have `EXECUTE_PERMISSION_ID`, otherwise `ADVANCE_PERMISSION_ID`.
        bool hasPermission = _isAtLastStage(proposal)
            ? hasExecutePermission(sender)
            : hasAdvancePermission(sender);

        // Missing permission or a non-advanceable state is not an error here: the
        // result is still recorded and this call succeeds, so that any other actions
        // in the reporting sub-body's proposal are not blocked by a skipped advance.
        // Advancing itself is not shielded that way. If it reverts, this call reverts
        // with it, which also reverts the reporting sub-body's execution.
        if (hasPermission && state(_proposalId) == ProposalState.Advanceable) {
            _advanceProposal(_proposalId, sender);
        }
    }

    /// @inheritdoc IProposal
    /// @dev This plugin inherits from `IProposal`, requiring an override for this function.
    function customProposalParamsABI() external pure virtual override returns (string memory) {
        return "(bytes[][] subBodiesCustomProposalParamsABI)";
    }



    /// @notice Creates a new proposal in this `StagedProposalProcessor` plugin.
    /// @dev Requires the caller to have the `CREATE_PROPOSAL_PERMISSION_ID` permission.
    ///      Also creates proposals for non-manual bodies in the first stage of the proposal process.
    /// @param _metadata The metadata of the proposal.
    /// @param _actions The actions that will be executed after the proposal passes.
    /// @param _allowFailureMap Allows proposal to succeed even if an action reverts.
    ///     Uses bitmap representation.
    ///     If the bit at index `x` is 1, the tx succeeds even if the action at `x` failed.
    ///     Passing 0 will be treated as atomic execution.
    /// @param _startDate The date at which first stage's bodies' proposals must be started at.
    /// @param _proposalParams The extra abi encoded parameters for each sub-body's createProposal function.
    /// @return proposalId The ID of the proposal.
    function createProposal(
        bytes memory _metadata,
        Action[] memory _actions,
        uint128 _allowFailureMap,
        uint64 _startDate,
        bytes[][] memory _proposalParams
    ) public virtual auth(Permissions.CREATE_PROPOSAL_PERMISSION_ID) returns (uint256 proposalId) {
        return _createGovernanceParent(_metadata, _actions, _allowFailureMap,
            _startDate, _proposalParams, false);
    }

    /// @notice An alternative authenticated-census path, required for removal
    /// and usable for Standard proposals with too many atomic census entries.
    function createVerifiedProposal(bytes memory metadata, Action[] memory actions,
        uint128 allowFailureMap, uint64 startDate, bytes[][] memory proposalParams)
        external auth(Permissions.CREATE_PROPOSAL_PERMISSION_ID) returns (uint256)
    {
        return _createGovernanceParent(metadata, actions, allowFailureMap,
            startDate, proposalParams, true);
    }

    function _createGovernanceParent(bytes memory _metadata, Action[] memory _actions,
        uint128 _allowFailureMap, uint64 _startDate, bytes[][] memory _proposalParams,
        bool verified) internal returns (uint256 proposalId) {
        // If `currentConfigIndex` is 0, this means the plugin was installed
        // with empty configurations and still hasn't updated stages
        // in which case we should revert.
        if (address(guardianVoting) == address(0)) revert GovernanceConfigurationMissing();
        bool removal = _isExactGuardianRemovalAction(_actions, _allowFailureMap);
        if (removal && guardianVoting.guardianRemoved()) revert ForbiddenGovernanceAction();
        // Ordinary actions are scoped to the one registered voting plugin
        // and their downstream DAO-allowed targets; zero-value atomic only.
        if (!removal
            && (_allowFailureMap != 0 || _actions.length == 0
                || !_allowedStandardActions(_actions)))
            revert ForbiddenGovernanceAction();
        if (getTargetConfig().target != address(dao())
            || uint8(getTargetConfig().operation) != 0)
            revert ForbiddenGovernanceAction();
        uint16 index = removal ? removalStagesIndex
            : guardianVoting.guardianRemoved() ? noGuardianStagesIndex : standardStagesIndex;
        if (index == 0) revert GovernanceConfigurationMissing();

        address creator = _msgSender();

        proposalId = _createProposalId(keccak256(abi.encode(_actions, _metadata, creator)));

        Proposal storage proposal = proposals[proposalId];

        if (_proposalExists(proposal)) {
            revert Errors.ProposalAlreadyExists(proposalId);
        }

        proposal.allowFailureMap = _allowFailureMap;
        proposal.targetConfig = getTargetConfig();
        proposal.creator = creator;

        // store stage configuration per proposal to avoid
        // changing it while proposal is still open
        proposal.stageConfigIndex = index;
        isGuardianRemoval[proposalId] = removal;
        // Special proposals MUST use the proof-backed supply-wide census.
        // For Standard parents the caller may explicitly request verified mode.
        verified = verified || removal;
        hasVerifiedSnapshotMode[proposalId] = verified;
        guardianVoting.reserveParentSnapshot(proposalId, creator, removal, verified);

        // The verifier is the sole pre-existing escrow, while SPP alone decides forfeiture.
        IWbtcIporBondEscrow(guardianVoting.snapshotVerifier()).escrowBond(
            proposalId, creator, removal);

        if (_startDate == 0) {
            _startDate = uint64(block.timestamp);
        } else if (_startDate < uint64(block.timestamp)) {
            revert Errors.StartDateInvalid(_startDate);
        }

        proposal.lastStageTransition = _startDate;

        for (uint256 i = 0; i < _actions.length; ++i) {
            proposal.actions.push(_actions[i]);
        }

        if (_proposalParams.length > type(uint16).max) {
            revert Errors.Uint16MaxSizeExceeded();
        }

        // To reduce the gas costs significantly, don't store the very
        // first stage's params in storage as they only get used in this
        // current tx and will not be needed later on for advancing.
        for (uint256 i = 1; i < _proposalParams.length; ++i) {
            for (uint256 j = 0; j < _proposalParams[i].length; ++j) {
                createProposalParams[proposalId][uint16(i)][j] = _proposalParams[i][j];
            }
        }

        _createBodyProposals(
            proposalId,
            0,
            proposal.lastStageTransition,
            _proposalParams.length > 0 ? _proposalParams[0] : new bytes[](0)
        );

        emit ProposalCreated({
            proposalId: proposalId,
            creator: creator,
            startDate: proposal.lastStageTransition,
            endDate: 0,
            metadata: _metadata,
            actions: _actions,
            allowFailureMap: _allowFailureMap
        });
    }

    function _isExactGuardianRemovalAction(Action[] memory actions, uint128 failures)
        internal view returns (bool)
    {
        if (actions.length != 1 || failures != 0
            || actions[0].to != address(guardianVoting) || actions[0].value != 0)
            return false;
        return keccak256(actions[0].data)
            == keccak256(abi.encodeWithSelector(
                IWbtcIporGuardianVoting.permanentlyRemoveDaoGuardian.selector
            ));
    }

    /// @inheritdoc IProposal
    /// @dev Calls a public function that requires the `CREATE_PERMISSION_ID` permission.
    function createProposal(
        bytes memory _metadata,
        Action[] memory _actions,
        uint64 _startDate,
        uint64 /** */,
        bytes memory _data
    ) public virtual override returns (uint256 proposalId) {
        proposalId = createProposal(
            _metadata,
            _actions,
            0,
            _startDate,
            abi.decode(_data, (bytes[][]))
        );
    }

    /// @notice Advances the specified proposal to the next stage if allowed.
    /// @dev This function checks whether the proposal exists and can advance based on its current state.
    ///      If the proposal is in the final stage, the caller must have the
    ///      `EXECUTE_PERMISSION_ID` permission to execute it.
    /// @param _proposalId The ID of the proposal.
    function advanceProposal(uint256 _proposalId) public virtual {
        Proposal storage proposal = proposals[_proposalId];

        // Reverts if proposal is not Advanceable or is non-existent.
        if (state(_proposalId) != ProposalState.Advanceable)
            revert Errors.ProposalExecutionForbidden(_proposalId);

        address sender = _msgSender();

        // If the last stage, caller must have `EXECUTE_PERMISSION_ID`, otherwise `ADVANCE_PERMISSION_ID`.
        bool hasPermission;
        if (_isAtLastStage(proposal)) {
            hasPermission = hasExecutePermission(sender);
            if (!hasPermission) revert Errors.ProposalExecutionForbidden(_proposalId);
        } else {
            hasPermission = hasAdvancePermission(sender);
            if (!hasPermission) revert Errors.ProposalAdvanceForbidden(_proposalId);
        }

        _advanceProposal(_proposalId, sender);
    }

    // Stage configurations are non-cancelable and non-editable.
    // Preserve API identifiers but omit the unneeded mutable action paths.
    function cancel(uint256) public pure virtual { revert ForbiddenGovernanceAction(); }
    function edit(uint256, bytes calldata, Action[] calldata)
        public pure virtual { revert ForbiddenGovernanceAction(); }

    function execute(
        uint256 _proposalId
    ) public virtual auth(Permissions.EXECUTE_PROPOSAL_PERMISSION_ID) {
        if (!canExecute(_proposalId)) {
            revert Errors.ProposalExecutionForbidden(_proposalId);
        }

        _executeProposal(_proposalId);
    }

    /// @notice Checks if this or the parent contract supports an interface by its ID.
    /// @param _interfaceId The ID of the interface.
    /// @return Returns `true` if the interface is supported.
    function supportsInterface(
        bytes4 _interfaceId
    )
        public
        view
        virtual
        override(Plugin, MetadataExtension, AragonProposalExtension)
        returns (bool)
    {
        return super.supportsInterface(_interfaceId);
    }



    /// @notice Determines whether the specified proposal can be advanced to the next stage.
    /// @dev Reverts if the proposal with the given `_proposalId` does not exist.
    /// @param _proposalId The unique identifier of the proposal to check.
    /// @return Returns `true` if the proposal can be advanced to the next stage, otherwise `false`.
    function canProposalAdvance(uint256 _proposalId) public view virtual returns (bool) {
        // `state` reverts if proposal is non existent.
        return state(_proposalId) == ProposalState.Advanceable;
    }

    /// @inheritdoc IProposal
    function canExecute(uint256 _proposalId) public view virtual returns (bool) {
        Proposal storage proposal = proposals[_proposalId];

        // 1. `state` reverts if proposal is non existent.
        // 2. Proposal must be on the last stage and be advanceable.
        return state(_proposalId) == ProposalState.Advanceable && _isAtLastStage(proposal);
    }

    /// @notice Current state of a proposal.
    /// @param _proposalId The proposal id.
    /// @return The current state of the proposal.
    function state(uint256 _proposalId) public view virtual returns (ProposalState) {
        Proposal storage proposal = proposals[_proposalId];

        if (proposal.executed) {
            return ProposalState.Executed;
        }

        if (proposal.canceled) {
            return ProposalState.Canceled;
        }

        if (!_proposalExists(proposal)) {
            revert Errors.NonexistentProposal(_proposalId);
        }

        Stage storage stage = stages[proposal.stageConfigIndex][proposal.currentStage];
        if (!guardianVoting.isParentSnapshotReady(_proposalId)
            && !_isPendingSafeReview(_proposalId, proposal.currentStage))
            return ProposalState.Active;

        // Native optimistic-veto stage specialized for the single Safe.
        // Safe approval advances early; silence advances after 7d; a
        // finalized Safe veto blocks advancement even after removal.
        // No proposal is invalidated by Guardian removal.
        if (_isPendingSafeReview(_proposalId, proposal.currentStage)) {
            if (block.timestamp < proposal.lastStageTransition) return ProposalState.Active;
            ResultType result = bodyResults[_proposalId][0][guardianSafe];
            if (result == ResultType.Veto) return ProposalState.Active;
            if (guardianVoting.guardianRemoved() || result == ResultType.Approval
                || block.timestamp < proposal.lastStageTransition
                || block.timestamp >= proposal.lastStageTransition + 7 days) {
                return ProposalState.Advanceable;
            }
            return ProposalState.Active;
        }

        if (proposal.lastStageTransition + stage.maxAdvance < block.timestamp) {
            return ProposalState.Expired;
        }

        if (proposal.lastStageTransition + stage.minAdvance > block.timestamp) {
            return ProposalState.Active;
        }

        if (stage.vetoThreshold > 0) {
            if (proposal.lastStageTransition + stage.voteDuration > block.timestamp) {
                return ProposalState.Active;
            }
        }

        bool thresholdMet = _thresholdsMet(
            _proposalId,
            proposal.currentStage,
            stage.approvalThreshold,
            stage.vetoThreshold
        );

        if (thresholdMet) {
            return ProposalState.Advanceable;
        }

        return ProposalState.Active;
    }



    /// @notice The verified census is necessary BEFORE the child ballot can
    /// start. Accepting it starts the full 14/30-day voting clock. The original
    /// parent, parent actions and prior Safe decision are never recreated.
    function onParentSnapshotFinalized(uint256 parentId) external {
        if (msg.sender != address(guardianVoting) || !hasVerifiedSnapshotMode[parentId]
            || !guardianVoting.isParentSnapshotReady(parentId)) revert ForbiddenGovernanceAction();
        Proposal storage parent = proposals[parentId];
        if (!_proposalExists(parent) || parent.executed || parent.canceled)
            revert ForbiddenGovernanceAction();
        Stage storage st = stages[parent.stageConfigIndex][parent.currentStage];
        if (st.bodies[0].isManual || bodyProposalStarted[parentId]) return;
        if (st.voteDuration != (isGuardianRemoval[parentId] ? 30 days : 14 days))
            revert InvalidGuardianStageConfiguration();
        parent.lastStageTransition = uint64(block.timestamp);
        _createBodyProposals(parentId, parent.currentStage, uint64(block.timestamp), new bytes[](0));
    }

    /// @notice Permissionless settlement once a parent review was vetoed
    /// or its community ballot has finished. Spam forfeiture requires actual
    /// community quorum and majority on the one native TokenVoting tally.
    function settleParentBond(uint256 id) external {
        Proposal storage parent = proposals[id];
        if (!_proposalExists(parent)) revert ParentBondNotSettled();
        uint16 ballotStage = stages[parent.stageConfigIndex].length == 1 ? 0 : 1;
        bool vetoed = parent.currentStage == 0 && !isGuardianRemoval[id]
            && bodyResults[id][0][guardianSafe] == ResultType.Veto;
        bool completed = parent.executed || (guardianVoting.isParentSnapshotReady(id)
            && parent.currentStage == ballotStage
            && parent.lastStageTransition + stages[parent.stageConfigIndex][ballotStage].voteDuration
                <= block.timestamp);
        if (!vetoed && !completed) revert ParentBondNotSettled();

        bool spam;
        if (!vetoed) {
            uint256 subId = bodyProposalIds[id][ballotStage][address(guardianVoting)];
            if (subId != 0) spam = guardianVoting.isSpamApproved(subId);
        }
        uint256 bond = IWbtcIporBondEscrow(guardianVoting.snapshotVerifier())
            .settleBond(id, parent.creator, spam);
        emit ParentBondSettled(id, bond, spam);
    }

    function getProposalCreator(uint256 id) external view returns (address) {
        return proposals[id].creator;
    }

    /// @notice Retrieves all information associated with a proposal by its ID.
    /// @param _proposalId The ID of the proposal.
    /// @return The proposal struct
    function getProposal(uint256 _proposalId) public view returns (Proposal memory) {
        return proposals[_proposalId];
    }

    /// @notice Retrieves the result type submitted by a body for a specific proposal and stage.
    /// @param _proposalId The ID of the proposal.
    /// @param _stageId The stage index.
    /// @param _body The address of the sub-body.
    /// @return Returns what resultType the body reported the result with.
    ///     Returns `None (0)` if no result has been provided yet.
    function getBodyResult(
        uint256 _proposalId,
        uint16 _stageId,
        address _body
    ) public view virtual returns (ResultType) {
        return bodyResults[_proposalId][_stageId][_body];
    }

    /// @notice Retrieves the sub proposal id.
    /// @param _proposalId The ID of the proposal.
    /// @param _stageId The stage index.
    /// @param _body The address of the sub-body.
    /// @return Returns what resultType the body reported the result with.
    ///     Returns `None (0)` if no result has been provided yet.
    function getBodyProposalId(
        uint256 _proposalId,
        uint16 _stageId,
        address _body
    ) public view virtual returns (uint256) {
        return bodyProposalIds[_proposalId][_stageId][_body];
    }

    /// @notice Retrieves the current configuration index at which the current configurations of stages are stored.
    /// @return The index of the current configuration in the `stages` mapping.
    function getCurrentConfigIndex() public view returns (uint16) {
        return currentConfigIndex;
    }

    /// @notice Retrieves the stages stored on the `_index` in the `stages` configuration.
    /// @param _index The index from which to get the stages configuration.
    /// @return The array of `Stage` structs.
    function getStages(uint256 _index) public view virtual returns (Stage[] memory) {
        if (_index > getCurrentConfigIndex() || _index == 0) {
            revert Errors.StageCountZero();
        }

        return stages[_index];
    }

    /// @notice Calculates and retrieves the number of approvals and vetoes for a proposal on the stage.
    /// @param _proposalId The proposal ID.
    /// @param _stageId The stage index.
    /// @return approvals The total number of approvals for the proposal.
    /// @return vetoes The total number of vetoes for the proposal.
    function getProposalTally(
        uint256 _proposalId,
        uint16 _stageId
    ) public view virtual returns (uint256 approvals, uint256 vetoes) {
        Proposal storage proposal = proposals[_proposalId];

        if (!_proposalExists(proposal)) {
            revert Errors.NonexistentProposal(_proposalId);
        }

        return _getProposalTally(_proposalId, _stageId);
    }

    /// @inheritdoc IProposal
    function hasSucceeded(uint256 _proposalId) public view virtual override returns (bool) {
        Proposal storage proposal = proposals[_proposalId];

        // `state` reverts if proposal is non existent.
        ProposalState currentState = state(_proposalId);

        // Proposal must be on the last stage and either advanceable or executed.
        return
            _isAtLastStage(proposal) &&
            (currentState == ProposalState.Advanceable || currentState == ProposalState.Executed);
    }

    /// @notice Checks whether the caller has the required permission to execute a proposal at the last stage.
    /// @param _account The address on which the `EXECUTE_PERMISSION_ID` is checked.
    /// @return Returns `true` if the caller has the `EXECUTE_PERMISSION_ID` permission, otherwise `false`.
    function hasExecutePermission(address _account) public view virtual returns (bool) {
        return
            dao().hasPermission(
                address(this),
                _account,
                Permissions.EXECUTE_PROPOSAL_PERMISSION_ID,
                _msgData()
            );
    }

    /// @notice Checks whether the caller has the required permission to advance a proposal.
    /// @param _account The address on which the `ADVANCE_PERMISSION_ID` is checked.
    /// @return Returns `true` if the caller has the `ADVANCE_PERMISSION_ID` permission, otherwise `false`.
    function hasAdvancePermission(address _account) public view virtual returns (bool) {
        return
            dao().hasPermission(
                address(this),
                _account,
                Permissions.ADVANCE_PERMISSION_ID,
                _msgData()
            );
    }

    // =========================== INTERNAL/PRIVATE FUNCTIONS =============================

    /// @notice Internal function to update stage configuration.
    /// @dev It's a caller's responsibility not to call this in case `_stages` are empty.
    ///      This function can not be overridden as it's crucial to not allow duplicating bodies
    ///      in the same stage, because proposal creation and report functions depend on this assumption.
    /// @param requested The stages configuration.
    /// @notice Only one authorized governance body per stage is supported.
    /// This preserves native Aragon stage versions and execution machinery,
    /// while removing arbitrary N-body combinations we never install.
    function _updateStages(Stage[] memory requested) internal {
        if (requested.length == 0 || requested.length > 2)
            revert InvalidGuardianStageConfiguration();
        Stage[] storage destination = stages[++currentConfigIndex];
        for (uint256 i; i < requested.length; ++i) {
            Stage memory stage = requested[i];
            if (stage.bodies.length != 1 || stage.maxAdvance <= stage.minAdvance
                || stage.maxAdvance <= stage.voteDuration
                || stage.approvalThreshold > 1 || stage.vetoThreshold > 1)
                revert InvalidGuardianStageConfiguration();
            Body memory body = stage.bodies[0];
            if (body.addr == address(0) || body.resultType == ResultType.None
                || (!body.isManual
                    && !body.addr.supportsInterface(type(IProposal).interfaceId)))
                revert InvalidGuardianStageConfiguration();
            Stage storage current = destination.push();
            current.bodies.push(body);
            current.maxAdvance = stage.maxAdvance;
            current.minAdvance = stage.minAdvance;
            current.voteDuration = stage.voteDuration;
            current.approvalThreshold = stage.approvalThreshold;
            current.vetoThreshold = stage.vetoThreshold;
            current.cancelable = stage.cancelable;
            current.editable = stage.editable;
        }
        emit StagesUpdated(requested);
    }

    /// @notice Internal function that executes the proposal's actions.
    /// @param _proposalId The ID of the proposal.
    function _executeProposal(uint256 _proposalId) internal virtual {
        Proposal storage proposal = proposals[_proposalId];

        // Parent actions and target configuration are immutable, were
        // checked at creation, and remain executable under the ORIGINAL
        // source-bound policy even if future policy changes are adopted.
        // Recheck only the immutable removal action's narrow shape.
        if (isGuardianRemoval[_proposalId]
            && !_isExactGuardianRemovalAction(proposal.actions, proposal.allowFailureMap))
            revert ForbiddenGovernanceAction();
        proposal.executed = true;

        _execute(
            proposal.targetConfig.target,
            bytes32(_proposalId),
            proposal.actions,
            uint256(proposal.allowFailureMap),
            proposal.targetConfig.operation
        );

        emit ProposalExecuted(_proposalId);
    }

    /// @notice Records the result by the caller.
    /// @dev Assumes that bodies are not duplicated in the same stage. See `_updateStages` function.
    /// @param _proposalId The ID of the proposal.
    /// @param _stageId The stage index.
    /// @param _resultType The result type being reported (`Approval`, `Veto`, or `None` to retract).
    /// @param _sender The address that reported the result.
    function _processProposalResult(
        uint256 _proposalId,
        uint16 _stageId,
        ResultType _resultType,
        address _sender
    ) internal virtual {
        bodyResults[_proposalId][_stageId][_sender] = _resultType;
        emit ProposalResultReported(_proposalId, _stageId, _sender);
    }

    /// @notice Creates proposals on the non-manual bodies of the `stageId`.
    /// @dev Assumes that bodies are not duplicated in the same stage. See `_updateStages` function.
    ///      Each sub-body is called directly, so a body that reverts or returns a value that can not
    ///      be decoded as a `uint256` reverts the whole transaction. A single misbehaving body
    ///      therefore blocks proposal creation or advancement for the entire stage.
    /// @param proposalId The ID of the parent proposal.
    /// @param stageId The stage index.
    /// @param startDate The stage start time.
    /// @param params The per-body creation parameters.
    /// @notice Every configured stage has exactly one Aragon body. Preserve
    /// the original IProposal result-reporting handshake, with no N-body loop.
    function _createBodyProposals(
        uint256 proposalId, uint16 stageId, uint64 startDate, bytes[] memory params
    ) internal virtual {
        Stage storage st = stages[proposals[proposalId].stageConfigIndex][stageId];
        Body storage body = st.bodies[0];
        if (body.isManual || !guardianVoting.isParentSnapshotReady(proposalId)) return;
        if (bodyProposalStarted[proposalId]) revert InvalidGuardianStageConfiguration();
        bodyProposalStarted[proposalId] = true;
        Action[] memory actions = new Action[](1);
        actions[0] = Action({
            to: address(this),
            value: 0,
            data: abi.encodeCall(
                this.reportProposalResult,
                (proposalId, stageId, body.resultType, body.tryAdvance)
            )
        });
        bodyProposalIds[proposalId][stageId][body.addr] = PROPOSAL_IN_PROGRESS;
        bytes memory parameters = params.length == 0 ? new bytes(0) : params[0];
        uint256 childId = IProposal(body.addr).createProposal(
            abi.encode(address(this), proposalId, stageId),
            actions,
            startDate,
            startDate + st.voteDuration,
            parameters
        );
        if (childId == PROPOSAL_IN_PROGRESS)
            revert Errors.SubProposalCreationFailed(body.addr, "");
        bodyProposalIds[proposalId][stageId][body.addr] = childId;
        emit SubProposalCreated(proposalId, stageId, body.addr, childId);
    }

    /// @notice Advances a proposal to the next stage or executes it if it is in the final stage.
    /// @dev Assumes the proposal is eligible to advance. If the proposal is not in the final stage,
    ///      it creates proposals for the sub-bodies in the next stage.
    ///      If the proposal is in the final stage, it triggers execution.
    ///      Reverts if any non-manual body on the next stage fails to create its sub-proposal,
    ///      which leaves the proposal on its current stage.
    /// @param _proposalId The ID of the proposal.
    /// @param _sender The address that advances the proposal.
    function _advanceProposal(uint256 _proposalId, address _sender) internal virtual {
        Proposal storage _proposal = proposals[_proposalId];
        Stage[] storage _stages = stages[_proposal.stageConfigIndex];

        if (_proposal.currentStage < _stages.length - 1) {
            // is not last stage
            uint16 newStage = ++_proposal.currentStage;
            _proposal.lastStageTransition = uint64(block.timestamp);

            // Grab the next stage's bodies' custom params of `createProposal`.
            bytes[] memory customParams = new bytes[](1);
            customParams[0] = createProposalParams[_proposalId][newStage][0];

            _createBodyProposals(_proposalId, newStage, uint64(block.timestamp), customParams);

            emit ProposalAdvanced(_proposalId, newStage, _sender);
        } else {
            _executeProposal(_proposalId);
        }
    }



    /// @notice Internal function to calculate and retrieve the number of approvals and
    ///         vetoes for a proposal in the `stageId`.
    /// @dev Assumes that bodies are not duplicated in the same stage. See `_updateStages` function.
    ///      This function ensures that only records from addresses in the stage configuration are used.
    /// @param id The proposal Id.
    /// @param stageId The stage index.
    /// @return approvals The number of approvals for the proposal.
    /// @return vetoes The number of vetoes for the proposal.
    /// @notice The configured SPP stages have precisely one body each.
    /// Keep Aragon's existing result semantics without an unbounded loop.
    function _getProposalTally(uint256 id, uint16 stageId)
        internal view virtual returns (uint256 approvals, uint256 vetoes)
    {
        Proposal storage parent = proposals[id];
        Body storage body = stages[parent.stageConfigIndex][stageId].bodies[0];
        uint256 subId = bodyProposalIds[id][stageId][body.addr];
        if (subId == PROPOSAL_IN_PROGRESS) return (0, type(uint256).max);
        ResultType result = bodyResults[id][stageId][body.addr];
        if (result == ResultType.Approval) return (1, 0);
        if (result == ResultType.Veto) return (0, 1);
        if (body.isManual) return (0, 0);
        (bool ok, bytes memory returned) = body.addr.staticcall(
            abi.encodeCall(IProposal.hasSucceeded, (subId))
        );
        if (ok && returned.length == 32 && abi.decode(returned, (bool))) {
            if (body.resultType == ResultType.Approval) return (1, 0);
            return (0, 1);
        }
        return (0, 0);
    }

    /// @notice Internal helper function that decides if the stage's thresholds are satisfied.
    /// @param _proposalId The proposal id.
    /// @param _stageId The stage index.
    /// @param _approvalThreshold The approval threshold of the `_stageId`.
    /// @param _vetoThreshold The veto threshold of the `_stageId`.
    /// @return Returns true if the thresholds are met, otherwise false.
    function _thresholdsMet(
        uint256 _proposalId,
        uint16 _stageId,
        uint256 _approvalThreshold,
        uint256 _vetoThreshold
    ) internal view returns (bool) {
        (uint256 approvals, uint256 vetoes) = _getProposalTally(_proposalId, _stageId);

        if (_vetoThreshold > 0 && vetoes >= _vetoThreshold) {
            return false;
        }

        if (approvals < _approvalThreshold) {
            return false;
        }

        return true;
    }

    /// @notice Checks if proposal is at the last stage or not.
    /// @param _proposal The proposal struct.
    /// @return Returns `true` if proposal is at the last stage, otherwise false.
    function _isAtLastStage(Proposal storage _proposal) private view returns (bool) {
        return _proposal.currentStage == stages[_proposal.stageConfigIndex].length - 1;
    }

    /// @notice Checks if proposal exists or not.
    /// @param _proposal The proposal struct.
    /// @return Returns `true` if proposal exists, otherwise false.
    function _proposalExists(Proposal storage _proposal) private view returns (bool) {
        return _proposal.lastStageTransition != 0;
    }

    /// @dev This empty reserved space is put in place to allow future versions to add new
    /// variables without shifting down storage in the inheritance chain.
    /// https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
    uint256[44] private __gap;
}
