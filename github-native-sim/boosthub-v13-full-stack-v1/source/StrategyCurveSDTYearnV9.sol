// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title StrategyCurveSDTYearnV9
 * @notice SDT -> Curve SDT/WETH LP -> constructor-selected CurveGlobal factory Yearn V2 vault.
 * @dev Uses the ORIGINAL, unmodified BeefyVaultV7FixedV2 from BoostHub v57.
 *      The Beefy vault mints shares against the actual NAV change after deposit(),
 *      so the depositor bears the entry conversion cost, not existing shareholders.
 *      balanceOf() quotes the SDT obtainable by redeeming held LP and Yearn V2 shares;
 *      this already includes Curve's one-sided exit fee in the share value.
 *
 *      The original vault independently charges its immutable withdrawal fee
 *      (deploy with 50 bps), with its original 30/70 fee split and
 *      100% administrator payment on the final share withdrawal.
 *      No synthetic NAV markup, levy, or insurance reserve.
 *
 *      Curve LP execution is protected by the external historical-oracle
 *      bounds guard at 2%; the returned minimums are passed to Curve.
 *      External Yearn redemption liquidity, Curve execution and asset price
 *      changes remain beyond the strategy's control. The original vault itself
 *      reverts on any gross SDT withdrawal shortfall, zero-share deposit, etc.
 */
import "@openzeppelin-4/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin-4/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin-4/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin-4/contracts/utils/math/Math.sol";

interface ICurveSDTWETHV6 {
    function coins(uint256 i) external view returns (address);
    function calc_withdraw_one_coin(uint256 lpShares, uint256 i) external view returns (uint256);
    function add_liquidity(uint256[2] calldata amounts, uint256 minLp) external returns (uint256);
    function remove_liquidity_one_coin(uint256 lpShares, uint256 i, uint256 minSDT) external returns (uint256);
}

interface ICurveLiquidityBoundsSDTV7 {
    function quoteDeposit(address pool, uint8 coinIndex, uint256 amount, uint16 slippageBps)
        external view returns (uint256 estimate, uint256 minOut);
    function quoteWithdraw(address pool, uint8 coinIndex, uint256 lpAmount, uint16 slippageBps)
        external view returns (uint256 estimate, uint256 minOut);
}

/// @notice Yearn V2 Vault (the actual vault type deployed by CurveGlobal/Yearn registry).
/// @dev Not ERC4626. It exposes token(), pricePerShare() and SHARE-denominated withdraw().
interface IYearnSDTLPV9 is IERC20 {
    function token() external view returns (address);
    function pricePerShare() external view returns (uint256);
    function decimals() external view returns (uint256);
    function deposit(uint256 amount, address recipient) external returns (uint256);
    function withdraw(uint256 maxShares, address recipient, uint256 maxLoss) external returns (uint256);
}

interface IBeefySDTVaultV6 {
    function totalSupply() external view returns (uint256);
    function withdrawalFeeBps() external view returns (uint256);
    function adminFeeReceiver() external view returns (address);
}

contract StrategyCurveSDTYearnV9 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant SDT = 0x73968b9a57c6E53d41345FD57a6E6ae27d6CDB2F;
    address public constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address public constant CURVE_LP = 0xA19bf6fBf05624282cb6ed498f4761f22e084Edd;
    uint8 private constant SDT_INDEX = 1;
    uint16 public constant CURVE_LP_SLIPPAGE_BPS = 200; // 2% supplied to the external guard.

    address public immutable vault;
    address public immutable want;
    ICurveSDTWETHV6 public immutable curve;
    IYearnSDTLPV9 public immutable yearn;
    ICurveLiquidityBoundsSDTV7 public immutable curveLiquidityGuard;
    IERC20 private immutable sdt;
    IERC20 private immutable lp;
    uint256 private immutable yearnShareUnit;

    event Invested(uint256 sdtIn, uint256 curveLpOut, uint256 yearnSharesOut);
    event Withdrawn(uint256 grossSDT, uint256 lpBurned, uint256 yearnSharesBurned);
    event InvestmentDeferred(uint8 reason);

    error NotVault();
    error BadDependency();
    error InsufficientRedemptionLiquidity();

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    /// @param vault_ Expected address of the ORIGINAL BeefyVaultV7FixedV2 (deploy strategy first).
    /// @param yearn_ Yearn V2 vault returned by CurveGlobal.createNewVaultsAndStrategies() for SDT/WETH LP.
    /// @param curveGuard_ Existing CurvePairOracleBoundsV6 deployment used for guarded Curve liquidity.
    constructor(address vault_, address yearn_, address curveGuard_) {
        if (block.chainid != 1 || vault_ == address(0) || yearn_.code.length == 0
            || curveGuard_.code.length == 0 || CURVE_LP.code.length == 0) {
            revert BadDependency();
        }
        ICurveSDTWETHV6 pool = ICurveSDTWETHV6(CURVE_LP);
        if (pool.coins(0) != WETH || pool.coins(SDT_INDEX) != SDT || IYearnSDTLPV9(yearn_).token() != CURVE_LP) {
            revert BadDependency();
        }
        vault = vault_;
        want = SDT;
        curve = pool;
        yearn = IYearnSDTLPV9(yearn_);
        uint256 shareDecimals = IYearnSDTLPV9(yearn_).decimals();
        if (shareDecimals > 30) revert BadDependency();
        yearnShareUnit = 10 ** shareDecimals;
        curveLiquidityGuard = ICurveLiquidityBoundsSDTV7(curveGuard_);
        sdt = IERC20(SDT);
        lp = IERC20(CURVE_LP);
        sdt.forceApprove(CURVE_LP, type(uint256).max);
        lp.forceApprove(yearn_, type(uint256).max);
    }

    /// @dev Yearn V2 shares use pricePerShare, scaled by the vault share decimals.
    ///      The V2 vault does not implement ERC4626 previewRedeem.
    function _yearnSharesToLp(uint256 shares) private view returns (uint256) {
        return shares == 0 ? 0 : Math.mulDiv(shares, yearn.pricePerShare(), yearnShareUnit);
    }

    function totalCurveLp() public view returns (uint256) {
        return lp.balanceOf(address(this)) + _yearnSharesToLp(yearn.balanceOf(address(this)));
    }

    /** @notice Realizable SDT quote for the entire position, including one-sided Curve exit fees. */
    function balanceOf() public view returns (uint256) {
        uint256 lpAssets = totalCurveLp();
        return sdt.balanceOf(address(this)) +
            (lpAssets == 0 ? 0 : curve.calc_withdraw_one_coin(lpAssets, SDT_INDEX));
    }

    /// @notice The parent's post-investment delta NAV share minting charges entry costs to the depositor.
    /// @dev Guarded Curve operations revert on a failed oracle or minimum. A Yearn
    ///      deposit failure may leave LP idle, which remains included in NAV.
    function deposit() external onlyVault nonReentrant {
        uint256 amount = sdt.balanceOf(address(this));
        if (amount != 0) {
            uint256[2] memory amounts = [uint256(0), amount];
            (, uint256 minLpOut) = curveLiquidityGuard.quoteDeposit(
                CURVE_LP, SDT_INDEX, amount, CURVE_LP_SLIPPAGE_BPS
            );
            require(minLpOut != 0, "GUARD_LP_DUST");
            curve.add_liquidity(amounts, minLpOut);
        }
        uint256 availableLp = lp.balanceOf(address(this));
        if (availableLp == 0) return;
        uint256 sharesBefore = yearn.balanceOf(address(this));
        try yearn.deposit(availableLp, address(this)) returns (uint256) {
            emit Invested(amount, availableLp, yearn.balanceOf(address(this)) - sharesBefore);
        } catch {
            emit InvestmentDeferred(3);
        }
    }

    /// @dev Burn enough LP for the exact SDT liability using the guard's own 2%
    ///      minimum estimate, rather than a separate Curve spot-price binary search.
    ///      The independent guard's minimum for the ACTUAL burn is passed to Curve.
    ///      A bounded retry can cover nonlinear one-sided exit pricing; excess SDT
    ///      is allowed to remain invested/idle until a later action.
    function _redeemRequiredSDT(uint256 grossSDT)
        private returns (uint256 redeemedLp, uint256 redeemedYearn)
    {
        for (uint256 attempt; attempt < 3; ++attempt) {
            uint256 held = sdt.balanceOf(address(this));
            if (held >= grossSDT) break;
            uint256 needed = grossSDT - held;
            uint256 localLp = lp.balanceOf(address(this));
            uint256 shares = yearn.balanceOf(address(this));
            uint256 availableLp = localLp + _yearnSharesToLp(shares);
            if (availableLp == 0) revert InsufficientRedemptionLiquidity();

            (, uint256 minSDTForAll) = curveLiquidityGuard.quoteWithdraw(
                CURVE_LP, SDT_INDEX, availableLp, CURVE_LP_SLIPPAGE_BPS
            );
            require(minSDTForAll != 0, "GUARD_SDT_DUST");
            uint256 burnLp = Math.mulDiv(needed, availableLp, minSDTForAll, Math.Rounding.Up);
            if (burnLp > availableLp) burnLp = availableLp;

            if (burnLp > localLp) {
                uint256 requiredLp = burnLp - localLp;
                uint256 price = yearn.pricePerShare();
                if (price == 0) revert InsufficientRedemptionLiquidity();
                uint256 requiredShares = Math.mulDiv(requiredLp, yearnShareUnit, price, Math.Rounding.Up);
                if (requiredShares > shares) requiredShares = shares;
                // No additional Yearn loss allowance. Curve slippage is configured
                // exclusively through the external 2% bounds guard below.
                yearn.withdraw(requiredShares, address(this), 0);
                redeemedYearn += requiredShares;
                if (lp.balanceOf(address(this)) < burnLp) revert InsufficientRedemptionLiquidity();
            }
            (, uint256 minSDTOut) = curveLiquidityGuard.quoteWithdraw(
                CURVE_LP, SDT_INDEX, burnLp, CURVE_LP_SLIPPAGE_BPS
            );
            require(minSDTOut != 0, "GUARD_SDT_DUST");
            curve.remove_liquidity_one_coin(burnLp, SDT_INDEX, minSDTOut);
            redeemedLp += burnLp;
        }
    }

    function withdraw(uint256 grossSDT) external onlyVault nonReentrant {
        _withdraw(grossSDT);
    }

    /// @notice Compatible with the original vault's emergencyWithdraw selector.
    function emergencyWithdraw(uint256 grossSDT) external onlyVault nonReentrant {
        _withdraw(grossSDT);
    }

    function _withdraw(uint256 grossSDT) private {
        if (grossSDT == 0) return;
        uint256 redeemedLp;
        uint256 redeemedYearn;
        bool finalExit = IBeefySDTVaultV6(vault).totalSupply() == 0;
        if (finalExit) {
            // The parent has already burned the last shares before calling here.
            // Redeem the entire position with the SAME externally guarded minOut.
            redeemedYearn = yearn.balanceOf(address(this));
            if (redeemedYearn != 0) yearn.withdraw(redeemedYearn, address(this), 0);
            redeemedLp = lp.balanceOf(address(this));
            if (redeemedLp != 0) {
                (, uint256 minSDTOut) = curveLiquidityGuard.quoteWithdraw(
                    CURVE_LP, SDT_INDEX, redeemedLp, CURVE_LP_SLIPPAGE_BPS
                );
                if (minSDTOut != 0) {
                    curve.remove_liquidity_one_coin(redeemedLp, SDT_INDEX, minSDTOut);
                } else {
                    // Unpriceable LP dust cannot be burned under the guard.
                    // Only a fully funded final exit can leave it for the admin sweep.
                    if (sdt.balanceOf(address(this)) < grossSDT) revert InsufficientRedemptionLiquidity();
                    redeemedLp = 0;
                }
            }
        } else {
            uint256 held = sdt.balanceOf(address(this));
            if (held < grossSDT) {
                (redeemedLp, redeemedYearn) = _redeemRequiredSDT(grossSDT);
            } else {
                sdt.safeTransfer(vault, grossSDT);
                emit Withdrawn(grossSDT, 0, 0);
                return;
            }
        }
        if (sdt.balanceOf(address(this)) < grossSDT) revert InsufficientRedemptionLiquidity();
        sdt.safeTransfer(vault, grossSDT);
        if (finalExit) {
            // There are no shareholder claims after the final burn. Send every
            // remaining asset class to the vault's CURRENT admin fee receiver.
            address receiver = IBeefySDTVaultV6(vault).adminFeeReceiver();
            uint256 extraSDT = sdt.balanceOf(address(this));
            if (extraSDT != 0) sdt.safeTransfer(receiver, extraSDT);
            uint256 extraLP = lp.balanceOf(address(this));
            if (extraLP != 0) lp.safeTransfer(receiver, extraLP);
            uint256 extraYearn = yearn.balanceOf(address(this));
            if (extraYearn != 0) IERC20(address(yearn)).safeTransfer(receiver, extraYearn);
        }
        emit Withdrawn(grossSDT, redeemedLp, redeemedYearn);
    }

    /** @notice The unchanged vault sends its 70% shareholder share here automatically.
     * @dev No lock or fee manipulation: incoming SDT directly increases residual shareholder NAV.
     */
    function lockVaultProfit(uint256) external onlyVault nonReentrant {}
}