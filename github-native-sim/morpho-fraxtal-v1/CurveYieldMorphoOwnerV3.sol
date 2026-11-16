// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

/// @title CurveYield Morpho Owner V3 - approved-factory extension
/// @notice Safely adds owner-managed factory permissions without moving the
///         live Morpho core away from its deployed V1 owner.
/// @dev IMPORTANT: V1 owner and V2 fee splitter are already immutably linked.
///      Replacing the core owner would break the existing splitter's
///      createMarket() authorization check. Deploy this as a Safe module:
///      1. Safe enables this V3 contract with enableModule(v3).
///      2. Safe calls setFactory(factoryV2, true) for each trusted factory.
///      3. Each factory deploys the new IRM and calls enableIrm(newIRM).
///      4. V3 executes V1.enableIrm(newIRM) THROUGH the Safe module interface,
///         so V1 observes msg.sender == Safe, preserving all existing rights.
///      No arbitrary Safe transaction execution interface is exposed.

interface ICYV3SafeModule {
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation
    ) external returns (bool success);
}

interface ICYV3LegacyGovernor {
    function safe() external view returns (address);
    function morpho() external view returns (address);
    function enableIrm(address irm) external;
}

interface ICYV3Morpho {
    function owner() external view returns (address);
}

contract CurveYieldMorphoOwnerV3 {
    address public immutable safe;
    address public immutable legacyGovernance;
    address public immutable morpho;
    mapping(address => bool) public approvedFactory;

    error Unauthorized();
    error InvalidAddress();
    error InvalidLegacyGovernance();
    error ModuleCallFailed();

    event FactoryAuthorizationChanged(address indexed factory, bool enabled);
    event FactoryIrmEnabled(address indexed factory, address indexed irm);

    constructor(address safe_, address legacyGovernance_, address morpho_) {
        if (
            safe_.code.length == 0 ||
            legacyGovernance_.code.length == 0 ||
            morpho_.code.length == 0
        ) revert InvalidAddress();
        if (
            ICYV3LegacyGovernor(legacyGovernance_).safe() != safe_ ||
            ICYV3LegacyGovernor(legacyGovernance_).morpho() != morpho_ ||
            ICYV3Morpho(morpho_).owner() != legacyGovernance_
        ) revert InvalidLegacyGovernance();
        safe = safe_;
        legacyGovernance = legacyGovernance_;
        morpho = morpho_;
    }

    /// @notice True authorizes a deployed factory; false removes permission.
    /// @dev Only the CurveYield Safe may alter this on-chain allowlist.
    function setFactory(address factory, bool enabled) external {
        if (msg.sender != safe) revert Unauthorized();
        if (factory == address(0) || (enabled && factory.code.length == 0))
            revert InvalidAddress();
        approvedFactory[factory] = enabled;
        emit FactoryAuthorizationChanged(factory, enabled);
    }

    /// @notice Trusted factory calls this immediately after creating an IRM.
    /// @dev Safe module execution calls the existing immutable V1 governor AS
    ///      the Safe; V1 then invokes Morpho.enableIrm(irm) as the core owner.
    ///      Failure reverts the entire factory creation transaction atomically.
    function enableIrm(address irm) external {
        if (!approvedFactory[msg.sender]) revert Unauthorized();
        if (irm.code.length == 0) revert InvalidAddress();
        bool success = ICYV3SafeModule(safe).execTransactionFromModule(
            legacyGovernance,
            0,
            abi.encodeWithSelector(ICYV3LegacyGovernor.enableIrm.selector, irm),
            0 // CALL, never DELEGATECALL
        );
        if (!success) revert ModuleCallFailed();
        emit FactoryIrmEnabled(msg.sender, irm);
    }
}
