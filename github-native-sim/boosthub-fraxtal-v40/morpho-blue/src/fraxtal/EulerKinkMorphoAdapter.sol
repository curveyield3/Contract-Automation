// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IIrm} from "../interfaces/IIrm.sol";
import {MarketParams, Market} from "../interfaces/IMorpho.sol";

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
    uint256 public constant HARD_MAX_BORROW_APR = 5e18;

    address public immutable morpho;
    IEulerLinearKinkView public immutable eulerKinkIrm;
    uint256 public immutable maximumBorrowApr;

    constructor(address morpho_, address eulerKinkIrm_, uint256 maxBorrowApr_) {
        require(morpho_ != address(0) && morpho_.code.length != 0, "MORPHO_MISSING");
        require(eulerKinkIrm_ != address(0) && eulerKinkIrm_.code.length != 0, "EULER_IRM_MISSING");
        require(maxBorrowApr_ != 0 && maxBorrowApr_ <= HARD_MAX_BORROW_APR, "BAD_BORROW_CAP");
        // Verify this is an Euler linear-kink-compatible implementation.
        IEulerLinearKinkView irm = IEulerLinearKinkView(eulerKinkIrm_);
        require(irm.kink() <= type(uint32).max, "INVALID_EULER_KINK");
        irm.baseRate();
        irm.slope1();
        irm.slope2();

        morpho = morpho_;
        eulerKinkIrm = irm;
        maximumBorrowApr = maxBorrowApr_;
    }

    function borrowRate(MarketParams memory params, Market memory market) external view override returns (uint256) {
        require(msg.sender == morpho, "ONLY_MORPHO");
        require(params.irm == address(this), "IRM_MISMATCH");
        return _rate(market);
    }

    function borrowRateView(MarketParams memory params, Market memory market) external view override returns (uint256) {
        require(params.irm == address(this), "IRM_MISMATCH");
        return _rate(market);
    }

    function _rate(Market memory market) internal view returns (uint256) {
        uint256 supply = uint256(market.totalSupplyAssets);
        uint256 borrowed = uint256(market.totalBorrowAssets);
        uint256 cash = supply > borrowed ? supply - borrowed : 0;
        uint256 rayPerSecond = eulerKinkIrm.computeInterestRateView(morpho, cash, borrowed);
        uint256 wadPerSecond = rayPerSecond / 1e9;
        uint256 ceilingPerSecond = maximumBorrowApr / SECONDS_PER_YEAR;
        return wadPerSecond > ceilingPerSecond ? ceilingPerSecond : wadPerSecond;
    }
}
