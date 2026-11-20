// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.18;

import {Action} from "@aragon/osx-commons-contracts/src/executors/IExecutor.sol";
import {WbtcEarlySafeAdvanceSPP} from "./WbtcEarlySafeAdvanceSPP_v2.sol";

/// @title WBTC IPOR Standard Governance SPP
/// @notice FIRST fresh plugin instance, based on the untouched upstream SPP.
/// @dev Native SPP maintains every stage, parent, body, action and tally. This
///      extension enforces only the pre-removal Standard action allowlist and
///      the additional Safe early-Approval path in WbtcEarlySafeAdvanceSPP.
contract WbtcStandardSPP is WbtcEarlySafeAdvanceSPP {
    bytes32 public constant CONFIGURE_STANDARD_ACTIONS_PERMISSION_ID =
        keccak256("CONFIGURE_STANDARD_ACTIONS_PERMISSION");

    mapping(address => mapping(bytes4 => bool)) public standardActionAllowed;

    error StandardActionForbidden(address target, bytes4 selector);
    error StandardProcessMisconfigured();
    error StandardActionConfigLocked();
    error StandardExecutionTargetForbidden();

    event StandardActionApproved(address indexed target, bytes4 indexed selector);

    /// @notice Approve an exact target/selector under Aragon DAO permissions.
    /// @dev Add-only before removal: an approved proposal cannot be rendered
    ///      unexecutable by revoking its allowlist entry before it executes.
    ///      The selector of native SPP.updateStages is NEVER approvable.
    function approveStandardAction(address target, bytes4 selector)
        external
        auth(CONFIGURE_STANDARD_ACTIONS_PERMISSION_ID)
    {
        if (guardianRemoved()) revert StandardActionConfigLocked();
        if (target == address(0) || selector == this.updateStages.selector)
            revert StandardActionForbidden(target, selector);
        standardActionAllowed[target][selector] = true;
        emit StandardActionApproved(target, selector);
    }

    /// @notice One-way *observed* transition: the Guardian SPP's only action
    ///      installs the copied community stage as native configuration #2.
    /// @dev Configuration indices are versioned by upstream SPP. The permission
    ///      graph MUST prohibit any updateStages call before the Guardian vote.
    ///      Later config changes cannot unset this historical transition flag.
    function guardianRemoved() public view returns (bool) {
        if (getCurrentConfigIndex() < 2) return false;
        Stage[] memory transitionStages = getStages(2);
        return transitionStages.length == 1 && transitionStages[0].bodies.length == 1
            && !transitionStages[0].bodies[0].isManual
            && transitionStages[0].bodies[0].resultType == ResultType.Approval
            && transitionStages[0].voteDuration == 14 days;
    }

    /// @notice Authoritative original Safe body from configuration #1.
    /// @dev Used by weighted TokenVoting during one-time binding so its
    ///      bond-slashing Safe cannot differ from the actual review voter.
    function configuredGuardianSafe() external view returns (address) {
        Stage[] memory configured = getStages(1);
        if (configured.length != 2 || configured[0].bodies.length != 1
            || !configured[0].bodies[0].isManual
            || configured[0].bodies[0].resultType != ResultType.Veto)
            revert StandardProcessMisconfigured();
        return configured[0].bodies[0].addr;
    }

    function _guardianRemovalActive() internal view override returns (bool) {
        return guardianRemoved();
    }

    function _requireProcessConfiguration() internal view {
        uint16 latest = getCurrentConfigIndex();
        if (latest == 0) revert StandardProcessMisconfigured();
        Stage[] memory configured = getStages(latest);
        if (guardianRemoved()) {
            if (configured.length != 1 || configured[0].bodies.length != 1
                || configured[0].bodies[0].isManual
                || configured[0].bodies[0].resultType != ResultType.Approval)
                revert StandardProcessMisconfigured();
        } else {
            if (latest != 1 || configured.length != 2
                || configured[0].bodies.length != 1
                || !configured[0].bodies[0].isManual
                || configured[0].bodies[0].resultType != ResultType.Veto
                || configured[0].minAdvance != 0
                || configured[0].voteDuration != 7 days
                || configured[0].vetoThreshold != 1
                || configured[1].bodies.length != 1
                || configured[1].bodies[0].isManual
                || configured[1].bodies[0].resultType != ResultType.Approval
                || configured[1].voteDuration != 14 days)
                revert StandardProcessMisconfigured();
        }
    }

    function _requireDaoCall(address target, uint8 operation) internal view {
        if (target != address(dao()) || operation != 0) {
            revert StandardExecutionTargetForbidden();
        }
    }

    function _actionSelector(bytes memory data) internal pure returns (bytes4 selector) {
        if (data.length < 4) return bytes4(0);
        assembly { selector := mload(add(data, 0x20)) }
    }

    function _requireAllowed(Action[] memory actions, uint128 allowFailureMap) internal view {
        if (guardianRemoved()) return; // One-way transition makes DAO calls unrestricted.
        if (allowFailureMap != 0 || actions.length == 0) {
            revert StandardActionForbidden(address(0), bytes4(0));
        }
        for (uint256 i; i < actions.length; ++i) {
            bytes4 selector = _actionSelector(actions[i].data);
            if (actions[i].data.length < 4 || actions[i].value != 0
                || selector == this.updateStages.selector
                || !standardActionAllowed[actions[i].to][selector]) {
                revert StandardActionForbidden(actions[i].to, selector);
            }
        }
    }

    /// @notice Restrict Standard parent actions before invoking native creation.
    function createProposal(
        bytes memory metadata,
        Action[] memory actions,
        uint128 allowFailureMap,
        uint64 startDate,
        bytes[][] memory proposalParams
    ) public virtual override returns (uint256) {
        _requireProcessConfiguration();
        _requireDaoCall(getTargetConfig().target, uint8(getTargetConfig().operation));
        _requireAllowed(actions, allowFailureMap);
        // Native SPP still owns creator authorization, IDs, stages and storage.
        return super.createProposal(metadata, actions, allowFailureMap, startDate, proposalParams);
    }

    /// @notice Preserve native editing rules while enforcing the parent action policy.
    function edit(uint256 id, bytes calldata metadata, Action[] calldata actions)
        public virtual override
    {
        // Native SPP handles edit permissions and stage editability.
        _requireAllowed(actions, getProposal(id).allowFailureMap);
        super.edit(id, metadata, actions);
    }

    /// @notice Validate the stored action list before native final execution.
    function _executeProposal(uint256 id) internal virtual override {
        Proposal memory p = getProposal(id);
        _requireDaoCall(p.targetConfig.target, uint8(p.targetConfig.operation));
        _requireAllowed(p.actions, p.allowFailureMap);
        // Retain native SPP action execution and its state transitions.
        super._executeProposal(id);
    }
}
