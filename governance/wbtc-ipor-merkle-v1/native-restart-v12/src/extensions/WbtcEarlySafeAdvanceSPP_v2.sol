// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.18;

import {StagedProposalProcessor} from "../upstream/staged/StagedProposalProcessor.sol";

interface IWbtcSafeSpamEscrow {
    function recordSafeSpamExploitVeto(uint256 parentId) external;
}

/// @notice Narrow extension of the ORIGINAL Aragon SPP.
/// @dev The upstream SPP is copied byte-for-byte and is never edited. Only
///      the single-manual-Safe optimistic stage gets an additional Approval
///      result and may become Advanceable before its seven-day veto period.
///      All original stage, proposal, tally, permission and execution logic
///      remains owned by StagedProposalProcessor.
abstract contract WbtcEarlySafeAdvanceSPP is StagedProposalProcessor {
    error SafeReviewClosed();

    /// @dev A successful Guardian-removal vote can turn off the pending Safe
    ///      review. Standard SPP supplies the authoritative process-state read.
    function _guardianRemovalActive() internal view virtual returns (bool) {
        return false;
    }

    function _safeReviewBody(Proposal memory p)
        internal
        view
        returns (bool applicable, address safe, uint64 duration)
    {
        if (p.lastStageTransition == 0 || p.stageConfigIndex == 0) {
            return (false, address(0), 0);
        }
        Stage[] memory configured = getStages(p.stageConfigIndex);
        if (configured.length != 2) return (false, address(0), 0);
        Stage memory stage = configured[0];
        if (
            stage.bodies.length != 1 || !stage.bodies[0].isManual
                || stage.bodies[0].resultType != ResultType.Veto || stage.approvalThreshold != 0
                || stage.vetoThreshold != 1 || stage.minAdvance != 0
                || stage.voteDuration != 7 days || stage.maxAdvance <= stage.voteDuration
        ) return (false, address(0), 0);
        return (true, stage.bodies[0].addr, stage.voteDuration);
    }

    /// @inheritdoc StagedProposalProcessor
    function state(uint256 proposalId) public view virtual override returns (ProposalState) {
        ProposalState nativeState = super.state(proposalId);
        if (nativeState != ProposalState.Active) return nativeState;

        Proposal memory p = getProposal(proposalId);
        (bool isReview, address safe,) = _safeReviewBody(p);
        if (!isReview || p.currentStage != 0 || block.timestamp < p.lastStageTransition) return nativeState;

        ResultType safeResult = getBodyResult(proposalId, 0, safe);
        if (_guardianRemovalActive()) {
            // A pre-removal veto remains effective. Silence or Approval no
            // longer lets the removed Guardian keep an older parent blocked.
            return safeResult == ResultType.Veto ? nativeState : ProposalState.Advanceable;
        }
        // Surgical exception to the upstream veto-window rule: a conclusive
        // Yes from the sole manual Safe may advance immediately.
        if (safeResult == ResultType.Approval) return ProposalState.Advanceable;
        return nativeState;
    }

    /// @notice The only new Safe entrypoint. The original reportProposalResult
    ///      (Veto/None) remains literally inherited and unchanged.
    /// @dev Uses the original _processProposalResult tally and advanceProposal
    ///      machinery. When the Safe lacks ADVANCE_PERMISSION, the Yes is still
    ///      recorded and a permitted caller can advance in a later transaction.
    function reportSafeApproval(uint256 proposalId, bool tryAdvance) external {
        Proposal memory p = getProposal(proposalId);
        (bool isReview, address safe,) = _safeReviewBody(p);
        if (!isReview || _msgSender() != safe || p.currentStage != 0
            || p.executed || p.canceled) revert SafeReviewClosed();

        _processProposalResult(proposalId, 0, ResultType.Approval, safe);
        if (tryAdvance && hasAdvancePermission(safe)) {
            advanceProposal(proposalId);
        }
    }

    /// @notice Sole-Safe Spam/Exploit Attempt option for the optimistic stage.
    /// @dev The original SPP still records a native Veto; the weighted voting
    ///      plugin separately stores the spam flag against the parent's escrow.
    ///      No additional vote-taking contract is deployed.
    function reportSafeSpamExploit(uint256 proposalId) external {
        Proposal memory p = getProposal(proposalId);
        (bool isReview, address safe,) = _safeReviewBody(p);
        if (!isReview || _msgSender() != safe || p.currentStage != 0
            || p.executed || p.canceled || _guardianRemovalActive())
            revert SafeReviewClosed();
        if (getBodyResult(proposalId, 0, safe) != ResultType.None)
            revert SafeReviewClosed();
        _processProposalResult(proposalId, 0, ResultType.Veto, safe);
        Stage[] memory configured = getStages(p.stageConfigIndex);
        IWbtcSafeSpamEscrow(configured[1].bodies[0].addr)
            .recordSafeSpamExploitVeto(proposalId);
    }

    /// @dev Hook already provided by upstream. Closes the otherwise-unbounded
    ///      manual-report period WITHOUT replacing the native report function.
    function _processProposalResult(
        uint256 proposalId, uint16 stageId, ResultType resultType, address sender
    ) internal virtual override {
        if (stageId == 0) {
            Proposal memory p = getProposal(proposalId);
            (bool isReview, address safe, uint64 duration) = _safeReviewBody(p);
            if (isReview && sender == safe) {
                // One decisive option from this sole Safe voter: Approval,
                // ordinary Veto or Spam Veto. Native result storage remains.
                if (getBodyResult(proposalId, 0, safe) != ResultType.None)
                    revert SafeReviewClosed();
                if (p.executed || p.canceled || p.currentStage != 0
                    || _guardianRemovalActive()
                    || block.timestamp < p.lastStageTransition
                    || block.timestamp >= p.lastStageTransition + duration)
                    revert SafeReviewClosed();
            }
        }
        super._processProposalResult(proposalId, stageId, resultType, sender);
    }
}
