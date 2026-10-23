// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FullMath} from "./lib/FullMath.sol";
import {TickMath} from "./lib/TickMath.sol";

/// @title RangeMath
/// @notice Stateless concentrated-liquidity planner, valuation, and precise multiplication.
/// @dev No ownership, custody, storage, or external interactions. Arithmetic matches original RangeManager.
contract RangeMath {
    function exactToken0Value(uint256 a0, uint160 sp) external pure returns (uint256) {
        return _exactToken0Value(a0, sp);
    }
    function planRangeSwap(uint160 sp, int24 lo, int24 hi, uint256 a0, uint256 a1, uint24 fee)
        external pure returns (bool sellToken0, uint256 amountIn)
    {
        (uint256 u0, uint256 u1) = _rangeUnitAmounts(sp, lo, hi);
        uint256 w0 = _exactToken0Value(u0, sp);
        if (w0 + u1 == 0) return (false, 0);
        uint256 s0 = FullMath.mulDiv(w0, 1e18, w0 + u1);
        uint256 v0 = _exactToken0Value(a0, sp);
        uint256 want0 = FullMath.mulDiv(v0 + a1, s0, 1e18);
        uint256 f = uint256(fee) * 1e12;
        if (v0 > want0) {
            uint256 x0 = FullMath.mulDiv(a0, FullMath.mulDiv(v0 - want0, 1e18,
                1e18 - FullMath.mulDiv(s0, f, 1e18)), v0);
            if (x0 > a0) x0 = a0;
            return (true, x0);
        } else if (want0 > v0) {
            uint256 x1 = FullMath.mulDiv(want0 - v0, 1e18,
                1e18 - FullMath.mulDiv(f, 1e18 - s0, 1e18));
            if (x1 > a1) x1 = a1;
            return (false, x1);
        }
        return (false, 0);
    }
    function exactMulDiv(uint256 a, uint256 b, uint256 denominator) external pure returns (uint256) {
        return FullMath.mulDiv(a, b, denominator);
    }
    function _exactToken0Value(uint256 a0, uint160 sp) private pure returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(a0, sp, 1 << 96), sp, 1 << 96);
    }
    function _rangeUnitAmounts(uint160 sp, int24 lo, int24 hi) private pure
        returns (uint256 a0, uint256 a1)
    {
        uint160 sa = TickMath.getSqrtRatioAtTick(lo);
        uint160 sb = TickMath.getSqrtRatioAtTick(hi);
        uint256 liq = 1e18;
        if (sp <= sa) a0 = FullMath.mulDiv(liq << 96, sb - sa, sb) / sa;
        else if (sp < sb) (a0, a1) = (
            FullMath.mulDiv(liq << 96, sb - sp, sb) / sp,
            FullMath.mulDiv(liq, sp - sa, 1 << 96)
        );
        else a1 = FullMath.mulDiv(liq, sb - sa, 1 << 96);
    }
}
