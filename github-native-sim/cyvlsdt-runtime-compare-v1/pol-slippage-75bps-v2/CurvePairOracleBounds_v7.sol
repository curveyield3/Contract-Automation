// SPDX-License-Identifier: GPL-2.0-or-later

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

pragma solidity ^0.8.30;

import "./UniV3TickMath_v6.sol";

interface ICurveBoundsPoolV6 {
    function A() external view returns (uint256);
    function get_virtual_price() external view returns (uint256);
    function coins(uint256 i) external view returns (address);
}
interface ITokenDecimalsV6 {
    function decimals() external view returns (uint8);
}

/// @notice Read-only Curve LP and Uniswap v3 NFT estimates with 0.75% maximum execution-loss tolerance.
/// @dev Supports 2-coin and 3-coin StableSwap-NG with historical oracle
///      prices and Curve-managed token normalization rates, plus two-coin
///      legacy StableSwap with price_oracle(), and CurveTwocryptoOptimized with its historical
///      price_oracle() and lp_price(). Does not read balances or spot quotes.
///      Curve quotes are MARGINAL estimates, not finite-size execution simulations.
///      Uniswap v3 uses a 300-second arithmetic tick TWAP (not slot0).
contract CurvePairOracleBoundsV7 {
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;
    uint256 private constant Q96 = 0x1000000000000000000000000;
    uint32 public constant UNI_V3_TWAP_SECONDS = 300;
    uint16 public constant UNI_V3_SLIPPAGE_BPS = 75;

    error NotSupported(address pool);
    error InvalidCoin();
    error InvalidSlippage();
    error InvalidOracle();
    error InvalidAmplification();
    error InvalidVirtualPrice();
    error UnsupportedDecimals();
    error ImbalanceNotConverged();
    error InvalidAmounts();
    error InvalidPercentage();
    error LiquidityOverflow();

    /// @notice Estimates LP minted, and a haircut minOut suitable for add_liquidity.
    /// @param coinIndex 0..N_COINS-1 (pool.coins); amount in token native decimals.
    function quoteDeposit(address pool, uint8 coinIndex, uint256 amount, uint16 slippageBps)
        external view returns (uint256 estimate, uint256 minOut)
    {
        _validate(coinIndex, slippageBps);
        if (_isCrypto(pool)) {
            if (coinIndex > 1) revert InvalidCoin();
            (uint256 oraclePrice, uint256 lpPrice, uint256 scale) = _readCrypto(pool, coinIndex);
            uint256 normalized = amount * scale;
            uint256 coin0Value = coinIndex == 0 ? normalized : normalized * oraclePrice / WAD;
            estimate = coin0Value * WAD / lpPrice;
        } else {
            (uint256 marginal, uint256 vp, uint256 rate) = _readStable(pool, coinIndex);
            estimate = (amount * rate / WAD) * marginal / vp;
        }
        minOut = estimate * (BPS - slippageBps) / BPS;
    }

    /// @notice Estimates native output tokens, and a haircut minOut suitable for remove_liquidity_one_coin.
    /// @param lpAmount LP amount in LP wei (18 decimals).
    function quoteWithdraw(address pool, uint8 coinIndex, uint256 lpAmount, uint16 slippageBps)
        external view returns (uint256 estimate, uint256 minOut)
    {
        _validate(coinIndex, slippageBps);
        if (_isCrypto(pool)) {
            if (coinIndex > 1) revert InvalidCoin();
            (uint256 oraclePrice, uint256 lpPrice, uint256 scale) = _readCrypto(pool, coinIndex);
            uint256 coin0Value = lpAmount * lpPrice / WAD;
            uint256 normalizedOut = coinIndex == 0 ? coin0Value : coin0Value * WAD / oraclePrice;
            estimate = normalizedOut / scale;
        } else {
            (uint256 marginal, uint256 vp, uint256 rate) = _readStable(pool, coinIndex);
            estimate = (lpAmount * vp / marginal) * WAD / rate;
        }
        minOut = estimate * (BPS - slippageBps) / BPS;
    }

    // Mirrors the 12-word ABI of Uniswap v3 NonfungiblePositionManager.positions().
    // Unused accounting fields are retained for ABI compatibility with standard forks.
    struct UniPosition {
        uint96 nonce;
        address operator;
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }

    /// @notice TWAP-prices the existing NFT principal (excluding fees owed/uncollected).
    /// @dev Only two inputs: position manager and NFT number. Both values are raw token units.
    function quoteUniV3Position(address positionManager, uint256 tokenId)
        external view returns (
            address token0, address token1, uint128 liquidity,
            uint256 amount0, uint256 amount1, uint256 minAmount0, uint256 minAmount1
        )
    {
        (UniPosition memory pos, uint160 sqrtP) = _uniPositionAndTwap(positionManager, tokenId);
        (amount0, amount1) = _uniAmounts(sqrtP, pos.tickLower, pos.tickUpper, pos.liquidity);
        token0 = pos.token0;
        token1 = pos.token1;
        liquidity = pos.liquidity;
        minAmount0 = amount0 * (BPS - UNI_V3_SLIPPAGE_BPS) / BPS;
        minAmount1 = amount1 * (BPS - UNI_V3_SLIPPAGE_BPS) / BPS;
    }

    /// @notice Quote withdrawing a percentage of the NFT's current principal liquidity.
    /// @param percentBps 1..10,000; 2500 = 25%, 10,000 = 100%.
    /// @dev The min amounts can be passed to NonfungiblePositionManager.decreaseLiquidity.
    ///      Does not include fees, already-owed tokens, or collection proceeds.
    function quoteUniV3Withdraw(address positionManager, uint256 tokenId, uint16 percentBps)
        external view returns (
            uint128 liquidityToBurn, uint256 amount0, uint256 amount1,
            uint256 minAmount0, uint256 minAmount1
        )
    {
        if (percentBps == 0 || percentBps > BPS) revert InvalidPercentage();
        (UniPosition memory pos, uint160 sqrtP) = _uniPositionAndTwap(positionManager, tokenId);
        liquidityToBurn = uint128(uint256(pos.liquidity) * percentBps / BPS);
        if (liquidityToBurn == 0) revert InvalidPercentage();
        (amount0, amount1) = _uniAmounts(sqrtP, pos.tickLower, pos.tickUpper, liquidityToBurn);
        minAmount0 = amount0 * (BPS - UNI_V3_SLIPPAGE_BPS) / BPS;
        minAmount1 = amount1 * (BPS - UNI_V3_SLIPPAGE_BPS) / BPS;
    }

    /// @notice Quote how much v3 liquidity can be added to an existing NFT position.
    /// @dev Desired token amounts are unavoidable inputs: the NFT doesn't reveal the
    ///      amount being newly deposited. Pool, fee and ticks are read from the NFT.
    ///      minLiquidity is for an integration's POST-CALL check: increaseLiquidity
    ///      only accepts amount0Min/amount1Min, not a minLiquidity parameter.
    function quoteUniV3Deposit(
        address positionManager, uint256 tokenId,
        uint256 amount0Desired, uint256 amount1Desired
    ) external view returns (
        uint128 estimatedLiquidity, uint128 minLiquidity,
        uint256 amount0Used, uint256 amount1Used,
        uint256 minAmount0Used, uint256 minAmount1Used
    ) {
        if (amount0Desired == 0 && amount1Desired == 0) revert InvalidAmounts();
        (UniPosition memory pos, uint160 sqrtP) = _uniPositionAndTwap(positionManager, tokenId);
        uint256 newLiquidity = _uniLiquidityForAmounts(
            sqrtP, pos.tickLower, pos.tickUpper, amount0Desired, amount1Desired
        );
        if (newLiquidity == 0 || newLiquidity > type(uint128).max) revert LiquidityOverflow();
        estimatedLiquidity = uint128(newLiquidity);
        minLiquidity = uint128(newLiquidity * (BPS - UNI_V3_SLIPPAGE_BPS) / BPS);
        (amount0Used, amount1Used) = _uniAmounts(sqrtP, pos.tickLower, pos.tickUpper, estimatedLiquidity);
        minAmount0Used = amount0Used * (BPS - UNI_V3_SLIPPAGE_BPS) / BPS;
        minAmount1Used = amount1Used * (BPS - UNI_V3_SLIPPAGE_BPS) / BPS;
    }

    /// @dev Read the NFT's original factory/pool without using the current spot price.
    ///      Unsupported forks and pools without enough 300s oracle history fail closed.
    function _uniPositionAndTwap(address manager, uint256 tokenId)
        private view returns (UniPosition memory pos, uint160 sqrtP)
    {
        if (manager.code.length == 0) revert NotSupported(manager);
        (bool ok, bytes memory data) = manager.staticcall(
            abi.encodeWithSignature("positions(uint256)", tokenId)
        );
        if (!ok || data.length != 12 * 32) revert NotSupported(manager);
        pos = abi.decode(data, (UniPosition));
        if (pos.token0 == address(0) || pos.token1 == address(0) ||
            pos.token0 >= pos.token1 || pos.tickLower >= pos.tickUpper ||
            pos.tickLower < -887272 || pos.tickUpper > 887272 || pos.fee == 0) revert NotSupported(manager);

        (ok, data) = manager.staticcall(abi.encodeWithSignature("factory()"));
        if (!ok || data.length != 32) revert NotSupported(manager);
        address factory = abi.decode(data, (address));
        if (factory.code.length == 0) revert NotSupported(manager);
        (ok, data) = factory.staticcall(abi.encodeWithSignature(
            "getPool(address,address,uint24)", pos.token0, pos.token1, pos.fee
        ));
        if (!ok || data.length != 32) revert NotSupported(manager);
        address pool = abi.decode(data, (address));
        if (pool.code.length == 0) revert NotSupported(manager);

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = UNI_V3_TWAP_SECONDS;
        secondsAgos[1] = 0;
        (ok, data) = pool.staticcall(abi.encodeWithSignature("observe(uint32[])", secondsAgos));
        if (!ok || data.length < 128) revert NotSupported(pool);
        (int56[] memory cumulatives,) = abi.decode(data, (int56[], uint160[]));
        if (cumulatives.length != 2) revert NotSupported(pool);
        int56 tickDelta = cumulatives[1] - cumulatives[0];
        int56 duration = int56(uint56(UNI_V3_TWAP_SECONDS));
        int56 avgTick = tickDelta / duration;
        // Uniswap OracleLibrary uses mathematical floor for negative averages.
        if (tickDelta < 0 && tickDelta % duration != 0) --avgTick;
        if (avgTick < -887272 || avgTick > 887272) revert NotSupported(pool);
        sqrtP = UniV3TickMathV6.getSqrtRatioAtTick(int24(avgTick));
    }

    function _uniAmounts(uint160 sqrtP, int24 lower, int24 upper, uint128 liquidity)
        private pure returns (uint256 a0, uint256 a1)
    {
        uint160 sqrtA = UniV3TickMathV6.getSqrtRatioAtTick(lower);
        uint160 sqrtB = UniV3TickMathV6.getSqrtRatioAtTick(upper);
        if (sqrtP <= sqrtA) {
            a0 = _uniAmount0(sqrtA, sqrtB, liquidity);
        } else if (sqrtP < sqrtB) {
            a0 = _uniAmount0(sqrtP, sqrtB, liquidity);
            a1 = _uniAmount1(sqrtA, sqrtP, liquidity);
        } else {
            a1 = _uniAmount1(sqrtA, sqrtB, liquidity);
        }
    }

    function _uniLiquidityForAmounts(uint160 sqrtP, int24 lower, int24 upper, uint256 a0, uint256 a1)
        private pure returns (uint256 liquidity)
    {
        uint160 sqrtA = UniV3TickMathV6.getSqrtRatioAtTick(lower);
        uint160 sqrtB = UniV3TickMathV6.getSqrtRatioAtTick(upper);
        if (sqrtP <= sqrtA) return _uniLiquidity0(sqrtA, sqrtB, a0);
        if (sqrtP >= sqrtB) return _uniLiquidity1(sqrtA, sqrtB, a1);
        uint256 l0 = _uniLiquidity0(sqrtP, sqrtB, a0);
        uint256 l1 = _uniLiquidity1(sqrtA, sqrtP, a1);
        return l0 < l1 ? l0 : l1;
    }

    function _uniAmount0(uint160 sqrtA, uint160 sqrtB, uint128 liquidity)
        private pure returns (uint256)
    {
        return _mulDiv(uint256(liquidity) << 96, sqrtB - sqrtA, sqrtB) / sqrtA;
    }

    function _uniAmount1(uint160 sqrtA, uint160 sqrtB, uint128 liquidity)
        private pure returns (uint256)
    {
        return _mulDiv(uint256(liquidity), sqrtB - sqrtA, Q96);
    }

    function _uniLiquidity0(uint160 sqrtA, uint160 sqrtB, uint256 amount0)
        private pure returns (uint256)
    {
        uint256 intermediate = _mulDiv(sqrtA, sqrtB, Q96);
        return _mulDiv(amount0, intermediate, sqrtB - sqrtA);
    }

    function _uniLiquidity1(uint160 sqrtA, uint160 sqrtB, uint256 amount1)
        private pure returns (uint256)
    {
        return _mulDiv(amount1, Q96, sqrtB - sqrtA);
    }

    /// @dev 512-bit mulDiv, derived from the MIT-licensed OpenZeppelin Math implementation.
    function _mulDiv(uint256 a, uint256 b, uint256 denominator)
        private pure returns (uint256 result)
    {
        if (denominator == 0) revert InvalidAmounts();
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) return prod0 / denominator;
            if (denominator <= prod1) revert LiquidityOverflow();
            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = denominator & (0 - denominator);
            assembly {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inverse = (3 * denominator) ^ 2;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            result = prod0 * inverse;
        }
    }

    function _validate(uint8 coinIndex, uint16 slippageBps) private pure {
        if (coinIndex > 2) revert InvalidCoin();
        if (slippageBps > 75) revert InvalidSlippage();
    }

    /// @dev Distinguish CryptoSwap from StableSwap by its gamma() ABI.
    ///      A gamma-equipped, non-Twocrypto pool is rejected by _readCrypto.
    function _isCrypto(address pool) private view returns (bool) {
        (bool ok, bytes memory data) = pool.staticcall(abi.encodeWithSignature("gamma()"));
        return ok && data.length == 32;
    }

    /// @dev Reads no live pool balances, no price_scale, and no spot quotes.
    ///      CurveTwocryptoOptimized.lp_price() uses historical price_oracle()
    ///      and the pool's cached virtual price: 2*VP*sqrt(oracle_price).
    function _readCrypto(address pool, uint8 coinIndex)
        private view returns (uint256 oraclePrice, uint256 lpPrice, uint256 scale)
    {
        // Three-coin CryptoSwap and other crypto variants are not supported.
        (bool thirdOk, bytes memory third) = pool.staticcall(abi.encodeWithSignature("coins(uint256)", 2));
        if (thirdOk && third.length == 32 && abi.decode(third, (address)) != address(0)) {
            revert NotSupported(pool);
        }
        (bool ok, bytes memory data) = pool.staticcall(abi.encodeWithSignature("price_oracle()"));
        if (!ok || data.length != 32) revert NotSupported(pool);
        oraclePrice = abi.decode(data, (uint256));
        (ok, data) = pool.staticcall(abi.encodeWithSignature("lp_price()"));
        if (!ok || data.length != 32) revert NotSupported(pool);
        lpPrice = abi.decode(data, (uint256));
        if (oraclePrice == 0 || lpPrice == 0) revert InvalidOracle();
        scale = _decimalsScale(pool, coinIndex);
    }

    /// @dev Plain StableSwap pools only; nested metapools and pools without a
    ///      historical price oracle fail closed. NG stored_rates includes
    ///      Curve-managed PPS/redemption oracles and decimal normalization.
    function _readStable(address pool, uint8 coinIndex)
        private view returns (uint256 marginal, uint256 vp, uint256 rate)
    {
        (bool metaOk, bytes memory metaData) = pool.staticcall(abi.encodeWithSignature("BASE_POOL()"));
        if (metaOk && metaData.length == 32 && abi.decode(metaData, (address)) != address(0))
            revert NotSupported(pool);
        (metaOk, metaData) = pool.staticcall(abi.encodeWithSignature("base_pool()"));
        if (metaOk && metaData.length == 32 && abi.decode(metaData, (address)) != address(0))
            revert NotSupported(pool);

        (bool nOk, bytes memory nData) = pool.staticcall(abi.encodeWithSignature("N_COINS()"));
        uint256 n = nOk && nData.length == 32 ? abi.decode(nData, (uint256)) : 2;
        if (n != 2 && n != 3) revert NotSupported(pool);
        (bool thirdOk, bytes memory thirdData) = pool.staticcall(abi.encodeWithSignature("coins(uint256)", 2));
        bool hasThird = thirdOk && thirdData.length == 32 && abi.decode(thirdData, (address)) != address(0);
        if (hasThird != (n == 3) || coinIndex >= n) revert NotSupported(pool);

        uint256 amp;
        (bool ok, bytes memory data) = pool.staticcall(abi.encodeWithSignature("A()"));
        if (!ok || data.length != 32) revert NotSupported(pool);
        amp = abi.decode(data, (uint256));
        if (amp == 0 || amp > 1_000_000) revert InvalidAmplification();
        (ok, data) = pool.staticcall(abi.encodeWithSignature("get_virtual_price()"));
        if (!ok || data.length != 32) revert NotSupported(pool);
        vp = abi.decode(data, (uint256));
        if (vp == 0) revert InvalidVirtualPrice();

        if (n == 3) {
            // A 3-coin plain NG pool exposes exactly two relative price EMAs.
            // Coin0 is the reference; coin1 and coin2 are p[0] and p[1].
            uint256[2] memory prices;
            for (uint256 i; i < 2; ++i) {
                (ok, data) = pool.staticcall(abi.encodeWithSignature("price_oracle(uint256)", i));
                if (!ok || data.length != 32) revert NotSupported(pool);
                prices[i] = abi.decode(data, (uint256));
                if (prices[i] == 0) revert InvalidOracle();
            }
            marginal = _marginalThree(prices, amp, coinIndex);
        } else {
            (ok, data) = pool.staticcall(abi.encodeWithSignature("price_oracle()"));
            if (!ok || data.length != 32)
                (ok, data) = pool.staticcall(abi.encodeWithSignature("price_oracle(uint256)", 0));
            if (!ok || data.length != 32) revert NotSupported(pool);
            uint256 price = abi.decode(data, (uint256));
            if (price == 0) revert InvalidOracle();
            marginal = _marginal(price, amp, coinIndex);
        }

        (ok, data) = pool.staticcall(abi.encodeWithSignature("stored_rates()"));
        if (ok && data.length >= 128) {
            uint256[] memory rates = abi.decode(data, (uint256[]));
            if (rates.length != n) revert NotSupported(pool);
            rate = rates[coinIndex];
        } else {
            // StableSwap-NG 3-coin pools must supply their own effective rates.
            if (n == 3) revert NotSupported(pool);
            rate = _decimalsScale(pool, coinIndex) * WAD;
        }
        if (rate == 0) revert InvalidOracle();
    }

    function _decimalsScale(address pool, uint8 coinIndex) private view returns (uint256) {
        uint8 d = ITokenDecimalsV6(ICurveBoundsPoolV6(pool).coins(coinIndex)).decimals();
        if (d > 18) revert UnsupportedDecimals();
        return 10 ** (18 - d);
    }

    /// @dev 2-coin StableSwap derivative evaluated at the historical oracle-implied imbalance.
    ///      q=D^2/(4xy), s=(x+y)/D, k=Ann/(4q^2), Ann=2*A.
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

    /// @dev Reconstruct three-coin StableSwap marginal conversion from two
    ///      historical normalized prices. Uses one scalar root, no balances.
    ///      Ann=3*A, q=D^3/(27*x0*x1*x2), u_i=x_i/D.
    ///      Define t=q/u0 and d_i=q/u_i = P_i*(Ann+t)-Ann.
    ///      The invariant implies q=(Ann-1)/(Ann*sum(1/d_i)-1).
    ///      The product constraint is q^4=(d0*d1*d2)/27.
    ///      Marginal dD/dx_i=(Ann+d_i)/(Ann-1+4*q).
    function _marginalThree(uint256[2] memory prices, uint256 amp, uint8 coinIndex)
        private pure returns (uint256)
    {
        uint256 ann = 3 * amp;
        uint256 lower = WAD; // always positive
        for (uint256 i; i < 2; ++i) {
            // d_(i+1) must remain strictly positive.
            if (prices[i] < WAD) {
                uint256 threshold = _mulDiv(ann * (WAD - prices[i]), WAD, prices[i]);
                if (threshold >= lower) lower = threshold + 1e9;
            }
        }
        uint256 upper = lower > 3 * WAD ? lower * 2 : 6 * WAD;
        bool bracketed;
        for (uint256 k; k < 48; ++k) {
            if (!_threeBelow(upper, ann, prices)) {
                bracketed = true;
                break;
            }
            if (upper > 1e12 * WAD) revert ImbalanceNotConverged();
            upper *= 2;
        }
        if (!bracketed) revert ImbalanceNotConverged();
        for (uint256 j; j < 64; ++j) {
            uint256 mid = lower + (upper - lower) / 2;
            if (_threeBelow(mid, ann, prices)) lower = mid;
            else upper = mid;
        }
        (uint256 q, uint256[3] memory ds) = _threeRootState(
            lower + (upper - lower) / 2, ann, prices
        );
        if (q == 0 || q >= 1e8 * WAD) revert ImbalanceNotConverged();
        return _mulDiv(ann * WAD + ds[coinIndex], WAD, (ann - 1) * WAD + 4 * q);
    }

    function _threeBelow(uint256 t, uint256 ann, uint256[2] memory prices)
        private pure returns (bool)
    {
        (uint256 q, uint256[3] memory ds) = _threeRootState(t, ann, prices);
        if (q == type(uint256).max || q >= 1e8 * WAD) return false;
        uint256 q2 = _mulDiv(q, q, WAD);
        uint256 q4 = _mulDiv(q2, q2, WAD);
        uint256 prod = _mulDiv(_mulDiv(ds[0], ds[1], WAD), ds[2], 27 * WAD);
        return q4 < prod;
    }

    function _threeRootState(uint256 t, uint256 ann, uint256[2] memory prices)
        private pure returns (uint256 q, uint256[3] memory ds)
    {
        uint256 base = ann * WAD;
        ds[0] = t;
        for (uint256 i; i < 2; ++i) {
            uint256 valued = _mulDiv(base + t, prices[i], WAD);
            if (valued <= base) return (0, ds);
            ds[i + 1] = valued - base;
        }
        uint256 sumInv = WAD * WAD / ds[0] + WAD * WAD / ds[1] + WAD * WAD / ds[2];
        if (ann * sumInv <= WAD) return (type(uint256).max, ds);
        q = _mulDiv((ann - 1) * WAD, WAD, ann * sumInv - WAD);
    }

    function _tooLittle(uint256 q, uint256 skew, uint256 ann) private pure returns (bool) {
        uint256 s = WAD + (q - WAD) / ann;
        uint256 inverseQ = WAD * WAD / q;
        uint256 k = ann * inverseQ * inverseQ / (4 * WAD);
        uint256 delta = skew * (s + 2*k) / WAD;
        return delta * delta / WAD > s * s / WAD - inverseQ;
    }
}
