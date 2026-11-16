// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./CurveYieldMorphoIRMsV5.sol";
import "./CurveYieldTriggerMasterIRMV2.sol";
import "./CurveYieldMorphoOwnerV3.sol";

/// @notice Factory V2 deploys and automatically enables direct-to-Morpho IRMs.
///         Enablement uses an allowlisted V3 Safe module; no Morpho owner change.
///         Owner addresses and interest parameters are explicit caller inputs.
///         For Trigger Master children use the master as morpho_ (no enable
///         call is necessary). For independent IRMs use the real Morpho core.
///         Child owner configures per-market settings after deploying.
///         Each implementation enforces its own hard 365% simple APR ceiling.

/// @notice Factory V2 modules use the pre-existing Morpho owner via the Safe
///         allowlisted V3 extension. Direct IRMs are enabled atomically after
///         creation; child IRMs (morpho_=master) never need core enablement.
abstract contract CurveYieldIRMFactoryBaseV2 {
    CurveYieldMorphoOwnerV3 public immutable governance;

    error InvalidGovernance();

    constructor(address governance_) {
        if (governance_.code.length == 0) revert InvalidGovernance();
        governance = CurveYieldMorphoOwnerV3(governance_);
    }

    function _enableWhenDirect(address morpho_, address irm) internal {
        if (morpho_ == governance.morpho()) {
            governance.enableIrm(irm);
        }
    }
}

contract CurveYieldCollateralYieldIRMFactoryV2 is CurveYieldIRMFactoryBaseV2 {
    constructor(address governance_) CurveYieldIRMFactoryBaseV2(governance_) {}

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
        _enableWhenDirect(morpho_, irm);
        emit IrmCreated(irm, msg.sender, morpho_);
    }
}

contract CurveYieldEulerUtilizationIRMFactoryV2 is CurveYieldIRMFactoryBaseV2 {
    constructor(address governance_) CurveYieldIRMFactoryBaseV2(governance_) {}

    event IrmCreated(address indexed irm, address indexed creator, address indexed morpho);

    function create(address morpho_, address owner_) external returns (address irm) {
        irm = address(new CurveYieldEulerUtilizationIRMV2(morpho_, owner_));
        _enableWhenDirect(morpho_, irm);
        emit IrmCreated(irm, msg.sender, morpho_);
    }
}

contract CurveYieldLinearUtilizationIRMFactoryV2 is CurveYieldIRMFactoryBaseV2 {
    constructor(address governance_) CurveYieldIRMFactoryBaseV2(governance_) {}

    event IrmCreated(address indexed irm, address indexed creator, address indexed morpho);

    function create(address morpho_, address owner_) external returns (address irm) {
        irm = address(new CurveYieldLinearUtilizationIRMV1(morpho_, owner_));
        _enableWhenDirect(morpho_, irm);
        emit IrmCreated(irm, msg.sender, morpho_);
    }
}

contract CurveYieldImmutableStaticIRMFactoryV2 is CurveYieldIRMFactoryBaseV2 {
    constructor(address governance_) CurveYieldIRMFactoryBaseV2(governance_) {}

    event IrmCreated(address indexed irm, address indexed creator, address indexed morpho);

    function create(address morpho_, uint256 apr_) external returns (address irm) {
        irm = address(new CurveYieldImmutableStaticIRMV1(morpho_, apr_));
        _enableWhenDirect(morpho_, irm);
        emit IrmCreated(irm, msg.sender, morpho_);
    }
}

contract CurveYieldGovernedStaticIRMFactoryV2 is CurveYieldIRMFactoryBaseV2 {
    constructor(address governance_) CurveYieldIRMFactoryBaseV2(governance_) {}

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
        _enableWhenDirect(morpho_, irm);
        emit IrmCreated(irm, msg.sender, morpho_);
    }
}

contract CurveYieldTriggerMasterIRMFactoryV2 is CurveYieldIRMFactoryBaseV2 {
    constructor(address governance_) CurveYieldIRMFactoryBaseV2(governance_) {}

    event IrmCreated(address indexed irm, address indexed creator, address indexed morpho);

    function create(address morpho_, address owner_) external returns (address irm) {
        irm = address(new CurveYieldTriggerMasterIRMV2(morpho_, owner_));
        _enableWhenDirect(morpho_, irm);
        emit IrmCreated(irm, msg.sender, morpho_);
    }
}
