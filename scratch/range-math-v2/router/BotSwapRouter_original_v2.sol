// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {FullMath} from "../lib/FullMath.sol";
import {TickMath} from "../lib/TickMath.sol";

interface IV3PoolB {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory, uint160[] memory);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function factory() external view returns (address);
}

interface IV3FactoryB {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IERC20B {
    function balanceOf(address) external view returns (uint256);
}

struct BalHooksConfigB {
    bool enableHookAdjustedAmounts;
    bool shouldCallBeforeInitialize;
    bool shouldCallAfterInitialize;
    bool shouldCallComputeDynamicSwapFee;
    bool shouldCallBeforeSwap;
    bool shouldCallAfterSwap;
    bool shouldCallBeforeAddLiquidity;
    bool shouldCallAfterAddLiquidity;
    bool shouldCallBeforeRemoveLiquidity;
    bool shouldCallAfterRemoveLiquidity;
    address hooksContract;
}

interface IBalVaultHooksB {
    function getHooksConfig(address pool) external view returns (BalHooksConfigB memory);
}

interface IBalRouterB {
    function getPermit2() external view returns (address);
    function swapSingleTokenExactIn(
        address pool,
        address tokenIn,
        address tokenOut,
        uint256 exactAmountIn,
        uint256 minAmountOut,
        uint256 deadline,
        bool wethIsEth,
        bytes calldata userData
    ) external payable returns (uint256 amountOut);
}

interface IPermit2ApproveB {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface ICurveYieldPoolOracleB {
    function quoteOracleProtectedSwapOut(address pool, address tokenIn, address tokenOut, uint256 amountInRaw)
        external
        view
        returns (uint256 oracleExpectedAmountOut, uint256 oracleMinAmountOut);
}

interface IWETHB {
    function withdraw(uint256 amount) external;
}

/// One hop of a route: a Sushi V3 pool (token pair + fee tier) or a CurveYield DEX (Balancer V3) pool.
struct CyHopB {
    uint8 venue; // 1 = SUSHI, 2 = BALANCER
    address tokenIn;
    address tokenOut;
    address pool; // Sushi: the factory's pool for (tokenIn, tokenOut, fee); Balancer: the CurveYield DEX pool
    uint24 fee; // Sushi fee tier (ignored for Balancer)
}

/// @title BotSwapRouter
/// @notice The avKAT bot system's swap router (user, 2026-10-22): a FORK of the cyavKAT stack's CurveYieldSwapRouterV2
/// (work/phase2, which stays untouched), used by the bot only. Kept from it: multi-hop routes mixing Sushi V3 and
/// CurveYield DEX pools, a manipulation-resistant minimum on every swap (the expected output chained hop by hop -
/// Sushi: the pool's TWAP minus its fee; DEX: the pool hook's time-weighted output - times (1 - protection)), the
/// v2-compatible `twapMinimumOut` / `swapExactInput`, factory-checked pools, exact balance checks, no residue. Changed
/// for the bot: no fee and no governance gate (owner = the avKAT loop Safe, two-step transfer, sets the default TWAP
/// window / protection); per-caller profiles (own window / protection, e.g. a 10 s window for the loop sales);
/// exact-output swaps (single Sushi hop) with an optional unwrap to native ETH; and ONE price guard per pool (user,
/// 2026-10-22: "one guard for every pool"): every bot module and position adapter checks a pool here (checkPool /
/// checkRoute) and values at its guard window (twapValue) - none carries its own TWAP window, deviation or pool list.
contract BotSwapRouter {
    uint8 public constant SUSHI = 1;
    uint8 public constant BALANCER = 2;
    uint256 private constant BPS = 10_000;

    address public immutable WETH; // vbETH: exact-output swaps may unwrap it to native ETH

    struct Profile {
        uint32 twapWindow; // seconds (> 0)
        uint16 protectionBps; // bps (< 100%)
        bool set;
    }

    /// the price guard of one V3 pool: spot within maxDeviation ticks of its `window`-second TWAP
    struct PoolGuard {
        uint32 window;
        uint24 maxDeviation;
    }

    address public owner; // the avKAT loop Safe
    address public pendingOwner;
    uint32 public twapWindow = 900; // default for callers without a profile (s)
    uint16 public protectionBps = 200; // default (bps)
    address public balancerVault; // CurveYield DEX (Owner-set when the DEX is live; re-settable)
    address public balancerRouter;
    mapping(address caller => Profile) public profiles;
    mapping(address pool => PoolGuard) public poolGuards;
    /// V3 factories whose pools may be routed (owner-set, audit 2026-10-22: a new Sushi factory or another V3 DEX needs
    /// no new router); a hop's pool must be its factory's own pool for the hop's tokens + fee
    mapping(address factory => bool) public factoryAllowed;
    mapping(bytes32 routeKey => CyHopB[]) private _routes;

    // Sushi callback guard (one pool swap at a time)
    address private _activePool;
    address private _activeTokenIn;
    uint256 private _activeAmountIn;
    bool private _callbackConsumed;
    uint256 private _locked = 1;

    event OwnerSet(address owner);
    event OwnershipTransferStarted(address pendingOwner);
    event BalancerSet(address vault, address router);
    event FactorySet(address indexed factory, bool allowed);
    event PoolGuardSet(address indexed pool, uint32 window, uint24 maxDeviation);
    event DefaultsSet(uint32 twapWindow, uint16 protectionBps);
    event ProfileSet(address indexed caller, uint32 twapWindow, uint16 protectionBps);
    event ProfileRemoved(address indexed caller);
    event RouteSet(address indexed tokenIn, address indexed tokenOut, uint256 hops);
    event RouteRemoved(address indexed tokenIn, address indexed tokenOut);
    event Swapped(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address recipient);

    error NotOwner();
    error BadSetting();
    error BadRoute();
    error RouteMissing(address tokenIn, address tokenOut);
    error ExactOutputRoute();
    error Expired();
    error TooLittleOut(uint256 out, uint256 minimum);
    error TooMuchIn(uint256 amountIn, uint256 maximum);
    error BadCallback();
    error Reentrant();
    error ZeroAmount();
    error BadRecipient();
    error TransferFailed();
    error UnwrapFailed();
    error NoGuard(address pool);
    error TwapDeviation(int24 spot, int24 twap);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier lock() {
        if (_locked != 1) revert Reentrant();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address owner_, address sushiFactory_, address weth_) {
        if (owner_ == address(0) || sushiFactory_ == address(0)) revert BadSetting();
        owner = owner_;
        WETH = weth_;
        factoryAllowed[sushiFactory_] = true;
        emit OwnerSet(owner_);
        emit FactorySet(sushiFactory_, true);
    }

    /// @dev native ETH only from unwrapping WETH (forwarded in the same call)
    receive() external payable {
        if (msg.sender != WETH) revert UnwrapFailed();
    }

    // ---------------------------------------------------------------- configuration (owner = the loop Safe)

    /// @notice Two-step: the new owner takes over only by calling acceptOwnership (a mistyped address can't lose it).
    function transferOwnership(address owner_) external onlyOwner {
        pendingOwner = owner_;
        emit OwnershipTransferStarted(owner_);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotOwner();
        (owner, pendingOwner) = (msg.sender, address(0));
        emit OwnerSet(msg.sender);
    }

    /// @notice The window / protection of every caller without a profile.
    function setDefaults(uint32 twapWindow_, uint16 protectionBps_) external onlyOwner {
        if (twapWindow_ == 0 || protectionBps_ >= BPS) revert BadSetting();
        (twapWindow, protectionBps) = (twapWindow_, protectionBps_);
        emit DefaultsSet(twapWindow_, protectionBps_);
    }

    /// @notice A caller's own TWAP window / protection.
    function setProfile(address caller_, uint32 twapWindow_, uint16 protectionBps_) external onlyOwner {
        if (caller_ == address(0) || twapWindow_ == 0 || protectionBps_ >= BPS) revert BadSetting();
        profiles[caller_] = Profile(twapWindow_, protectionBps_, true);
        emit ProfileSet(caller_, twapWindow_, protectionBps_);
    }

    function removeProfile(address caller_) external onlyOwner {
        delete profiles[caller_];
        emit ProfileRemoved(caller_);
    }

    /// @notice Allows / disallows a V3 factory for new routes (routes already set stay as they are).
    function setFactory(address factory_, bool allowed_) external onlyOwner {
        if (factory_ == address(0)) revert BadSetting();
        factoryAllowed[factory_] = allowed_;
        emit FactorySet(factory_, allowed_);
    }

    /// @notice Wires the CurveYield DEX (Balancer V3 vault + router); re-settable (a new DEX router version needs no
    /// new bot router). Both zero = unwired.
    function setBalancer(address vault_, address router_) external onlyOwner {
        if ((vault_ == address(0)) != (router_ == address(0))) revert BadSetting();
        (balancerVault, balancerRouter) = (vault_, router_);
        emit BalancerSet(vault_, router_);
    }

    /// @notice A pool's price guard (window > 0 s, deviation > 0 ticks); window 0 removes it. A pool without a
    /// guard fails every check (fail closed).
    function setPoolGuard(address pool_, uint32 window_, uint24 maxDeviation_) external onlyOwner {
        if (window_ == 0) {
            delete poolGuards[pool_];
        } else {
            if (pool_ == address(0) || maxDeviation_ == 0) revert BadSetting();
            poolGuards[pool_] = PoolGuard(window_, maxDeviation_);
        }
        emit PoolGuardSet(pool_, window_, maxDeviation_);
    }

    /// @notice Sets the route tokenIn -> tokenOut (hops in order, each output feeding the next input).
    function setRoute(address tokenIn_, address tokenOut_, CyHopB[] calldata hops_) external onlyOwner {
        if (
            hops_.length == 0 || tokenIn_ == tokenOut_ || hops_[0].tokenIn != tokenIn_
                || hops_[hops_.length - 1].tokenOut != tokenOut_
        ) revert BadRoute();
        bytes32 key = _key(tokenIn_, tokenOut_);
        delete _routes[key];
        for (uint256 i; i < hops_.length; ++i) {
            CyHopB calldata h = hops_[i];
            if (i != 0 && h.tokenIn != hops_[i - 1].tokenOut) revert BadRoute();
            if (h.tokenIn == address(0) || h.tokenOut == address(0) || h.tokenIn == h.tokenOut) revert BadRoute();
            if (h.venue == SUSHI) {
                if (h.pool.code.length == 0) revert BadRoute();
                address f = IV3PoolB(h.pool).factory();
                if (!factoryAllowed[f] || IV3FactoryB(f).getPool(h.tokenIn, h.tokenOut, h.fee) != h.pool) revert BadRoute();
            } else if (h.venue == BALANCER) {
                if (balancerVault == address(0) || IBalVaultHooksB(balancerVault).getHooksConfig(h.pool).hooksContract == address(0)) {
                    revert BadRoute();
                }
            } else {
                revert BadRoute();
            }
            _routes[key].push(h);
        }
        emit RouteSet(tokenIn_, tokenOut_, hops_.length);
    }

    function removeRoute(address tokenIn_, address tokenOut_) external onlyOwner {
        delete _routes[_key(tokenIn_, tokenOut_)];
        emit RouteRemoved(tokenIn_, tokenOut_);
    }

    function routeHops(address tokenIn_, address tokenOut_) external view returns (CyHopB[] memory) {
        return _routes[_key(tokenIn_, tokenOut_)];
    }

    /// @notice The protection (bps) and TWAP window (s) a swap by `caller_` gets.
    function settingsFor(address caller_) public view returns (uint256 protectionBps_, uint32 twapWindow_) {
        Profile memory p = profiles[caller_];
        return p.set ? (p.protectionBps, p.twapWindow) : (protectionBps, twapWindow);
    }

    // ---------------------------------------------------------------- quotes

    /// @notice Time-weighted expected output and the protected minimum for a swap by `caller_`.
    function protectedQuoteFor(address caller_, address tokenIn_, address tokenOut_, uint256 amountIn_)
        public
        view
        returns (uint256 expected_, uint256 minimum_)
    {
        CyHopB[] storage hops = _routeOf(tokenIn_, tokenOut_);
        (uint256 prot, uint32 window) = settingsFor(caller_);
        expected_ = amountIn_;
        for (uint256 i; i < hops.length; ++i) expected_ = _hopExpected(hops[i], expected_, window);
        minimum_ = expected_ * (BPS - prot) / BPS;
    }

    /// @notice v2-compatible: the protected minimum output (default settings).
    function twapMinimumOut(address tokenIn_, address tokenOut_, uint256 amountIn_) external view returns (uint256 minimum_) {
        (, minimum_) = protectedQuoteFor(address(0), tokenIn_, tokenOut_, amountIn_);
    }

    /// @notice Exact output (single Sushi hop routes): the most input a swap by `caller_` for `amountOut_` may take, =
    /// the TWAP-expected input incl. the pool fee, x (1 + protection).
    function protectedMaxIn(address caller_, address tokenIn_, address tokenOut_, uint256 amountOut_) public view returns (uint256) {
        CyHopB storage h = _singleSushiHop(tokenIn_, tokenOut_);
        (uint256 prot, uint32 window) = settingsFor(caller_);
        uint256 expectedIn =
            FullMath.mulDivRoundingUp(_quoteAtTick(_meanTick(h.pool, window), amountOut_, tokenOut_, tokenIn_), 1_000_000, 1_000_000 - h.fee);
        return FullMath.mulDivRoundingUp(expectedIn, BPS + prot, BPS);
    }

    /// @notice Spot (planning only, never a minimum): chained output after pool fees; DEX hops use the hook's
    /// time-weighted expectation.
    function quoteExactInput(address tokenIn_, address tokenOut_, uint256 amountIn_) external view returns (uint256 out_) {
        CyHopB[] storage hops = _routeOf(tokenIn_, tokenOut_);
        out_ = amountIn_;
        for (uint256 i; i < hops.length; ++i) {
            out_ = hops[i].venue == SUSHI
                ? _quoteAtTick(_spotTick(hops[i].pool), out_, hops[i].tokenIn, hops[i].tokenOut) * (1_000_000 - hops[i].fee) / 1_000_000
                : _hopExpected(hops[i], out_, 0);
        }
    }

    /// @notice Spot (planning only): input for `amountOut_` on a single Sushi hop route.
    function quoteExactOutput(address tokenIn_, address tokenOut_, uint256 amountOut_) external view returns (uint256) {
        CyHopB storage h = _singleSushiHop(tokenIn_, tokenOut_);
        return FullMath.mulDivRoundingUp(_quoteAtTick(_spotTick(h.pool), amountOut_, tokenOut_, tokenIn_), 1_000_000, 1_000_000 - h.fee);
    }

    // ---------------------------------------------------------------- the pool guards (the bot modules use these)

    /// @notice Reverts unless `pool_` has a guard and its spot is within the guard's deviation of its TWAP.
    function checkPool(address pool_) public view {
        (int24 spot, int24 twap, uint24 diff, uint24 maxDev,) = guardStatus(pool_);
        if (diff > maxDev) revert TwapDeviation(spot, twap);
    }

    /// @notice checkPool for every Sushi hop of the route tokenIn -> tokenOut (DEX hops carry their hook's own oracle).
    function checkRoute(address tokenIn_, address tokenOut_) external view {
        CyHopB[] storage hops = _routeOf(tokenIn_, tokenOut_);
        for (uint256 i; i < hops.length; ++i) if (hops[i].venue == SUSHI) checkPool(hops[i].pool);
    }

    /// @notice A pool's spot tick, guard-window TWAP tick, their distance, and its guard.
    function guardStatus(address pool_)
        public
        view
        returns (int24 spot_, int24 twap_, uint24 diff_, uint24 maxDeviation_, uint32 window_)
    {
        PoolGuard memory g = poolGuards[pool_];
        if (g.window == 0) revert NoGuard(pool_);
        (spot_, twap_) = (_spotTick(pool_), _meanTick(pool_, g.window));
        diff_ = uint24(spot_ > twap_ ? spot_ - twap_ : twap_ - spot_);
        (maxDeviation_, window_) = (g.maxDeviation, g.window);
    }

    /// @notice `amountIn_` of tokenIn valued in tokenOut (no fee) at the TWAP of the single Sushi hop route between them
    /// (either direction), over that pool's guard window. E.g. gas cost (vbETH) in KAT.
    function twapValue(address tokenIn_, address tokenOut_, uint256 amountIn_) external view returns (uint256) {
        CyHopB[] storage hops = _routes[_key(tokenIn_, tokenOut_)];
        if (hops.length == 0) hops = _routes[_key(tokenOut_, tokenIn_)];
        if (hops.length != 1 || hops[0].venue != SUSHI) revert ExactOutputRoute();
        uint32 window = poolGuards[hops[0].pool].window;
        if (window == 0) revert NoGuard(hops[0].pool);
        return _quoteAtTick(_meanTick(hops[0].pool, window), amountIn_, tokenIn_, tokenOut_);
    }

    /// @notice `amountIn_` of tokenIn valued in tokenOut at a V3 pool's spot price (no fee).
    function quoteAtSpot(address pool_, uint256 amountIn_, address tokenIn_, address tokenOut_) external view returns (uint256) {
        (uint160 sqrtP,,,,,,) = IV3PoolB(pool_).slot0();
        return _quoteAtSqrt(sqrtP, amountIn_, tokenIn_, tokenOut_);
    }

    // ---------------------------------------------------------------- swaps

    /// @notice Swaps `amountIn_` of tokenIn along the route; the output must reach max(the caller's protected minimum,
    /// `minAmountOut_`). Input is pulled from the caller.
    function swapExactInput(
        address tokenIn_,
        address tokenOut_,
        uint256 amountIn_,
        uint256 minAmountOut_,
        address recipient_,
        uint256 deadline_
    ) external lock returns (uint256 out_) {
        if (block.timestamp > deadline_) revert Expired();
        if (amountIn_ == 0) revert ZeroAmount();
        if (recipient_ == address(0) || recipient_ == address(this)) revert BadRecipient();
        (, uint256 minimum) = protectedQuoteFor(msg.sender, tokenIn_, tokenOut_, amountIn_);
        if (minAmountOut_ > minimum) minimum = minAmountOut_;

        _pull(tokenIn_, amountIn_);
        CyHopB[] storage hops = _routeOf(tokenIn_, tokenOut_);
        out_ = amountIn_;
        for (uint256 i; i < hops.length; ++i) out_ = _hopSwap(hops[i], out_, deadline_);
        if (out_ < minimum) revert TooLittleOut(out_, minimum);
        _send(tokenOut_, recipient_, out_);
        emit Swapped(tokenIn_, tokenOut_, amountIn_, out_, recipient_);
    }

    /// @notice Buys exactly `amountOut_` of tokenOut (single Sushi hop routes) for at most min(`maxAmountIn_`, the
    /// caller's protected maximum) of tokenIn: that much is pulled from the caller, the unused part goes back to it.
    /// `unwrap_`: tokenOut must be WETH, delivered to `recipient_` as native ETH.
    function swapExactOutput(
        address tokenIn_,
        address tokenOut_,
        uint256 amountOut_,
        uint256 maxAmountIn_,
        address recipient_,
        uint256 deadline_,
        bool unwrap_
    ) external lock returns (uint256 amountIn_) {
        if (block.timestamp > deadline_) revert Expired();
        if (amountOut_ == 0) revert ZeroAmount();
        if (recipient_ == address(0) || recipient_ == address(this) || (unwrap_ && tokenOut_ != WETH)) revert BadRecipient();
        CyHopB storage h = _singleSushiHop(tokenIn_, tokenOut_);
        uint256 maxIn = protectedMaxIn(msg.sender, tokenIn_, tokenOut_, amountOut_);
        if (maxAmountIn_ < maxIn) maxIn = maxAmountIn_;

        _pull(tokenIn_, maxIn);
        bool zeroForOne = tokenIn_ < tokenOut_;
        (_activePool, _activeTokenIn, _activeAmountIn, _callbackConsumed) = (h.pool, tokenIn_, maxIn, false);
        (int256 a0, int256 a1) = IV3PoolB(h.pool).swap(
            address(this), zeroForOne, -int256(amountOut_), zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1, ""
        );
        if (!_callbackConsumed) revert BadCallback();
        (_activePool, _activeTokenIn, _activeAmountIn) = (address(0), address(0), 0);
        amountIn_ = uint256(zeroForOne ? a0 : a1);
        uint256 out = uint256(-(zeroForOne ? a1 : a0));
        if (out < amountOut_) revert TooLittleOut(out, amountOut_); // the pool ran out of liquidity before the limit
        if (amountIn_ > maxIn) revert TooMuchIn(amountIn_, maxIn);

        if (unwrap_) {
            IWETHB(WETH).withdraw(amountOut_);
            (bool ok,) = recipient_.call{value: amountOut_}("");
            if (!ok) revert UnwrapFailed();
        } else {
            _send(tokenOut_, recipient_, amountOut_);
        }
        if (maxIn > amountIn_) _send(tokenIn_, msg.sender, maxIn - amountIn_);
        emit Swapped(tokenIn_, tokenOut_, amountIn_, amountOut_, recipient_);
    }

    /// @notice Sushi V3 pool callback: only the active, factory-derived pool, once, for at most the hop's input.
    function uniswapV3SwapCallback(int256 amount0Delta_, int256 amount1Delta_, bytes calldata) external {
        if (msg.sender != _activePool || _callbackConsumed) revert BadCallback();
        int256 inputDelta = amount0Delta_ > 0 ? amount0Delta_ : amount1Delta_;
        if (inputDelta <= 0 || uint256(inputDelta) > _activeAmountIn) revert BadCallback();
        _callbackConsumed = true;
        _send(_activeTokenIn, msg.sender, uint256(inputDelta));
    }

    // ---------------------------------------------------------------- internals

    function _hopExpected(CyHopB storage h_, uint256 amountIn_, uint32 window_) private view returns (uint256) {
        if (h_.venue == SUSHI) {
            return _quoteAtTick(_meanTick(h_.pool, window_), amountIn_, h_.tokenIn, h_.tokenOut) * (1_000_000 - h_.fee) / 1_000_000;
        }
        address hook = IBalVaultHooksB(balancerVault).getHooksConfig(h_.pool).hooksContract;
        (uint256 expected,) = ICurveYieldPoolOracleB(hook).quoteOracleProtectedSwapOut(h_.pool, h_.tokenIn, h_.tokenOut, amountIn_);
        return expected;
    }

    function _hopSwap(CyHopB storage h_, uint256 amountIn_, uint256 deadline_) private returns (uint256 out_) {
        if (h_.venue == SUSHI) {
            bool zeroForOne = h_.tokenIn < h_.tokenOut;
            (_activePool, _activeTokenIn, _activeAmountIn, _callbackConsumed) = (h_.pool, h_.tokenIn, amountIn_, false);
            (int256 a0, int256 a1) = IV3PoolB(h_.pool).swap(
                address(this), zeroForOne, int256(amountIn_), zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1, ""
            );
            if (!_callbackConsumed) revert BadCallback();
            (_activePool, _activeTokenIn, _activeAmountIn) = (address(0), address(0), 0);
            return uint256(-(zeroForOne ? a1 : a0));
        }
        address permit2 = IBalRouterB(balancerRouter).getPermit2();
        _approve(h_.tokenIn, permit2, amountIn_);
        IPermit2ApproveB(permit2).approve(h_.tokenIn, balancerRouter, uint160(amountIn_), uint48(block.timestamp));
        out_ = IBalRouterB(balancerRouter).swapSingleTokenExactIn(h_.pool, h_.tokenIn, h_.tokenOut, amountIn_, 0, deadline_, false, "");
        IPermit2ApproveB(permit2).approve(h_.tokenIn, balancerRouter, 0, 0);
        _approve(h_.tokenIn, permit2, 0);
    }

    function _routeOf(address tokenIn_, address tokenOut_) private view returns (CyHopB[] storage hops_) {
        hops_ = _routes[_key(tokenIn_, tokenOut_)];
        if (hops_.length == 0) revert RouteMissing(tokenIn_, tokenOut_);
    }

    function _singleSushiHop(address tokenIn_, address tokenOut_) private view returns (CyHopB storage h_) {
        CyHopB[] storage hops = _routeOf(tokenIn_, tokenOut_);
        if (hops.length != 1 || hops[0].venue != SUSHI) revert ExactOutputRoute();
        h_ = hops[0];
    }

    function _spotTick(address pool_) private view returns (int24 tick_) {
        (, tick_,,,,,) = IV3PoolB(pool_).slot0();
    }

    function _meanTick(address pool_, uint32 window_) private view returns (int24 tick_) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = window_;
        (int56[] memory cumulatives,) = IV3PoolB(pool_).observe(ago);
        int56 delta = cumulatives[1] - cumulatives[0];
        tick_ = int24(delta / int56(uint56(window_)));
        if (delta < 0 && (delta % int56(uint56(window_)) != 0)) tick_--;
    }

    function _quoteAtTick(int24 tick_, uint256 baseAmount_, address baseToken_, address quoteToken_) private pure returns (uint256) {
        return _quoteAtSqrt(TickMath.getSqrtRatioAtTick(tick_), baseAmount_, baseToken_, quoteToken_);
    }

    function _quoteAtSqrt(uint160 sqrtRatioX96, uint256 baseAmount_, address baseToken_, address quoteToken_) private pure returns (uint256) {
        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            return baseToken_ < quoteToken_
                ? FullMath.mulDiv(ratioX192, baseAmount_, 1 << 192)
                : FullMath.mulDiv(1 << 192, baseAmount_, ratioX192);
        }
        uint256 ratioX128 = FullMath.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
        return baseToken_ < quoteToken_
            ? FullMath.mulDiv(ratioX128, baseAmount_, 1 << 128)
            : FullMath.mulDiv(1 << 128, baseAmount_, ratioX128);
    }

    function _key(address tokenIn_, address tokenOut_) private pure returns (bytes32) {
        return keccak256(abi.encode(tokenIn_, tokenOut_));
    }

    /// @dev transferFrom the caller, exact (no fee-on-transfer tokens)
    function _pull(address token_, uint256 amount_) private {
        uint256 b0 = IERC20B(token_).balanceOf(address(this));
        _call(token_, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amount_));
        if (IERC20B(token_).balanceOf(address(this)) - b0 != amount_) revert TransferFailed();
    }

    function _send(address token_, address to_, uint256 amount_) private {
        _call(token_, abi.encodeWithSelector(0xa9059cbb, to_, amount_));
    }

    function _approve(address token_, address spender_, uint256 amount_) private {
        _call(token_, abi.encodeWithSelector(0x095ea7b3, spender_, amount_));
    }

    /// @dev a token call that must not revert and must return nothing or true
    function _call(address token_, bytes memory data_) private {
        (bool ok, bytes memory ret) = token_.call(data_);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}