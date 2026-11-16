// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IOracle} from "../interfaces/IOracle.sol";

/// @dev The signatures below are present in the user's v36 BoostHub stack.
interface IV36BeefyShare {
    function want() external view returns (address);
    function getPricePerFullShare() external view returns (uint256);
}

interface IV36OmniRouter {
    /// @notice Whole tokenOut / whole tokenIn, scaled 1e18, via configured historical-oracle route.
    function price_oracle(address tokenIn, address tokenOut) external view returns (uint256);
}

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/// @title OmniRouterBeefyShareOracle
/// @notice Morpho Blue collateral-share-to-loan-token oracle using the existing v36 OmniRouter.
/// @dev No extra price-feed network. One contract per loan token, shared collateral and router.
///      Morpho requires raw loan units/raw collateral-share units multiplied by 1e36.
contract OmniRouterBeefyShareOracle is IOracle {
    IV36BeefyShare public immutable collateralVault;
    IV36OmniRouter public immutable omniRouter;
    address public immutable underlying;
    address public immutable loanToken;
    uint256 public immutable wantScale;
    uint256 public immutable loanScale;

    constructor(address vault_, address router_, address loanToken_) {
        require(vault_ != address(0) && vault_.code.length != 0, "vault missing");
        require(router_ != address(0) && router_.code.length != 0, "router missing");
        require(loanToken_ != address(0) && loanToken_.code.length != 0, "loan missing");
        address want_ = IV36BeefyShare(vault_).want();
        require(want_ != address(0) && want_.code.length != 0, "want missing");
        uint8 wantDecimals = IERC20Decimals(want_).decimals();
        uint8 loanDecimals = IERC20Decimals(loanToken_).decimals();
        require(wantDecimals <= 36 && loanDecimals <= 36, "unsupported decimals");
        collateralVault = IV36BeefyShare(vault_);
        omniRouter = IV36OmniRouter(router_);
        underlying = want_;
        loanToken = loanToken_;
        wantScale = 10 ** uint256(wantDecimals);
        loanScale = 10 ** uint256(loanDecimals);
    }

    /// @inheritdoc IOracle
    function price() external view override returns (uint256) {
        uint256 pps = collateralVault.getPricePerFullShare();
        uint256 wholeTokenRate = omniRouter.price_oracle(underlying, loanToken);
        require(pps != 0 && wholeTokenRate != 0, "invalid oracle price");

        // v36 router rate = whole-loan / whole-want x 1e18.
        // v36 PPS = raw-want / raw-share x 1e18.
        // Morpho price = raw-loan / raw-share x 1e36.
        // Thus price = PPS * routerRate * (10^loanDecimals / 10^wantDecimals).
        // Division first rounds conservatively and avoids an unnecessary large product.
        uint256 convertedRate = wholeTokenRate * loanScale / wantScale;
        uint256 morphoPrice = pps * convertedRate;
        require(morphoPrice != 0, "price rounded to zero");
        return morphoPrice;
    }
}
