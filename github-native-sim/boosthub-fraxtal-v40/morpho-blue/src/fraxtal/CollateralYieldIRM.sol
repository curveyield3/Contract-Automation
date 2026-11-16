// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IIrm} from "../interfaces/IIrm.sol";
import {IMorpho, MarketParams, Market, Id} from "../interfaces/IMorpho.sol";

interface IYieldBearingCollateral {
    function aprReady() external view returns (bool);
    function getAPR() external view returns (uint256);
}

/// @title FraxtalCollateralYieldIRM
/// @notice One stateful Morpho Blue IRM, independent utilization curves per isolated market.
/// @dev Multiplier values are WAD-scaled and may exceed 1e18 (100%). Borrow APR
///      follows the interpolation from minimum at U=0, target at target U, maximum at U=1.
///      sfrxUSD's absolute 4 percentage-point rebate is taken AFTER the multiplier.
///      Morpho accrues interest BEFORE market balance changes. The previous yield
///      observation is used for the elapsed period, and the fresh observation
///      becomes effective in the NEXT accrual interval.
contract CollateralYieldIRM is IIrm {
    uint256 public constant WAD = 1e18;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant MAX_MULTIPLIER = 10e18; // up to 1000% of collateral APR
    uint256 public constant MAX_CONFIG_APR = 5e18;  // safety ceiling, 500% annual APR
    uint256 public constant SFRXUSD_REBATE = 0.04e18;

    struct Curve {
        uint256 minimumMultiplier;
        uint256 targetMultiplier;
        uint256 maximumMultiplier;
        uint256 targetUtilization;
        uint256 aprRebate;
    }

    address public immutable morpho;
    address public owner;
    IYieldBearingCollateral public immutable yieldVault;
    uint256 public immutable fallbackCollateralApr;
    uint256 public immutable maximumCollateralApr;
    uint256 public immutable maximumBorrowApr;

    mapping(Id => Curve) public curves;
    mapping(Id => bool) public configured;
    mapping(Id => bool) public initialized;
    mapping(Id => uint256) public cachedCollateralApr;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event CurveConfigured(Id indexed marketId, uint256 minimum, uint256 target, uint256 maximum, uint256 utilization, uint256 rebate);
    event YieldObserved(Id indexed marketId, uint256 collateralApr);

    modifier onlyOwner() {
        require(msg.sender == owner, "NOT_OWNER");
        _;
    }

    constructor(address morpho_, address owner_, address vault_, uint256 fallbackApr_, uint256 collateralCap_, uint256 borrowCap_) {
        require(morpho_ != address(0) && morpho_.code.length != 0, "MORPHO_MISSING");
        require(owner_ != address(0), "OWNER_MISSING");
        require(vault_ != address(0) && vault_.code.length != 0, "VAULT_MISSING");
        require(collateralCap_ <= MAX_CONFIG_APR && fallbackApr_ <= collateralCap_, "BAD_COLLATERAL_BOUNDS");
        require(borrowCap_ <= MAX_CONFIG_APR && borrowCap_ != 0, "BAD_BORROW_CAP");
        morpho = morpho_;
        owner = owner_;
        yieldVault = IYieldBearingCollateral(vault_);
        fallbackCollateralApr = fallbackApr_;
        maximumCollateralApr = collateralCap_;
        maximumBorrowApr = borrowCap_;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "OWNER_ZERO");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Configure a market before creation or safely reconfigure a live one.
    /// @dev For a live market, settle the elapsed interest using the PRIOR curve first.
    ///      owner is the final governance/admin address, not necessarily Morpho's owner.
    function setCurve(MarketParams memory params, Curve memory curve) external onlyOwner {
        require(params.irm == address(this), "IRM_MISMATCH");
        require(params.collateralToken == address(yieldVault), "COLLATERAL_MISMATCH");
        require(curve.minimumMultiplier <= curve.targetMultiplier && curve.targetMultiplier <= curve.maximumMultiplier, "BAD_MULTIPLIERS");
        require(curve.maximumMultiplier <= MAX_MULTIPLIER, "MULTIPLIER_TOO_HIGH");
        require(curve.targetUtilization > 0 && curve.targetUtilization < WAD, "BAD_TARGET_UTILIZATION");
        require(curve.aprRebate <= WAD, "BAD_REBATE");
        Id id = _id(params);
        if (IMorpho(morpho).market(id).lastUpdate != 0) {
            IMorpho(morpho).accrueInterest(params);
        }
        curves[id] = curve;
        configured[id] = true;
        emit CurveConfigured(id, curve.minimumMultiplier, curve.targetMultiplier, curve.maximumMultiplier, curve.targetUtilization, curve.aprRebate);
    }

    function borrowRate(MarketParams memory params, Market memory market) external override returns (uint256) {
        require(msg.sender == morpho, "ONLY_MORPHO");
        Id id = _id(params);
        require(configured[id], "CURVE_NOT_CONFIGURED");
        uint256 previousApr = initialized[id] ? cachedCollateralApr[id] : _readCollateralApr();
        uint256 rate = _rate(previousApr, curves[id], market);
        uint256 newApr = _readCollateralApr();
        cachedCollateralApr[id] = newApr;
        initialized[id] = true;
        emit YieldObserved(id, newApr);
        return rate;
    }

    function borrowRateView(MarketParams memory params, Market memory market) external view override returns (uint256) {
        Id id = _id(params);
        require(configured[id], "CURVE_NOT_CONFIGURED");
        return _rate(initialized[id] ? cachedCollateralApr[id] : _readCollateralApr(), curves[id], market);
    }

    function liveBorrowRateView(MarketParams memory params, Market memory market) external view returns (uint256) {
        Id id = _id(params);
        require(configured[id], "CURVE_NOT_CONFIGURED");
        return _rate(_readCollateralApr(), curves[id], market);
    }

    function effectiveMultiplier(MarketParams memory params, Market memory market) external view returns (uint256) {
        Id id = _id(params);
        require(configured[id], "CURVE_NOT_CONFIGURED");
        return _multiplier(curves[id], _utilization(market));
    }

    function _id(MarketParams memory params) internal pure returns (Id) {
        return Id.wrap(keccak256(abi.encode(params)));
    }

    function _readCollateralApr() internal view returns (uint256 result) {
        result = fallbackCollateralApr;
        try yieldVault.aprReady() returns (bool ready) {
            if (ready) {
                try yieldVault.getAPR() returns (uint256 measured) { result = measured; } catch {}
            }
        } catch {}
        if (result > maximumCollateralApr) result = maximumCollateralApr;
    }

    function _utilization(Market memory market) internal pure returns (uint256) {
        if (market.totalSupplyAssets == 0) return 0;
        uint256 u = uint256(market.totalBorrowAssets) * WAD / uint256(market.totalSupplyAssets);
        return u > WAD ? WAD : u;
    }

    function _multiplier(Curve memory c, uint256 u) internal pure returns (uint256) {
        if (u <= c.targetUtilization) {
            return c.minimumMultiplier + (c.targetMultiplier - c.minimumMultiplier) * u / c.targetUtilization;
        }
        return c.targetMultiplier + (c.maximumMultiplier - c.targetMultiplier) * (u - c.targetUtilization) / (WAD - c.targetUtilization);
    }

    function _rate(uint256 collateralApr, Curve memory c, Market memory market) internal view returns (uint256) {
        uint256 borrowApr = collateralApr * _multiplier(c, _utilization(market)) / WAD;
        // Borrow APR cannot be negative. Rebate is an absolute APR percentage-point discount.
        borrowApr = borrowApr > c.aprRebate ? borrowApr - c.aprRebate : 0;
        if (borrowApr > maximumBorrowApr) borrowApr = maximumBorrowApr;
        return borrowApr / SECONDS_PER_YEAR;
    }
}
