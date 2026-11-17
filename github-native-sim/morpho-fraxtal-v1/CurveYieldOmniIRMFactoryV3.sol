// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {
    CurveYieldCollateralYieldIRMV3,
    CurveYieldEulerUtilizationIRMV3,
    CurveYieldLinearUtilizationIRMV2,
    CurveYieldImmutableStaticIRMV2,
    CurveYieldGovernedStaticIRMV3
} from "./CurveYieldMorphoIRMsV7.sol";
import {CurveYieldTriggerMasterIRMV3} from "./CurveYieldTriggerMasterIRMV3.sol";
import {CurveYieldMorphoOwnerV3} from "./CurveYieldMorphoOwnerAndSplitterV5.sol";

/// @notice Internal creation-code container, deployed automatically by OmniFactory.
/// @dev Its runtime code is raw IRM creation bytecode, read by EXTCODECOPY.
///      It is not a callable factory and does not depend on previously deployed factories.
/**
 * @title CurveYield System Component
 * @notice CurveYield is a decentralized NGO building optimized DeFi systems for the good of all.
 *
 * @dev CurveYield integrates specialized AMM infrastructure, tokenized yield strategies, credit
 * markets, and protocol-owned liquidity into a unified, capital-efficient liquidity stack governed
 * by an open, international DAO community.
 *
 * Protocol operations are enhanced by cross-chain bridging and messaging, MEV capture systems,
 * off-chain to on-chain automation, and peer-to-peer data networks.
 *
 * This contract is one component of the CurveYield system.
 *
 * CurveYield uses proven DeFi primitives where possible and adds targeted coordination and
 * capital-efficiency-enhancing contracts where needed. Users and integrators must review
 * CurveYield documentation before use.
 *
 * Learn more:
 * dApp: https://curveyield.com & https://curveyield.org
 *
 * Decentralized links may have limited or delayed availability during periods of high network activity:
 * https://curveyield.eth.limo
 * https://curveyield.dao
 *
 * Note: curveyield.dao may require a Brave Browser or an Unstoppable Domains browser plugin to use.
 */
contract CurveYieldIRMCreationCodeStoreV3 {
    constructor(bytes memory code) {
        assembly ("memory-safe") {
            return(add(code, 32), mload(code))
        }
    }
}

/// @notice Standalone factory for six IRM templates, using verified bounded-math V7 optimizations.
/// @dev No calls to or references to any previously deployed individual factories.
///      Constructor installs six internal bytecode stores to keep factory runtime below EIP-170.
///      A Safe-controlled one-time governance whitelist authorization of THIS factory is
///      necessary to enable direct-Morpho IRMs; child/master IRMs need no approval.
/**
 * @title CurveYield System Component
 * @notice CurveYield is a decentralized NGO building optimized DeFi systems for the good of all.
 *
 * @dev CurveYield integrates specialized AMM infrastructure, tokenized yield strategies, credit
 * markets, and protocol-owned liquidity into a unified, capital-efficient liquidity stack governed
 * by an open, international DAO community.
 *
 * Protocol operations are enhanced by cross-chain bridging and messaging, MEV capture systems,
 * off-chain to on-chain automation, and peer-to-peer data networks.
 *
 * This contract is one component of the CurveYield system.
 *
 * CurveYield uses proven DeFi primitives where possible and adds targeted coordination and
 * capital-efficiency-enhancing contracts where needed. Users and integrators must review
 * CurveYield documentation before use.
 *
 * Learn more:
 * dApp: https://curveyield.com & https://curveyield.org
 *
 * Decentralized links may have limited or delayed availability during periods of high network activity:
 * https://curveyield.eth.limo
 * https://curveyield.dao
 *
 * Note: curveyield.dao may require a Brave Browser or an Unstoppable Domains browser plugin to use.
 */
contract CurveYieldOmniIRMFactoryV3 {
    address public immutable governance;
    address public immutable morpho;
    address public immutable owner;
    uint256 public immutable maxCallerFeeWei;
    uint256 public callerFeeWei;
    address[6] private _creationCodeStores;

    error InvalidGovernance();
    error InvalidTemplate();
    error InvalidConstructorArgs();
    error CreationFailed();
    error Unauthorized();
    error ExcessiveCallerFee();
    error IncorrectCallerFee();
    error InvalidReceiver();
    error EthTransferFailed();

    event CallerFeeUpdated(uint256 previousFeeWei, uint256 newFeeWei);
    event CallerFeesWithdrawn(address indexed receiver, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    event IrmCreated(
        uint8 indexed templateId,
        address indexed irm,
        address indexed creator,
        address morpho
    );

    /// @param governance_ Deployed CurveYieldMorphoOwnerV3 controller.
    constructor(address governance_, uint256 initialCallerFeeWei_, uint256 maxCallerFeeWei_) {
        if (governance_.code.length == 0) revert InvalidGovernance();
        CurveYieldMorphoOwnerV3 controller = CurveYieldMorphoOwnerV3(governance_);
        address morpho_ = address(controller.morpho());
        if (morpho_.code.length == 0) revert InvalidGovernance();
        if (initialCallerFeeWei_ > maxCallerFeeWei_) revert ExcessiveCallerFee();
        governance = governance_;
        morpho = morpho_;
        owner = controller.safe();
        maxCallerFeeWei = maxCallerFeeWei_;
        callerFeeWei = initialCallerFeeWei_;

        // Model economics and ABIs are unchanged. All six stores are created here,
        // so creation never depends on any other factory or administrator.
        _creationCodeStores[0] = address(new CurveYieldIRMCreationCodeStoreV3(
            type(CurveYieldCollateralYieldIRMV3).creationCode
        ));
        _creationCodeStores[1] = address(new CurveYieldIRMCreationCodeStoreV3(
            type(CurveYieldEulerUtilizationIRMV3).creationCode
        ));
        _creationCodeStores[2] = address(new CurveYieldIRMCreationCodeStoreV3(
            type(CurveYieldLinearUtilizationIRMV2).creationCode
        ));
        _creationCodeStores[3] = address(new CurveYieldIRMCreationCodeStoreV3(
            type(CurveYieldImmutableStaticIRMV2).creationCode
        ));
        _creationCodeStores[4] = address(new CurveYieldIRMCreationCodeStoreV3(
            type(CurveYieldGovernedStaticIRMV3).creationCode
        ));
        _creationCodeStores[5] = address(new CurveYieldIRMCreationCodeStoreV3(
            type(CurveYieldTriggerMasterIRMV3).creationCode
        ));
    }

    /// @notice Create any of the six IRM templates, preserving their constructor ABI.
    /// @param templateId 0=CollateralYield, 1=EulerUtilization, 2=LinearUtilization,
    ///                   3=ImmutableStatic, 4=GovernedStatic, 5=TriggerMaster.
    /// @param constructorArgs Exact abi.encode(...) of the selected IRM's constructor args,
    ///                        beginning with its target morpho_.
    /// @dev When target morpho_ is the governed Morpho core, enableIrm is atomic.
    ///      For child IRMs targeting TriggerMaster, no Morpho enable call is made.
    function create(uint8 templateId, bytes calldata constructorArgs)
        external payable returns (address irm)
    {
        if (msg.value != callerFeeWei) revert IncorrectCallerFee();
        uint256 expectedLength;
        if (templateId == 0) expectedLength = 192;
        else if (templateId == 1 || templateId == 2 ||
                 templateId == 3 || templateId == 5) expectedLength = 64;
        else if (templateId == 4) expectedLength = 256;
        else revert InvalidTemplate();

        if (constructorArgs.length != expectedLength) revert InvalidConstructorArgs();

        address store = _creationCodeStores[templateId];
        uint256 codeLength = store.code.length;
        bytes memory initCode = new bytes(codeLength + expectedLength);
        address targetMorpho = abi.decode(constructorArgs[:32], (address));

        assembly ("memory-safe") {
            extcodecopy(store, add(initCode, 32), 0, codeLength)
            calldatacopy(add(add(initCode, 32), codeLength), constructorArgs.offset, expectedLength)
            irm := create(0, add(initCode, 32), mload(initCode))
        }
        if (irm == address(0)) revert CreationFailed();

        if (targetMorpho == morpho) {
            CurveYieldMorphoOwnerV3(governance).enableIrm(irm);
        }
        emit IrmCreated(templateId, irm, msg.sender, targetMorpho);
    }

    /// @notice Read-only metadata for the six automatically created bytecode stores.
    function setCallerFee(uint256 nextFeeWei) external onlyOwner {
        if (nextFeeWei > maxCallerFeeWei) revert ExcessiveCallerFee();
        uint256 oldFee = callerFeeWei;
        callerFeeWei = nextFeeWei;
        emit CallerFeeUpdated(oldFee, nextFeeWei);
    }

    function withdrawCallerFees(address payable receiver) external onlyOwner {
        if (receiver == address(0)) revert InvalidReceiver();
        uint256 amount = address(this).balance;
        (bool success,) = receiver.call{value: amount}("");
        if (!success) revert EthTransferFailed();
        emit CallerFeesWithdrawn(receiver, amount);
    }

    function creationCodeStore(uint8 templateId) external view returns (address) {
        if (templateId > 5) revert InvalidTemplate();
        return _creationCodeStores[templateId];
    }
}
