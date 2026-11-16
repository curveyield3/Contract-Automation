// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IIrm} from "../interfaces/IIrm.sol";
import {MarketParams, Market} from "../interfaces/IMorpho.sol";
import {IIRM} from "./euler/IIRM.sol";

/// @notice Euler's adaptive model also exposes an update timestamp by vault.
interface IEulerAdaptiveModel is IIRM {
    function getLastUpdateTimestamp(address vault) external view returns (uint256);
    function TARGET_UTILIZATION() external view returns (int256);
}

/// @title EulerAdaptiveMorphoAdapterV1
/// @notice Morpho Blue adapter for the *stateful* Euler EVK IRMAdaptiveCurve.
/// @dev Deploy exactly one instance per Morpho market. The upstream Euler model
///      keys its adaptive state by "vault", which here MUST be this adapter.
///      Euler's state mutator requires msg.sender == vault; this adapter calls
///      computeInterestRate(address(this), ...) from Morpho's borrowRate hook.
///      No changes to the original Morpho Blue lending core are needed.
contract EulerAdaptiveMorphoAdapterV1 is IIrm {
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant HARD_MAX_BORROW_APR = 5e18; // 500%
    uint256 public constant HARD_MAX_DAILY_CHANGE = 0.50e18; // 50 APR pp / 24h

    address public immutable morpho;
    IEulerAdaptiveModel public immutable eulerAdaptiveIrm;
    bytes32 public immutable marketId;
    uint256 public immutable maximumBorrowApr;
    uint256 public immutable maximumDailyBorrowAprChange;
    uint256 public immutable aprRebate;

    uint256 public lastBorrowApr;
    uint256 public lastRateTimestamp;

    event BorrowRateBounded(
        bytes32 indexed id, uint256 chargedApr, uint256 nextApr, uint256 observedTargetApr
    );

    /// @param marketParams The target market's loan, collateral, oracle and LLTV;
    ///        marketParams.irm must be address(0) as the adapter's address is not
    ///        known before deployment. The constructor inserts address(this).
    /// @param rebate_ Absolute borrower APR rebate (e.g. 0.04e18 for sfrxUSD).
    constructor(
        address morpho_,
        address eulerAdaptiveIrm_,
        MarketParams memory marketParams,
        uint256 maxBorrowApr_,
        uint256 maxDailyChange_,
        uint256 rebate_
    ) {
        require(morpho_.code.length != 0, "MORPHO_MISSING");
        require(eulerAdaptiveIrm_.code.length != 0, "EULER_ADAPTIVE_MISSING");
        require(
            marketParams.loanToken.code.length != 0 &&
            marketParams.collateralToken.code.length != 0 &&
            marketParams.oracle.code.length != 0,
            "MARKET_DEPENDENCY_MISSING"
        );
        require(marketParams.irm == address(0), "IRM_MUST_BE_ZERO");
        require(marketParams.lltv > 0 && marketParams.lltv < 1e18, "BAD_LLTV");
        require(maxBorrowApr_ != 0 && maxBorrowApr_ <= HARD_MAX_BORROW_APR, "BAD_BORROW_CAP");
        require(maxDailyChange_ != 0 && maxDailyChange_ <= HARD_MAX_DAILY_CHANGE, "BAD_DAILY_CAP");
        require(rebate_ <= 1e18, "BAD_REBATE");

        IEulerAdaptiveModel irm = IEulerAdaptiveModel(eulerAdaptiveIrm_);
        int256 target = irm.TARGET_UTILIZATION();
        require(target > 0 && target < 1e18, "INVALID_EULER_MODEL");
        // This call rejects a non-adaptive Euler model that lacks its state API.
        require(irm.getLastUpdateTimestamp(address(this)) == 0, "MODEL_ALREADY_USED");

        morpho = morpho_;
        eulerAdaptiveIrm = irm;
        marketParams.irm = address(this);
        marketId = keccak256(abi.encode(marketParams));
        maximumBorrowApr = maxBorrowApr_;
        maximumDailyBorrowAprChange = maxDailyChange_;
        aprRebate = rebate_;
    }

    /// @notice Settle the previous interval at its previously established APR.
    ///         Advance the rate for the next interval using Euler's state hook.
    function borrowRate(MarketParams memory params, Market memory market)
        external override returns (uint256)
    {
        require(msg.sender == morpho, "ONLY_MORPHO");
        _checkMarket(params);

        uint256 observedApr = _toApr(_computeEulerRate(market));
        uint256 nextApr = _boundedApr(observedApr);
        uint256 chargedApr = lastRateTimestamp == 0 ? nextApr : lastBorrowApr;

        lastBorrowApr = nextApr;
        lastRateTimestamp = block.timestamp;
        emit BorrowRateBounded(marketId, chargedApr, nextApr, observedApr);

        return chargedApr / SECONDS_PER_YEAR; // Morpho WAD per second.
    }

    /// @notice APR used by the next Morpho accrual for the elapsed interval.
    function borrowRateView(MarketParams memory params, Market memory market)
        external view override returns (uint256)
    {
        _checkMarket(params);
        return (lastRateTimestamp == 0 ? _desiredApr(market) : lastBorrowApr) / SECONDS_PER_YEAR;
    }

    /// @notice Bounded APR that would become effective on the next accrual.
    function liveBorrowRateView(MarketParams memory params, Market memory market)
        external view returns (uint256)
    {
        _checkMarket(params);
        return _boundedApr(_desiredApr(market)) / SECONDS_PER_YEAR;
    }

    function _checkMarket(MarketParams memory params) internal view {
        require(keccak256(abi.encode(params)) == marketId, "MARKET_MISMATCH");
    }

    function _cash(Market memory market) private pure returns (uint256, uint256) {
        uint256 supply = uint256(market.totalSupplyAssets);
        uint256 borrowed = uint256(market.totalBorrowAssets);
        return (supply > borrowed ? supply - borrowed : 0, borrowed);
    }

    function _computeEulerRate(Market memory market) private returns (uint256) {
        (uint256 cash, uint256 borrowed) = _cash(market);
        // Euler's mutation authorization is msg.sender == vault == address(this).
        return eulerAdaptiveIrm.computeInterestRate(address(this), cash, borrowed);
    }

    function _desiredApr(Market memory market) private view returns (uint256) {
        (uint256 cash, uint256 borrowed) = _cash(market);
        return _toApr(eulerAdaptiveIrm.computeInterestRateView(address(this), cash, borrowed));
    }

    function _toApr(uint256 eulerRayPerSecond) private view returns (uint256) {
        // Euler rate is 1e27 per second; Morpho rate is 1e18 per second.
        // Clip BEFORE multiplying by seconds/year to prevent overflow.
        // Rebate is subtracted before enforcing the cap on *borrower* APR.
        uint256 upper = (maximumBorrowApr + aprRebate) * 1e9 / SECONDS_PER_YEAR;
        if (eulerRayPerSecond > upper) eulerRayPerSecond = upper;
        uint256 rawApr = eulerRayPerSecond * SECONDS_PER_YEAR / 1e9;
        uint256 charged = rawApr > aprRebate ? rawApr - aprRebate : 0;
        return charged > maximumBorrowApr ? maximumBorrowApr : charged;
    }

    function _boundedApr(uint256 desired) private view returns (uint256) {
        if (desired > maximumBorrowApr) desired = maximumBorrowApr;
        uint256 last = lastRateTimestamp;
        if (last == 0) return desired;

        uint256 previous = lastBorrowApr;
        uint256 step = maximumDailyBorrowAprChange * (block.timestamp - last) / 1 days;
        uint256 upper = previous + step;
        if (upper > maximumBorrowApr) upper = maximumBorrowApr;
        if (desired > upper) return upper;

        uint256 lower = step >= previous ? 0 : previous - step;
        return desired < lower ? lower : desired;
    }
}
