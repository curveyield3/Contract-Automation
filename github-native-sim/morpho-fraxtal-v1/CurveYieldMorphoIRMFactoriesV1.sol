// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./CurveYieldMorphoIRMsV5.sol";
import "./CurveYieldTriggerMasterIRMV2.sol";

/// @notice Each factory deploys a NEW copy of its existing IRM implementation.
///         There is no separate accounting, operator role, proxy, or registry.
///         Owner addresses and interest parameters are explicit caller inputs.
///         For models used as children of the Trigger Master, pass that master's
///         deployed address as morpho_. For independent models, pass Morpho core.
///         Child owner configures per-market settings after deploying.
///         Each implementation enforces its own hard 365% simple APR ceiling.

contract CurveYieldCollateralYieldIRMFactoryV1 {
    event IrmCreated(address indexed irm, address indexed creator, address indexed morpho);

    function create(
        address morpho_,
        address owner_,
        address vault_,
        uint256 fallbackApr_,
        uint256 collateralCap_,
        uint256 borrowCap_
    ) external returns (address irm) {
        irm = address(new CurveYieldCollateralYieldIRMV2(
            morpho_, owner_, vault_, fallbackApr_, collateralCap_, borrowCap_
        ));
        emit IrmCreated(irm, msg.sender, morpho_);
    }
}

contract CurveYieldEulerUtilizationIRMFactoryV1 {
    event IrmCreated(address indexed irm, address indexed creator, address indexed morpho);

    function create(address morpho_, address owner_) external returns (address irm) {
        irm = address(new CurveYieldEulerUtilizationIRMV2(morpho_, owner_));
        emit IrmCreated(irm, msg.sender, morpho_);
    }
}

contract CurveYieldLinearUtilizationIRMFactoryV1 {
    event IrmCreated(address indexed irm, address indexed creator, address indexed morpho);

    function create(address morpho_, address owner_) external returns (address irm) {
        irm = address(new CurveYieldLinearUtilizationIRMV1(morpho_, owner_));
        emit IrmCreated(irm, msg.sender, morpho_);
    }
}

contract CurveYieldImmutableStaticIRMFactoryV1 {
    event IrmCreated(address indexed irm, address indexed creator, address indexed morpho);

    function create(address morpho_, uint256 apr_) external returns (address irm) {
        irm = address(new CurveYieldImmutableStaticIRMV1(morpho_, apr_));
        emit IrmCreated(irm, msg.sender, morpho_);
    }
}

contract CurveYieldGovernedStaticIRMFactoryV1 {
    event IrmCreated(address indexed irm, address indexed creator, address indexed morpho);

    function create(
        address morpho_,
        address owner_,
        uint256 minimumApr_,
        uint256 maximumApr_,
        uint256 initialApr_,
        uint256 maximumAprChangePerDay_,
        uint256 shiftWindowDays_,
        uint256 timelockDays_
    ) external returns (address irm) {
        irm = address(new CurveYieldGovernedStaticIRMV2(
            morpho_, owner_, minimumApr_, maximumApr_, initialApr_,
            maximumAprChangePerDay_, shiftWindowDays_, timelockDays_
        ));
        emit IrmCreated(irm, msg.sender, morpho_);
    }
}

contract CurveYieldTriggerMasterIRMFactoryV1 {
    event IrmCreated(address indexed irm, address indexed creator, address indexed morpho);

    function create(address morpho_, address owner_) external returns (address irm) {
        irm = address(new CurveYieldTriggerMasterIRMV2(morpho_, owner_));
        emit IrmCreated(irm, msg.sender, morpho_);
    }
}
