// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.18;

import {Action} from "@aragon/osx-commons-contracts/src/executors/IExecutor.sol";
import {StagedProposalProcessor} from "../upstream/staged/StagedProposalProcessor.sol";

/// @title WBTC IPOR Guardian-Removal SPP
/// @notice SECOND independent instance of the untouched native Aragon SPP.
/// @dev It can execute exactly one action: standardSPP.updateStages([the
///      already-installed 14-day community stage]). No arbitrary actions,
///      delegatecalls, ETH or caller-supplied replacement stage bytes.
contract WbtcGuardianRemovalSPP is StagedProposalProcessor {
    StagedProposalProcessor public immutable standardSPP;

    error GuardianRemovalProcessInvalid();
    error GuardianRemovalActionForbidden();

    constructor(StagedProposalProcessor originalStandardInstance) {
        if (address(originalStandardInstance) == address(0)) revert GuardianRemovalProcessInvalid();
        standardSPP = originalStandardInstance;
    }

    /// @dev Native Standard config #1 is created at installation and is
    ///      never overwritten by updateStages. Reading its 14-day voting
    ///      stage enforces an exact future-only mirroring operation.
    function _originalStandardVoteStage() internal view returns (Stage memory) {
        Stage[] memory standard = standardSPP.getStages(1);
        if (standard.length != 2
            || standard[0].bodies.length != 1
            || !standard[0].bodies[0].isManual
            || standard[0].bodies[0].resultType != ResultType.Veto
            || standard[0].voteDuration != 7 days
            || standard[0].minAdvance != 0
            || standard[0].vetoThreshold != 1
            || standard[1].bodies.length != 1
            || standard[1].bodies[0].isManual
            || standard[1].bodies[0].resultType != ResultType.Approval
            || standard[1].approvalThreshold != 1
            || standard[1].vetoThreshold != 0
            || standard[1].voteDuration != 14 days
            || standard[1].minAdvance != 14 days
            || standard[1].maxAdvance <= 14 days)
            revert GuardianRemovalProcessInvalid();
        return standard[1];
    }

    /// @notice The single allowable parent action; generated onchain, not
    ///      accepted as calldata chosen by the proposal creator.
    function requiredTransitionAction() public view returns (Action memory action) {
        Stage[] memory replacement = new Stage[](1);
        replacement[0] = _originalStandardVoteStage();
        action = Action({
            to: address(standardSPP),
            value: 0,
            data: abi.encodeWithSelector(standardSPP.updateStages.selector, replacement)
        });
    }

    function _requireGuardianVoteStage() internal view {
        uint16 idx = getCurrentConfigIndex();
        if (idx != 1) revert GuardianRemovalProcessInvalid();
        Stage[] memory stages = getStages(idx);
        Stage memory standardVote = _originalStandardVoteStage();
        if (stages.length != 1 || stages[0].bodies.length != 1
            || stages[0].bodies[0].isManual
            || stages[0].bodies[0].resultType != ResultType.Approval
            || stages[0].bodies[0].addr != standardVote.bodies[0].addr
            || stages[0].approvalThreshold != 1
            || stages[0].vetoThreshold != 0
            || stages[0].voteDuration != 30 days
            || stages[0].minAdvance != 30 days
            || stages[0].maxAdvance <= 30 days
            || stages[0].cancelable || stages[0].editable)
            revert GuardianRemovalProcessInvalid();
    }

    function _requireDaoTarget(TargetConfig memory target) internal view {
        if (target.target != address(dao()) || uint8(target.operation) != 0)
            revert GuardianRemovalActionForbidden();
    }

    /// @notice Proposers submit metadata, date and their sub-body params.
    ///      The action array MUST be empty: the contract fills the only
    ///      permissible Standard SPP updateStages calldata itself.
    /// @notice Create a native parent using exclusively the hard-coded transition.
    function createProposal(
        bytes memory metadata,
        Action[] memory callerActions,
        uint128 allowFailureMap,
        uint64 startDate,
        bytes[][] memory proposalParams
    ) public virtual override returns (uint256) {
        if (callerActions.length != 0 || allowFailureMap != 0
            || standardSPP.getCurrentConfigIndex() != 1)
            revert GuardianRemovalActionForbidden();
        _requireDaoTarget(getTargetConfig());
        _requireGuardianVoteStage();
        Action[] memory fixedActions = new Action[](1);
        fixedActions[0] = requiredTransitionAction();
        // Native SPP alone creates, stores, counts and later executes parent.
        return super.createProposal(metadata, fixedActions, 0, startDate, proposalParams);
    }

    /// @notice No editable Guardian-removal actions, even if someone grants
    ///      the native EDIT permission in error.
    function edit(uint256, bytes calldata, Action[] calldata) public pure virtual override {
        revert GuardianRemovalActionForbidden();
    }

    /// @dev Execution guard is critical: native SPP.execute(),
    ///      advanceProposal() and report results all converge here.
    function _executeProposal(uint256 id) internal virtual override {
        Proposal memory p = getProposal(id);
        _requireDaoTarget(p.targetConfig);
        if (p.allowFailureMap != 0 || p.actions.length != 1)
            revert GuardianRemovalActionForbidden();
        Action memory expected = requiredTransitionAction();
        if (p.actions[0].to != expected.to || p.actions[0].value != 0
            || keccak256(p.actions[0].data) != keccak256(expected.data))
            revert GuardianRemovalActionForbidden();
        super._executeProposal(id);
    }
}
