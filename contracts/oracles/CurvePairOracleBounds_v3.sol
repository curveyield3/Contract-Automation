// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface ICurvePoolV3 {
    function A() external view returns (uint256);
    function get_virtual_price() external view returns (uint256);
    function coins(uint256 index) external view returns (address);
}
interface IERC20DecimalsV3 {
    function decimals() external view returns (uint8);
}

/// @notice Approximate small one-coin StableSwap LP mint/burn quotes using historical
///         price_oracle, amplification A, and virtual price. No spot reserve/quote reads.
/// @dev Only for two-coin StableSwap variants with 18-decimal LP and ordinary
///      <=18 decimal coins. Does not model non-infinitesimal price impact or fees.
contract CurvePairOracleBoundsV3 {
    uint256 private constant WAD = 1e18;
    error InvalidCoin();
    error InvalidSlippage();
    error InvalidOracle();
    error InvalidAmplification();
    error InvalidVirtualPrice();
    error OracleUnavailable();
    error UnsupportedDecimals();
    error ImbalanceNotConverged();

    function quoteDeposit(address pool, uint8 coinIndex, uint256 amount, uint16 slippageBps)
        external view returns (uint256 estimate, uint256 minOut)
    {
        (uint256 derivative, uint256 vp, uint256 scale) = _read(pool, coinIndex, slippageBps);
        estimate = (amount * scale) * derivative / vp;
        minOut = estimate * (10_000 - slippageBps) / 10_000;
    }

    function quoteWithdraw(address pool, uint8 coinIndex, uint256 lpAmount, uint16 slippageBps)
        external view returns (uint256 estimate, uint256 minOut)
    {
        (uint256 derivative, uint256 vp, uint256 scale) = _read(pool, coinIndex, slippageBps);
        estimate = (lpAmount * vp / derivative) / scale;
        minOut = estimate * (10_000 - slippageBps) / 10_000;
    }

    function _read(address pool, uint8 coinIndex, uint16 slippageBps)
        private view returns (uint256 derivative, uint256 vp, uint256 scale)
    {
        if (coinIndex > 1) revert InvalidCoin();
        if (slippageBps >= 10_000) revert InvalidSlippage();
        // Factory two-coin plain: price_oracle(). StableSwap-NG: price_oracle(0).
        (bool ok, bytes memory data) = pool.staticcall(abi.encodeWithSignature("price_oracle()"));
        if (!ok || data.length != 32) {
            (ok, data) = pool.staticcall(abi.encodeWithSignature("price_oracle(uint256)", uint256(0)));
            if (!ok || data.length != 32) revert OracleUnavailable();
        }
        uint256 price = abi.decode(data, (uint256));
        if (price == 0) revert InvalidOracle();
        uint256 amp = ICurvePoolV3(pool).A();
        if (amp == 0 || amp > 1_000_000) revert InvalidAmplification();
        vp = ICurvePoolV3(pool).get_virtual_price();
        if (vp == 0) revert InvalidVirtualPrice();
        derivative = _marginal(price, amp, coinIndex);
        uint8 decimals = IERC20DecimalsV3(ICurvePoolV3(pool).coins(coinIndex)).decimals();
        if (decimals > 18) revert UnsupportedDecimals();
        scale = 10 ** (18 - decimals);
    }

    /// @dev Normalized 2-coin StableSwap invariant:
    ///      Ann=2*A, q=D^2/(4xy), s=(x+y)/D=1+(q-1)/Ann, k=Ann/(4q^2).
    ///      Historical oracle P=(x/D+k)/(y/D+k). Solve q>=1, then
    ///      dD/dx_i=(Ann+q/(x_i/D))/(Ann-1+3q).
    function _marginal(uint256 price, uint256 amp, uint8 coinIndex) private pure returns (uint256) {
        uint256 ann = 2 * amp;
        uint256 p = price <= WAD ? price : WAD * WAD / price;
        if (p == 0) revert InvalidOracle();
        uint256 skew = (WAD - p) * WAD / (WAD + p);
        uint256 q = WAD;
        if (skew != 0) {
            uint256 low = WAD;
            uint256 high = 2 * WAD;
            for (uint256 i; i < 48 && _tooLittle(high, skew, ann); ++i) high *= 2;
            if (_tooLittle(high, skew, ann)) revert ImbalanceNotConverged();
            for (uint256 j; j < 48; ++j) {
                uint256 mid = (low + high) / 2;
                if (_tooLittle(mid, skew, ann)) low = mid;
                else high = mid;
            }
            q = (low + high) / 2;
        }
        uint256 s = WAD + (q - WAD) / ann;
        uint256 inverseQ = WAD * WAD / q;
        uint256 k = ann * inverseQ * inverseQ / (4 * WAD);
        uint256 delta = skew * (s + 2*k) / WAD;
        if (delta >= s) revert ImbalanceNotConverged();
        uint256 small = (s - delta) / 2;
        uint256 large = (s + delta) / 2;
        uint256 reserve = (price <= WAD ? coinIndex == 0 : coinIndex == 1) ? small : large;
        if (reserve == 0) revert ImbalanceNotConverged();
        return (ann * WAD + q * WAD / reserve) * WAD / ((ann - 1) * WAD + 3*q);
    }

    function _tooLittle(uint256 q, uint256 skew, uint256 ann) private pure returns (bool) {
        uint256 s = WAD + (q - WAD) / ann;
        uint256 inverseQ = WAD * WAD / q;
        uint256 k = ann * inverseQ * inverseQ / (4 * WAD);
        uint256 delta = skew * (s + 2*k) / WAD;
        return delta * delta / WAD > s * s / WAD - inverseQ;
    }
}