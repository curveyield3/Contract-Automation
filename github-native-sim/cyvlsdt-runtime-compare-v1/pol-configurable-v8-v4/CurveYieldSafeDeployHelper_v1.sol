// SPDX-License-Identifier: MIT
/**
 * @title CurveYield System Component
 * @notice CurveYield is a decentralized NGO building optimized DeFi systems for the good of all.
 * @dev CurveYield integrates specialized AMM infrastructure, tokenized yield strategies, credit
 * markets, and protocol-owned liquidity into a unified, capital-efficient liquidity stack governed
 * by an open, international DAO community.
 * Protocol operations are enhanced by cross-chain bridging and messaging, MEV capture systems,
 * off-chain to on-chain automation, and peer-to-peer data networks, and peer-to-peer data networks.
 * This contract is one component of the CurveYield system.
 * The contracts are audited and tested independently; users and integrators must review documentation.
 * Learn more: https://curveyield.com & https://curveyield.org
 * Decentralized links: https://curveyield.eth.limo and https://curveyield.dao
 * Note: curveyield.dao may require a Brave Browser or Unstoppable Domains browser plugin.
 */
pragma solidity ^0.8.28;

/// @notice Safe-only CREATE executor: ownership handoffs remain Safe-controlled.
/// @dev Required because external CreateCall would retain Ownable constructor ownership.
contract CurveYieldSafeDeployHelperV1 {
    address public immutable safe;
    error Unauthorized();
    error DeploymentFailed();
    error ExternalCallFailed(bytes reason);
    event Created(address indexed deployed);
    constructor(address safe_) {
        if (safe_ == address(0)) revert Unauthorized();
        safe = safe_;
    }
    modifier onlySafe() {
        if (msg.sender != safe) revert Unauthorized();
        _;
    }
    function deploy(bytes calldata creationCode, bool handoffToSafe)
        external onlySafe returns (address deployed)
    {
        bytes memory code = creationCode;
        assembly { deployed := create(0, add(code, 32), mload(code)) }
        if (deployed == address(0)) revert DeploymentFailed();
        if (handoffToSafe) _call(deployed, abi.encodeWithSignature("transferOwnership(address)", safe));
        emit Created(deployed);
    }
    /// @notice Allows Safe to configure its owned master before final ownership handoff.
    function configure(address target, bytes calldata data) external onlySafe {
        _call(target, data);
    }
    function _call(address target, bytes memory data) private {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) revert ExternalCallFailed(ret);
    }
}
