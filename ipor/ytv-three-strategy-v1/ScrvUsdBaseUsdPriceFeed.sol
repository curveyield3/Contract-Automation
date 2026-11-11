// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

interface IScrvUsdBaseRateOracle {
    function price_oracle() external view returns (uint256);
}
interface ICurveStableSwapNGBase {
    function price_oracle(uint256 i) external view returns (uint256);
}
interface IIPORUsdPriceMiddleware {
    function getAssetPrice(address asset) external view returns (uint256 price, uint256 decimals_);
}

/// @notice scrvUSD/USD adapter for Base, intended as a source in IPOR PriceOracleMiddlewareManager.
/// @dev Uses Curve's cross-chain scrvUSD rate (crvUSD per scrvUSD), the pool's EMA
/// of crvUSD-equivalent/USDC, and IPOR's existing independent USDC/USD oracle.
/// No dependency on the wrapper's caller; latestRoundData works from external EOAs.
/// The Curve pool has coin0 USDC and coin1 bridged scrvUSD.
contract ScrvUsdBaseUsdPriceFeed {
    using SafeCast for uint256;

    address public constant SCRVUSD_RATE_ORACLE = 0x3d8EADb739D1Ef95dd53D718e4810721837c69c1;
    address public constant CURVE_POOL = 0x5aB01ee6208596f2204B85bDFA39d34c2aDD98F6;
    address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address public constant IPOR_GLOBAL_MIDDLEWARE = 0xD9b73Af0b29Cbaf88F01384EA1fB5ADcb608bed0;

    error InvalidSourcePrice();

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        uint256 shareRate = IScrvUsdBaseRateOracle(SCRVUSD_RATE_ORACLE).price_oracle();
        uint256 poolEma = ICurveStableSwapNGBase(CURVE_POOL).price_oracle(0);
        (uint256 usdcPrice, uint256 usdcPriceDecimals) =
            IIPORUsdPriceMiddleware(IPOR_GLOBAL_MIDDLEWARE).getAssetPrice(USDC);
        if (shareRate == 0 || poolEma == 0 || usdcPrice == 0 || usdcPriceDecimals > 36) {
            revert InvalidSourcePrice();
        }
        uint256 crvUsdEquivalentPerScrvUsd = Math.mulDiv(shareRate, poolEma, 1e18);
        uint256 scrvUsdUsd = Math.mulDiv(crvUsdEquivalentPerScrvUsd, usdcPrice, 10 ** usdcPriceDecimals);
        if (scrvUsdUsd == 0) revert InvalidSourcePrice();
        return (0, scrvUsdUsd.toInt256(), 0, 0, 0);
    }
}
