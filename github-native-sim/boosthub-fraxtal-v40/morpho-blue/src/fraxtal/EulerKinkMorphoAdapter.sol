// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IIrm} from "../interfaces/IIrm.sol";
import {MarketParams, Market, Id} from "../interfaces/IMorpho.sol";

/// @dev Euler EVK IIRM rates are SPY (per-second) in RAY (1e27).
///      Only the stateless Euler IRMLinearKink is supported by this adapter.
///      Its computeInterestRateView has no msg.sender-vault authorization.
interface IEulerLinearKinkView {
    function computeInterestRateView(address vault, uint256 cash, uint256 borrows) external view returns (uint256);
    function baseRate() external view returns (uint256);
    function slope1() external view returns (uint256);
    function slope2() external view returns (uint256);
    function kink() external view returns (uint256);
}

/// @title EulerKinkMorphoAdapter
/// @notice Connects an existing *immutable* Euler IRMLinearKink deployment to an
///         unchanged Morpho Blue core without modifying either lending engine.
/// @dev Uses Euler's exact utilization curve through its view method.
///      The underlying Euler model is stateless; do NOT point this to an
///      Euler adaptive/stateful IRM because its update hook is not called.
///      Morpho's rate is 1e18-scaled per second, Euler returns 1e27 SPY.
contract EulerKinkMorphoAdapter is IIrm {
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant WAD = 1e18;
    uint256 public constant HARD_MAX_BORROW_APR = 3.65e18;
    uint256 public constant HARD_MAX_DAILY_CHANGE = 0.01e18;

    address public immutable morpho;
    IEulerLinearKinkView public immutable eulerKinkIrm;
    uint256 public immutable maximumBorrowApr;
    uint256 public immutable maximumDailyBorrowAprChange;
    mapping(Id => uint256) public lastBorrowApr;
    mapping(Id => uint256) public lastRateTimestamp;

    event BorrowRateBounded(Id indexed id, uint256 chargedApr, uint256 nextApr, uint256 observedApr);

    constructor(address morpho_, address eulerKinkIrm_, uint256 maxBorrowApr_, uint256 maxDailyChange_) {
        require(morpho_ != address(0) && morpho_.code.length != 0, "MORPHO_MISSING");
        require(eulerKinkIrm_ != address(0) && eulerKinkIrm_.code.length != 0, "EULER_IRM_MISSING");
        require(maxBorrowApr_ != 0 && maxBorrowApr_ <= HARD_MAX_BORROW_APR, "BAD_BORROW_CAP");
        require(maxDailyChange_ != 0 && maxDailyChange_ <= HARD_MAX_DAILY_CHANGE, "BAD_DAILY_CHANGE_CAP");
        // Verify this is an Euler linear-kink-compatible implementation.
        IEulerLinearKinkView irm = IEulerLinearKinkView(eulerKinkIrm_);
        require(irm.kink() <= type(uint32).max, "INVALID_EULER_KINK");
        irm.baseRate();
        irm.slope1();
        irm.slope2();

        morpho = morpho_;
        eulerKinkIrm = irm;
        maximumBorrowApr = maxBorrowApr_;
        maximumDailyBorrowAprChange = maxDailyChange_;
    }

    /// @notice Returns the preceding period's bounded rate to Morpho.
    /// Next period's APR is advanced by at most the configured daily delta.
    function borrowRate(MarketParams memory params, Market memory market) external override returns (uint256) {
        require(msg.sender == morpho, "ONLY_MORPHO");
        require(params.irm == address(this), "IRM_MISMATCH");
        Id id = Id.wrap(keccak256(abi.encode(params)));
        uint256 desiredApr = _desiredApr(market);
        uint256 nextApr = _boundedApr(id, desiredApr);
        uint256 chargedApr = lastRateTimestamp[id] == 0 ? nextApr : lastBorrowApr[id];
        lastBorrowApr[id] = nextApr;
        lastRateTimestamp[id] = block.timestamp;
        emit BorrowRateBounded(id, chargedApr, nextApr, desiredApr);
        return chargedApr / SECONDS_PER_YEAR;
    }

    /// @dev The rate used for pending Morpho accrual, NOT the next quote.
    function borrowRateView(MarketParams memory params, Market memory market) external view override returns (uint256) {
        require(params.irm == address(this), "IRM_MISMATCH");
        Id id = Id.wrap(keccak256(abi.encode(params)));
        return (lastRateTimestamp[id] == 0 ? _desiredApr(market) : lastBorrowApr[id]) / SECONDS_PER_YEAR;
    }

    function liveBorrowRateView(MarketParams memory params, Market memory market) external view returns (uint256) {
        require(params.irm == address(this), "IRM_MISMATCH");
        return _boundedApr(Id.wrap(keccak256(abi.encode(params))), _desiredApr(market)) / SECONDS_PER_YEAR;
    }

    /// @dev Bounded on every update and independent of transaction frequency.
    function _boundedApr(Id id, uint256 desiredApr) internal view returns (uint256) {
        if (desiredApr > maximumBorrowApr) desiredApr = maximumBorrowApr;
        uint256 last = lastRateTimestamp[id];
        if (last == 0) return desiredApr;
        uint256 previous = lastBorrowApr[id];
        uint256 step = maximumDailyBorrowAprChange * (block.timestamp - last) / 1 days;
        uint256 upper = previous + step;
        if (upper > maximumBorrowApr) upper = maximumBorrowApr;
        if (desiredApr > upper) return upper;
        uint256 lower = step > previous ? 0 : previous - step;
        return desiredApr < lower ? lower : desiredApr;
    }

    function _desiredApr(Market memory market) internal view returns (uint256) {
        uint256 supply = uint256(market.totalSupplyAssets);
        uint256 borrowed = uint256(market.totalBorrowAssets);
        uint256 cash = supply > borrowed ? supply - borrowed : 0;
        uint256 rayPerSecond = eulerKinkIrm.computeInterestRateView(morpho, cash, borrowed);
        // The original Euler IRM's 1e27-per-second rate is capped before
        // annualization. Prevent multiplication overflow on erroneous models.
        uint256 maxRayPerSecond = maximumBorrowApr * 1e9 / SECONDS_PER_YEAR;
        if (rayPerSecond > maxRayPerSecond) rayPerSecond = maxRayPerSecond;
        return rayPerSecond * SECONDS_PER_YEAR / 1e9;
    }
}
