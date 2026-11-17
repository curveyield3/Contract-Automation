// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

import {ICurveYieldMorphoCore} from "./CurveYieldMorphoOwnerAndSplitterV5.sol";

interface ICurveYieldMarketFactoryBinding {
    function morpho() external view returns (address);
    function governance() external view returns (address);
    function safe() external view returns (address);
}

/// @notice Safe-owned Morpho controller allowing replacement of the fee/market factory.
/// @dev Replaces Governor V3's permanently bound splitter; not a Safe module.
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
contract CurveYieldMorphoOwnerV5 {
    ICurveYieldMorphoCore public immutable morpho;
    address public immutable safe;
    address public marketFactory;
    mapping(address => bool) public approvedFactory;

    error Unauthorized();
    error InvalidAddress();
    error InvalidMarketFactory();

    event MarketFactoryConfigured(address indexed previous, address indexed next);
    event FactoryAuthorizationChanged(address indexed factory, bool enabled);

    modifier onlySafe() {
        if (msg.sender != safe) revert Unauthorized();
        _;
    }

    constructor(address morpho_, address safe_) {
        if (morpho_ == address(0) || safe_ == address(0) || morpho_.code.length == 0)
            revert InvalidAddress();
        morpho = ICurveYieldMorphoCore(morpho_);
        safe = safe_;
    }

    /// @notice Rotatable only by Safe, paired with setFeeRecipient in an atomic batch.
    function setMarketFactory(address nextFactory) external onlySafe {
        if (nextFactory.code.length == 0) revert InvalidMarketFactory();
        ICurveYieldMarketFactoryBinding next = ICurveYieldMarketFactoryBinding(nextFactory);
        if (next.morpho() != address(morpho) ||
            next.governance() != address(this) ||
            next.safe() != safe) revert InvalidMarketFactory();
        address prior = marketFactory;
        marketFactory = nextFactory;
        emit MarketFactoryConfigured(prior, nextFactory);
    }

    function setFee(ICurveYieldMorphoCore.MarketParams calldata params, uint256 newFee) external {
        if (msg.sender != safe && (msg.sender != marketFactory || marketFactory == address(0)))
            revert Unauthorized();
        if (msg.sender == marketFactory && morpho.feeRecipient() != marketFactory)
            revert Unauthorized();
        morpho.setFee(params, newFee);
    }

    function setFactory(address factory, bool enabled) external onlySafe {
        if (factory == address(0) || (enabled && factory.code.length == 0))
            revert InvalidAddress();
        approvedFactory[factory] = enabled;
        emit FactoryAuthorizationChanged(factory, enabled);
    }

    function enableIrm(address irm) external {
        if (msg.sender != safe && !approvedFactory[msg.sender]) revert Unauthorized();
        morpho.enableIrm(irm);
    }

    function enableLltv(uint256 lltv) external onlySafe {
        morpho.enableLltv(lltv);
    }

    function setFeeRecipient(address recipient) external onlySafe {
        morpho.setFeeRecipient(recipient);
    }

    function setOwner(address nextOwner) external onlySafe {
        morpho.setOwner(nextOwner);
    }
}
