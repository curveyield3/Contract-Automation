// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IRouterV2, CyHopR} from "./lib/IRouterV2.sol";
import {IPositionAdapter, SafeCall} from "./positions/IPositionAdapter.sol";

/// @dev Read-only ratio mathematics implemented by the bot router.
interface IRangeRouterMathV1 {
    function exactToken0Value(uint256 amount0, uint160 sqrtPriceX96) external pure returns (uint256);
    function planRangeSwap(
        uint160 sqrtPriceX96, int24 lo, int24 hi, uint256 a0, uint256 a1, uint24 fee
    ) external pure returns (bool sellToken0, uint256 amountIn);
    function exactMulDiv(uint256 a, uint256 b, uint256 denominator) external pure returns (uint256);
}

interface ISafeM {
    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        returns (bool);
    function execTransactionFromModuleReturnData(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        returns (bool, bytes memory);
}

interface IERC20M {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface INpmM {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function mint(MintParams calldata) external returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function increaseLiquidity(IncreaseLiquidityParams calldata) external returns (uint128, uint256, uint256);
    function decreaseLiquidity(DecreaseLiquidityParams calldata) external returns (uint256, uint256);
    function collect(CollectParams calldata) external returns (uint256, uint256);
    function burn(uint256 tokenId) external;
    function approve(address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
    function positions(uint256 tokenId)
        external
        view
        returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128);
}

interface IStakerM {
    function stake(uint256 tokenId) external;
    function unstake(uint256 tokenId) external;
    function getStaker(uint256 tokenId) external view returns (address);
}

interface IPoolM {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
}

/// PositionRegistry (Safe-only setters: called through the Safe)
interface IRegistryM {
    function isAllowed(bytes32 id) external view returns (bool);
    function positionOf(bytes32 id) external view returns (address adapter, bytes memory data);
    function setPosition(address adapter, bytes calldata data, bool enabled) external;
}

interface ILoopM {
    function convertBest(address token, uint256 amountIn) external returns (uint256 katOut);
    function LOOP_MARKET() external view returns (bytes32);
}

struct MarketParamsM {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

interface IMorphoM {
    function idToMarketParams(bytes32 id) external view returns (address, address, address, address, uint256);
    function supplyCollateral(MarketParamsM memory mp, uint256 assets, address onBehalf, bytes calldata data) external;
}

/// @title RangeManager
/// @notice Safe module for the avKAT bot (FIX_BATCH_SPEC.md §G, user 2026-10-23: "this design of needing separate
/// modules for each position is garbage" ... "make sure we wont need yet another redeploy later"): ANY number of
/// Safe-owned V3-style ranges in one contract, each with its own pool / position manager / staker, shape, trigger,
/// idle rules. A new range, pair, fee tier or DEX (V3-compatible) is a Safe setting, never a deploy.
///  Shapes (per range, Safe-set): CENTER (re-mint `lowerSpec` ticks below / `upperSpec` above the current tick:
///  symmetric or lopsided), ONE_SIDED (after an exit, re-mint the same width just beyond the price with whatever token
///  it holds - no ratio swap), FIXED (absolute ticks `lowerSpec` / `upperSpec`; never re-centered).
///  Trigger (per range): `edgeTicks` from an edge (0 = only when fully out), `minIntervalSec`, `maxPerDay` (rolling).
///  Idle (per range): `absorbIdle`, `keep0` / `keep1` never used, `minAbsorbValue` (token1 units) worth an absorb.
/// Actions (executor = the bot key): rebalance, absorb, compound (fees back in), move (a share of one range into another,
/// tokens converted along Safe-set paths), convertInto (a registered position into a range: avKAT -> loop collateral,
/// never sold), convertOut (a share of a range into a registered position), withdraw (a range to idle).
/// Every range is registered in the PositionRegistry (the loop bot can slice it for runs / fuel).
/// @dev Tokens never leave the Safe except into its positions / through the bot router (back to the Safe). Calls never
/// target the Safe or this module. Every dependency and setting Safe-set.
contract RangeManager {
    ISafeM public immutable SAFE;
    IMorphoM public immutable MORPHO;
    address public immutable KAT;
    address public immutable AVKAT;

    uint8 public constant CENTER = 0;
    uint8 public constant ONE_SIDED = 1;
    uint8 public constant FIXED = 2;

    struct Range {
        INpmM npm;
        IStakerM staker; // 0 = never staked
        IPoolM pool;
        address token0;
        address token1;
        uint24 fee;
        int24 spacing;
        uint8 mode;
        int24 lowerSpec; // CENTER / ONE_SIDED: ticks below the price (ONE_SIDED: width = lower + upper); FIXED: lower tick
        int24 upperSpec; // ... ticks above the price; FIXED: upper tick
        uint32 edgeTicks;
        uint32 minIntervalSec;
        uint16 maxPerDay;
        bool active;
        bool absorbIdle;
        uint256 tokenId; // 0 = empty (the next fill mints)
        int24 lower;
        int24 upper;
        uint256 keep0;
        uint256 keep1;
        uint256 minAbsorbValue;
        uint256 count; // rebalances so far
    }

    IRegistryM public registry;
    IRouterV2 public router; // swaps (the Safe's TWAP-protected profile) + pool guards; adapters read it from here
    ILoopM public loopModule; // convertBest (unknown tokens -> KAT) + its market (avKAT -> collateral)
    address public adapter; // V3PositionAdapter: every range's registry entry

    uint256 public rangeCount; // ids 1..rangeCount
    mapping(uint256 => Range) internal ranges;
    mapping(uint256 => mapping(uint256 => uint256)) public rebalanceTimes; // range => n => timestamp
    mapping(address => mapping(address => address[])) internal paths; // from => to => tokens swapped through, in order
    mapping(uint256 => mapping(address => address)) public convertTarget; // range => foreign token => its range token
    mapping(address => bool) public isExecutor;
    bool private locked;

    event ExecutorSet(address indexed account, bool enabled);
    event DepsSet(address registry, address router, address loopModule, address adapter);
    event RangeAdded(uint256 indexed id, address npm, address pool, address staker);
    event ShapeSet(uint256 indexed id, uint8 mode, int24 lowerSpec, int24 upperSpec);
    event TriggerSet(uint256 indexed id, uint32 edgeTicks, uint32 minIntervalSec, uint16 maxPerDay);
    event IdleSet(uint256 indexed id, bool absorbIdle, uint256 keep0, uint256 keep1, uint256 minAbsorbValue);
    event ActiveSet(uint256 indexed id, bool active);
    event PathSet(address indexed from, address indexed to, address[] via);
    event ConvertTargetSet(uint256 indexed id, address indexed token, address target);
    event Minted(uint256 indexed id, uint256 tokenId, int24 lower, int24 upper);
    event Emptied(uint256 indexed id, uint256 tokenId);
    event Rebalanced(uint256 indexed id, uint256 oldTokenId, int24 tick);
    event Moved(uint256 indexed from, uint256 indexed to, uint256 fractionE18);
    event ConvertedInto(uint256 indexed id, bytes32 indexed positionId, uint256 fractionE18);
    event ConvertedOut(uint256 indexed id, bytes32 indexed positionId, uint256 fractionE18, uint256 kat);

    error NotSafe();
    error NotExecutor();
    error Reentrant();
    error BadSetting();
    error BadRange(uint256 id);
    error Inactive(uint256 id);
    error Empty(uint256 id);
    error NotAtEdge(int24 tick, int24 lower, int24 upper);
    error TooSoon(uint256 nextAt);
    error NotTheSafes(uint256 tokenId);
    error UnknownPosition(bytes32 id);
    error NothingToAdd();
    error NoTarget(address token);
    error NotSingleHop(address token);
    error BadCall(address to);
    error SafeCallFailed();

    modifier onlySafe() {
        if (msg.sender != address(SAFE)) revert NotSafe();
        _;
    }

    modifier onlyExecutor() {
        if (!isExecutor[msg.sender] && msg.sender != address(SAFE)) revert NotExecutor();
        if (locked) revert Reentrant();
        locked = true;
        _;
        locked = false;
    }

    /// @param deps registry, bot router, loop module, V3 adapter
    constructor(address safe_, address morpho_, address kat_, address avkat_, address[4] memory deps, address[] memory executors_) {
        SAFE = ISafeM(safe_);
        MORPHO = IMorphoM(morpho_);
        KAT = kat_;
        AVKAT = avkat_;
        _setDeps(deps);
        for (uint256 i; i < executors_.length; ++i) {
            isExecutor[executors_[i]] = true;
            emit ExecutorSet(executors_[i], true);
        }
    }

    // ================================================================ actions (executor or the Safe)

    /// @notice Re-mints range `id` per its shape. CENTER / ONE_SIDED only, when the tick is within edgeTicks of an edge
    /// (0: outside the range) and the range's rate limits allow it.
    function rebalance(uint256 id) external onlyExecutor {
        Range storage r = _live(id);
        if (r.mode == FIXED) revert BadSetting();
        (, int24 tick,,,,,) = r.pool.slot0();
        int24 e = int24(uint24(r.edgeTicks));
        if (tick >= r.lower + e && tick < r.upper - e) revert NotAtEdge(tick, r.lower, r.upper);
        uint256 next = _nextAllowed(id);
        if (block.timestamp < next) revert TooSoon(next);
        rebalanceTimes[id][r.count] = block.timestamp;
        r.count += 1;
        router.checkPool(address(r.pool));
        uint256 old = r.tokenId;
        _empty(id);
        _fill(id);
        emit Rebalanced(id, old, tick);
    }

    /// @notice The Safe's idle tokens of range `id` (above keep) into it, when worth >= minAbsorbValue.
    function absorb(uint256 id) external onlyExecutor {
        Range storage r = _live(id);
        if (!r.absorbIdle) revert BadSetting();
        (uint256 a0, uint256 a1) = _idle(r);
        if (_value(r, a0, a1) < r.minAbsorbValue) revert NothingToAdd();
        router.checkPool(address(r.pool));
        _addIdle(id);
    }

    /// @notice Collects range `id`'s fees and adds them (and idle above keep) back in, without re-centering.
    function compound(uint256 id) external onlyExecutor {
        Range storage r = _live(id);
        router.checkPool(address(r.pool));
        bool staked = _staked(r, r.tokenId);
        if (staked) _safe(address(r.staker), abi.encodeCall(IStakerM.unstake, (r.tokenId)));
        _collect(r, r.tokenId);
        if (staked) _stake(r, r.tokenId);
        _addIdle(id);
    }

    /// @notice `fractionE18` of range `from` into range `to` (an empty one is minted): the tokens `to` doesn't hold are
    /// converted to its tokens along the Safe-set paths, then `to` takes everything idle of its pair above keep.
    function move(uint256 from, uint256 to, uint256 fractionE18) external onlyExecutor {
        Range storage f = _live(from);
        Range storage t = _active(to);
        if (from == to) revert BadSetting();
        router.checkPool(address(f.pool));
        router.checkPool(address(t.pool));
        (address x0, address x1) = (f.token0, f.token1);
        (uint256 b0, uint256 b1) = (_bal(x0), _bal(x1));
        if (fractionE18 >= 1e18) _empty(from);
        else _slice(f, fractionE18);
        _convert(to, x0, _bal(x0) - b0);
        _convert(to, x1, _bal(x1) - b1);
        _fillOrAdd(to);
        emit Moved(from, to, fractionE18);
    }

    /// @notice `fractionE18` of registered position `positionId` into range `id`: avKAT -> the loop as collateral (never
    /// sold), the range's tokens kept, others converted along the paths (no target: KAT through the loop module first).
    function convertInto(uint256 id, bytes32 positionId, uint256 fractionE18) external onlyExecutor {
        Range storage r = _active(id);
        if (r.tokenId != 0 && positionId == _ownId(r, r.tokenId)) revert BadSetting();
        (IPositionAdapter a, bytes memory data) = _position(positionId);
        (SafeCall[] memory pre, SafeCall[] memory post, address[] memory outs,) = a.exitCalls(data, fractionE18, address(SAFE));
        uint256[] memory b0 = new uint256[](outs.length);
        for (uint256 i; i < outs.length; ++i) b0[i] = _bal(outs[i]);
        _run(pre);
        for (uint256 i; i < outs.length; ++i) {
            uint256 d = _bal(outs[i]) - b0[i];
            if (d == 0) continue;
            if (outs[i] == AVKAT) _toCollateral(d);
            else _convert(id, outs[i], d);
        }
        _run(post);
        router.checkPool(address(r.pool));
        _fillOrAdd(id);
        emit ConvertedInto(id, positionId, fractionE18);
    }

    /// @notice `fractionE18` of range `id` into registered position `positionId`: the slice -> KAT (paths), then into the
    /// target through its adapter (value-share swaps on single-hop KAT routes + add calls); what it can't take stays idle.
    function convertOut(uint256 id, bytes32 positionId, uint256 fractionE18) external onlyExecutor {
        Range storage r = _live(id);
        if (positionId == _ownId(r, r.tokenId)) revert BadSetting();
        router.checkPool(address(r.pool));
        (address x0, address x1) = (r.token0, r.token1);
        uint256 k0 = _bal(KAT);
        (uint256 b0, uint256 b1) = (_bal(x0), _bal(x1));
        _slice(r, fractionE18);
        if (x0 != KAT) _path(x0, KAT, _bal(x0) - b0);
        if (x1 != KAT) _path(x1, KAT, _bal(x1) - b1);
        uint256 kat = _bal(KAT) - k0;
        if (kat != 0) _toPosition(positionId, kat);
        emit ConvertedOut(id, positionId, fractionE18, kat);
    }

    /// @notice Range `id` -> idle tokens in the Safe (unstake, remove all, collect, burn, unregister); stays empty until a
    /// move / convertInto fills it.
    function withdraw(uint256 id) external onlyExecutor {
        _live(id);
        _empty(id);
    }

    // ================================================================ views

    function rangeOf(uint256 id) external view returns (Range memory) {
        return ranges[id];
    }

    /// @notice The registry id of range `id`'s position (0: empty).
    function positionIdOf(uint256 id) external view returns (bytes32) {
        Range storage r = ranges[id];
        return r.tokenId == 0 ? bytes32(0) : _ownId(r, r.tokenId);
    }

    function pathOf(address from, address to) external view returns (address[] memory) {
        return paths[from][to];
    }

    /// @notice For the bot, every range in one call: tick, range, NFT (0 = empty), whether a rebalance may run now (edge
    /// reached + rate limits), idle value (token1 units) and the absorb threshold (0 = absorb off), active.
    function statusAll()
        external
        view
        returns (
            int24[] memory tick,
            int24[] memory lo,
            int24[] memory hi,
            uint256[] memory tokenId,
            bool[] memory canRebalance,
            uint256[] memory idleValue,
            uint256[] memory absorbMin,
            bool[] memory active
        )
    {
        uint256 n = rangeCount;
        (tick, lo, hi, tokenId) = (new int24[](n), new int24[](n), new int24[](n), new uint256[](n));
        (canRebalance, idleValue, absorbMin, active) = (new bool[](n), new uint256[](n), new uint256[](n), new bool[](n));
        for (uint256 i; i < n; ++i) {
            Range storage r = ranges[i + 1];
            (, tick[i],,,,,) = r.pool.slot0();
            (lo[i], hi[i], tokenId[i], active[i]) = (r.lower, r.upper, r.tokenId, r.active);
            int24 e = int24(uint24(r.edgeTicks));
            canRebalance[i] = r.active && r.tokenId != 0 && r.mode != FIXED && (tick[i] < r.lower + e || tick[i] >= r.upper - e)
                && block.timestamp >= _nextAllowed(i + 1);
            (uint256 a0, uint256 a1) = _idle(r);
            idleValue[i] = _value(r, a0, a1);
            absorbMin[i] = r.absorbIdle && r.minAbsorbValue != 0 ? r.minAbsorbValue : 0;
        }
    }

    // ================================================================ Safe-only config

    function setExecutor(address account, bool enabled) external onlySafe {
        isExecutor[account] = enabled;
        emit ExecutorSet(account, enabled);
    }

    /// @param deps registry, bot router, loop module, V3 adapter
    function setDeps(address[4] calldata deps) external onlySafe {
        _setDeps(deps);
    }

    /// @notice A new range on V3-style `pool` (tokens / fee / spacing read from it), its position manager and staker (0 =
    /// never staked). Starts inactive and empty: set its shape / trigger / idle rules, then activate it.
    function addRange(address npm, address pool, address staker) external onlySafe returns (uint256 id) {
        if (npm == address(0) || pool == address(0)) revert BadSetting();
        id = ++rangeCount;
        Range storage r = ranges[id];
        IPoolM p = IPoolM(pool);
        (r.npm, r.staker, r.pool) = (INpmM(npm), IStakerM(staker), p);
        (r.token0, r.token1, r.fee, r.spacing) = (p.token0(), p.token1(), p.fee(), p.tickSpacing());
        r.maxPerDay = 24;
        emit RangeAdded(id, npm, pool, staker);
    }

    /// @notice CENTER: `lower` ticks below / `upper` above the current tick. ONE_SIDED: width lower + upper, placed beyond
    /// the price on the side of the token held. FIXED: absolute ticks (multiples of the spacing).
    function setShape(uint256 id, uint8 mode, int24 lower, int24 upper) external onlySafe {
        Range storage r = _range(id);
        if (mode > FIXED) revert BadSetting();
        if (mode == FIXED ? (lower >= upper || lower % r.spacing != 0 || upper % r.spacing != 0) : (lower < 0 || upper < 0 || lower + upper < r.spacing)) {
            revert BadSetting();
        }
        (r.mode, r.lowerSpec, r.upperSpec) = (mode, lower, upper);
        emit ShapeSet(id, mode, lower, upper);
    }

    function setTrigger(uint256 id, uint32 edgeTicks, uint32 minIntervalSec, uint16 maxPerDay) external onlySafe {
        Range storage r = _range(id);
        if (maxPerDay == 0) revert BadSetting();
        (r.edgeTicks, r.minIntervalSec, r.maxPerDay) = (edgeTicks, minIntervalSec, maxPerDay);
        emit TriggerSet(id, edgeTicks, minIntervalSec, maxPerDay);
    }

    function setIdle(uint256 id, bool absorbIdle, uint256 keep0, uint256 keep1, uint256 minAbsorbValue) external onlySafe {
        Range storage r = _range(id);
        (r.absorbIdle, r.keep0, r.keep1, r.minAbsorbValue) = (absorbIdle, keep0, keep1, minAbsorbValue);
        emit IdleSet(id, absorbIdle, keep0, keep1, minAbsorbValue);
    }

    function setActive(uint256 id, bool active) external onlySafe {
        _range(id).active = active;
        emit ActiveSet(id, active);
    }

    /// @notice Conversions `from` -> `to` swap through `via` in order (each pair a bot-router route); empty = direct.
    function setPath(address from, address to, address[] calldata via) external onlySafe {
        paths[from][to] = via;
        emit PathSet(from, to, via);
    }

    /// @notice Which of range `id`'s tokens a foreign `token` becomes when it moves in (0 = its token1).
    function setConvertTarget(uint256 id, address token, address target) external onlySafe {
        Range storage r = _range(id);
        if (target != address(0) && target != r.token0 && target != r.token1) revert BadSetting();
        convertTarget[id][token] = target;
        emit ConvertTargetSet(id, token, target);
    }

    /// @notice Takes over the Safe's position `tokenId` (held or staked by the Safe) as range `id`'s: a held one is staked
    /// (if the range has a staker); it is registered.
    function adopt(uint256 id, uint256 tokenId) external onlySafe {
        Range storage r = _range(id);
        address owner = r.npm.ownerOf(tokenId);
        bool staker = address(r.staker) != address(0);
        if (owner != address(SAFE) && !(staker && owner == address(r.staker) && r.staker.getStaker(tokenId) == address(SAFE))) {
            revert NotTheSafes(tokenId);
        }
        (,, address t0, address t1, uint24 f, int24 lo, int24 hi,,,,,) = r.npm.positions(tokenId);
        if (t0 != r.token0 || t1 != r.token1 || f != r.fee) revert BadSetting();
        (r.tokenId, r.lower, r.upper) = (tokenId, lo, hi);
        if (owner == address(SAFE) && staker) _stake(r, tokenId);
        _register(r, tokenId, true);
        emit Minted(id, tokenId, lo, hi);
    }

    /// @notice Stops managing range `id`'s position (the NFT and its registry entry stay as they are).
    function release(uint256 id) external onlySafe {
        Range storage r = _range(id);
        emit Emptied(id, r.tokenId);
        r.tokenId = 0;
    }

    // ================================================================ internal: one range

    function _range(uint256 id) internal view returns (Range storage r) {
        if (id == 0 || id > rangeCount) revert BadRange(id);
        r = ranges[id];
    }

    function _active(uint256 id) internal view returns (Range storage r) {
        r = _range(id);
        if (!r.active) revert Inactive(id);
    }

    function _live(uint256 id) internal view returns (Range storage r) {
        r = _active(id);
        if (r.tokenId == 0) revert Empty(id);
    }

    /// @dev unstake -> remove all -> collect -> burn -> unregister; the range is empty after
    function _empty(uint256 id) internal {
        Range storage r = ranges[id];
        uint256 tid = r.tokenId;
        if (_staked(r, tid)) _safe(address(r.staker), abi.encodeCall(IStakerM.unstake, (tid)));
        (,,,,,,, uint128 liq,,,,) = r.npm.positions(tid);
        if (liq != 0) _decrease(r, tid, liq);
        _collect(r, tid);
        _safe(address(r.npm), abi.encodeCall(INpmM.burn, (tid)));
        _register(r, tid, false);
        r.tokenId = 0;
        emit Emptied(id, tid);
    }

    /// @dev `fractionE18` of the range's liquidity (+ all its fees) to the Safe; it stays staked
    function _slice(Range storage r, uint256 fractionE18) internal {
        uint256 tid = r.tokenId;
        bool staked = _staked(r, tid);
        if (staked) _safe(address(r.staker), abi.encodeCall(IStakerM.unstake, (tid)));
        (,,,,,,, uint128 liq,,,,) = r.npm.positions(tid);
        uint128 take = fractionE18 >= 1e18 ? liq : uint128(uint256(liq) * fractionE18 / 1e18);
        if (take != 0) _decrease(r, tid, take);
        _collect(r, tid);
        if (staked) _stake(r, tid);
    }

    function _fillOrAdd(uint256 id) internal {
        if (ranges[id].tokenId == 0) _fill(id);
        else _addIdle(id);
    }

    /// @dev mints range `id` per its shape from everything idle above keep (ratio swap unless ONE_SIDED) -> leftover pass
    /// (CENTER / FIXED) -> stake -> register
    function _fill(uint256 id) internal {
        Range storage r = ranges[id];
        (uint160 sp, int24 tick,,,,,) = r.pool.slot0();
        (uint256 a0, uint256 a1) = _idle(r);
        int24 lo;
        int24 hi;
        if (r.mode == FIXED) {
            (lo, hi) = (r.lowerSpec, r.upperSpec);
        } else if (r.mode == ONE_SIDED) {
            // the token worth more decides the side: token0 only sits above the price (higher ticks), token1 below
            int24 w = _round(r, r.lowerSpec + r.upperSpec);
            if (IRangeRouterMathV1(address(router)).exactToken0Value(a0, sp) >= a1) lo = _floor(r, tick) + r.spacing;
            else lo = _floor(r, tick) - w;
            hi = lo + w;
        } else {
            lo = _round(r, tick - r.lowerSpec);
            hi = lo + _round(r, r.lowerSpec + r.upperSpec);
        }
        if (hi <= lo) hi = lo + r.spacing;
        if (r.mode != ONE_SIDED) _swapToRatio(r, lo, hi, a0, a1, true);
        (a0, a1) = _idle(r);
        if (a0 == 0 && a1 == 0) revert NothingToAdd();
        _approveNpm(r, a0, a1);
        (bool ok, bytes memory ret) = SAFE.execTransactionFromModuleReturnData(
            address(r.npm),
            0,
            abi.encodeCall(INpmM.mint, (INpmM.MintParams(r.token0, r.token1, r.fee, lo, hi, a0, a1, 0, 0, address(SAFE), block.timestamp))),
            0
        );
        if (!ok) revert SafeCallFailed();
        (uint256 tid,,,) = abi.decode(ret, (uint256, uint128, uint256, uint256));
        _approveNpm(r, 0, 0);
        (r.tokenId, r.lower, r.upper) = (tid, lo, hi);
        if (r.mode != ONE_SIDED) _topUp(r, tid);
        if (address(r.staker) != address(0)) _stake(r, tid);
        _register(r, tid, true);
        emit Minted(id, tid, lo, hi);
    }

    /// @dev unstake -> everything idle above keep into the range (two ratio passes) -> re-stake; reverts if nothing added
    function _addIdle(uint256 id) internal {
        Range storage r = ranges[id];
        uint256 tid = r.tokenId;
        bool staked = _staked(r, tid);
        if (staked) _safe(address(r.staker), abi.encodeCall(IStakerM.unstake, (tid)));
        if (!_topUp(r, tid)) revert NothingToAdd();
        _topUp(r, tid);
        if (staked) _stake(r, tid);
    }

    /// @dev idle above keep -> ratio swap -> increaseLiquidity (never reverts on dust: returns whether it added)
    function _topUp(Range storage r, uint256 tid) internal returns (bool added) {
        (uint256 a0, uint256 a1) = _idle(r);
        if (a0 == 0 && a1 == 0) return false;
        _swapToRatio(r, r.lower, r.upper, a0, a1, false);
        (a0, a1) = _idle(r);
        _approveNpm(r, a0, a1);
        added = SAFE.execTransactionFromModule(
            address(r.npm),
            0,
            abi.encodeCall(INpmM.increaseLiquidity, (INpmM.IncreaseLiquidityParams(tid, a0, a1, 0, 0, block.timestamp))),
            0
        );
        _approveNpm(r, 0, 0);
    }

    /// @dev swaps the surplus side of (a0, a1) so its value split matches [lo, hi] at the current price (fee-adjusted).
    /// `strict`: a failed swap reverts; else it is skipped (dust).
    function _swapToRatio(Range storage r, int24 lo, int24 hi, uint256 a0, uint256 a1, bool strict) internal {
        (uint160 sp,,,,,,) = r.pool.slot0();
        (bool sellToken0, uint256 amountIn) = IRangeRouterMathV1(address(router)).planRangeSwap(
            sp, lo, hi, a0, a1, r.fee
        );
        if (amountIn == 0) return;
        if (sellToken0) _swapMaybe(r.token0, r.token1, amountIn, strict);
        else _swapMaybe(r.token1, r.token0, amountIn, strict);
    }

    function _swapMaybe(address tokenIn, address tokenOut, uint256 x, bool strict) internal {
        if (strict) {
            _path(tokenIn, tokenOut, x);
            return;
        }
        // Dust pass: only the router failure is ignored; approval failures remain fatal.
        _routerSwap(tokenIn, tokenOut, x, false);
    }

    function _nextAllowed(uint256 id) internal view returns (uint256 at) {
        Range storage r = ranges[id];
        uint256 n = r.count;
        if (n == 0) return 0;
        at = rebalanceTimes[id][n - 1] + r.minIntervalSec;
        if (n >= r.maxPerDay) {
            uint256 dayAt = rebalanceTimes[id][n - r.maxPerDay] + 1 days;
            if (dayAt > at) at = dayAt;
        }
    }

    function _floor(Range storage r, int24 t) internal view returns (int24) {
        int24 q = t / r.spacing;
        if (t < 0 && t % r.spacing != 0) q--;
        return q * r.spacing;
    }

    /// @dev to the nearest multiple of the spacing
    function _round(Range storage r, int24 t) internal view returns (int24) {
        int24 f = _floor(r, t);
        return (t - f) * 2 >= r.spacing ? f + r.spacing : f;
    }

    function _idle(Range storage r) internal view returns (uint256 a0, uint256 a1) {
        (uint256 b0, uint256 b1) = (_bal(r.token0), _bal(r.token1));
        (a0, a1) = (b0 > r.keep0 ? b0 - r.keep0 : 0, b1 > r.keep1 ? b1 - r.keep1 : 0);
    }

    /// @dev (a0, a1) valued in token1 at spot
    function _value(Range storage r, uint256 a0, uint256 a1) internal view returns (uint256) {
        (uint160 sp,,,,,,) = r.pool.slot0();
        return IRangeRouterMathV1(address(router)).exactToken0Value(a0, sp) + a1;
    }

    function _staked(Range storage r, uint256 tid) internal view returns (bool) {
        return address(r.staker) != address(0) && r.npm.ownerOf(tid) == address(r.staker);
    }

    function _stake(Range storage r, uint256 tid) internal {
        _safe(address(r.npm), abi.encodeCall(INpmM.approve, (address(r.staker), tid)));
        _safe(address(r.staker), abi.encodeCall(IStakerM.stake, (tid)));
    }

    function _decrease(Range storage r, uint256 tid, uint128 liq) internal {
        _safe(address(r.npm), abi.encodeCall(INpmM.decreaseLiquidity, (INpmM.DecreaseLiquidityParams(tid, liq, 0, 0, block.timestamp))));
    }

    function _collect(Range storage r, uint256 tid) internal {
        _safe(address(r.npm), abi.encodeCall(INpmM.collect, (INpmM.CollectParams(tid, address(SAFE), type(uint128).max, type(uint128).max))));
    }

    function _approveNpm(Range storage r, uint256 a0, uint256 a1) internal {
        _safe(r.token0, abi.encodeCall(IERC20M.approve, (address(r.npm), a0)));
        _safe(r.token1, abi.encodeCall(IERC20M.approve, (address(r.npm), a1)));
    }

    function _ownId(Range storage r, uint256 tid) internal view returns (bytes32) {
        return keccak256(abi.encode(adapter, abi.encode(address(r.npm), tid, address(r.staker))));
    }

    function _register(Range storage r, uint256 tid, bool enabled) internal {
        _safe(address(registry), abi.encodeCall(IRegistryM.setPosition, (adapter, abi.encode(address(r.npm), tid, address(r.staker)), enabled)));
    }

    // ================================================================ internal: conversions / other positions

    /// @dev `amount` of `token` into range `id`'s pair: kept if it is one of its tokens; else to convertTarget (default
    /// token1) along the path; a token with no path / route is converted to KAT by the loop module first
    function _convert(uint256 id, address token, uint256 amount) internal {
        Range storage r = ranges[id];
        if (amount == 0 || token == r.token0 || token == r.token1) return;
        address target = convertTarget[id][token];
        if (target == address(0)) target = r.token1;
        if (paths[token][target].length == 0 && router.routeHops(token, target).length == 0) {
            if (token == KAT) revert NoTarget(token);
            amount = loopModule.convertBest(token, amount); // -> KAT
            _convert(id, KAT, amount);
            return;
        }
        _path(token, target, amount);
    }

    /// @dev `amount` of `from` -> `to` through the Safe-set path (each leg a router swap under the Safe's profile)
    function _path(address from, address to, uint256 amount) internal {
        address[] storage via = paths[from][to];
        address cur = from;
        for (uint256 i; i <= via.length; ++i) {
            address nxt = i < via.length ? via[i] : to;
            amount = _swap(cur, nxt, amount);
            cur = nxt;
        }
    }

    function _position(bytes32 pid) internal view returns (IPositionAdapter a, bytes memory data) {
        if (!registry.isAllowed(pid)) revert UnknownPosition(pid);
        address ad;
        (ad, data) = registry.positionOf(pid);
        a = IPositionAdapter(ad);
        a.guard(data, address(SAFE)); // the position's pool: this module's router guard
    }

    function _toCollateral(uint256 amount) internal {
        MarketParamsM memory mp;
        (mp.loanToken, mp.collateralToken, mp.oracle, mp.irm, mp.lltv) = MORPHO.idToMarketParams(loopModule.LOOP_MARKET());
        _safe(AVKAT, abi.encodeCall(IERC20M.approve, (address(MORPHO), amount)));
        _safe(address(MORPHO), abi.encodeCall(IMorphoM.supplyCollateral, (mp, amount, address(SAFE), "")));
    }

    /// @dev `kat` into registered position `pid` (as MerklRouteModule): pass 1 swaps KAT into each other token by its value
    /// share; pass 2 sells back what the moved price made too much; then the adapter's add calls.
    function _toPosition(bytes32 pid, uint256 kat) internal {
        (IPositionAdapter a, bytes memory data) = _position(pid);
        (address[] memory tokens, uint256[] memory shares) = a.addShares(data);
        uint256[] memory amounts = new uint256[](tokens.length);
        uint256 kept = kat;
        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i] == KAT || shares[i] == 0) continue;
            uint256 kf = 1e6 - _hop(KAT, tokens[i]).fee;
            uint256 x = kat * shares[i] / (shares[i] + (1e18 - shares[i]) * kf / 1e6);
            if (x > kept) x = kept;
            if (x == 0) continue;
            amounts[i] = _swap(KAT, tokens[i], x);
            kept -= x;
        }
        (, shares) = a.addShares(data);
        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i] == KAT || amounts[i] == 0) continue;
            CyHopR memory h = _hop(tokens[i], KAT);
            uint256 v = router.quoteAtSpot(h.pool, amounts[i], tokens[i], KAT);
            uint256 over = (1e18 - shares[i]) * v;
            uint256 under = shares[i] * kept;
            if (v == 0 || over <= under) continue;
            uint256 y = IRangeRouterMathV1(address(router)).exactMulDiv(amounts[i], (over - under) / (1e18 - shares[i] * h.fee / 1e6), v);
            if (y == 0) continue;
            kept += _swap(tokens[i], KAT, y);
            amounts[i] -= y;
        }
        for (uint256 i; i < tokens.length; ++i) if (tokens[i] == KAT) amounts[i] = kept;
        _run(a.addCalls(data, tokens, amounts, address(SAFE)));
    }

    function _hop(address tokenIn, address tokenOut) internal view returns (CyHopR memory) {
        CyHopR[] memory hops = router.routeHops(tokenIn, tokenOut);
        if (hops.length != 1 || hops[0].venue != 1) revert NotSingleHop(tokenIn == KAT ? tokenOut : tokenIn);
        return hops[0];
    }

    // ================================================================ internal: plumbing

    function _bal(address token) internal view returns (uint256) {
        return IERC20M(token).balanceOf(address(SAFE));
    }

    /// @dev exact-input swap from the Safe through the router (the Safe's profile: TWAP-protected minimum)
    function _swap(address tokenIn, address tokenOut, uint256 x) internal returns (uint256 out) {
        if (x == 0) return 0;
        uint256 b0 = _bal(tokenOut);
        _routerSwap(tokenIn, tokenOut, x, true);
        out = _bal(tokenOut) - b0;
    }

    /// @dev Shared approvals; only dust-router execution may fail without reverting.
    function _routerSwap(address tokenIn, address tokenOut, uint256 x, bool strict) internal {
        _safe(tokenIn, abi.encodeCall(IERC20M.approve, (address(router), x)));
        bytes memory data = abi.encodeCall(IRouterV2.swapExactInput, (tokenIn, tokenOut, x, 0, address(SAFE), block.timestamp));
        if (strict) _safe(address(router), data);
        else SAFE.execTransactionFromModule(address(router), 0, data, 0);
        _safe(tokenIn, abi.encodeCall(IERC20M.approve, (address(router), 0)));
    }

    function _setDeps(address[4] memory deps) internal {
        for (uint256 i; i < 4; ++i) if (deps[i] == address(0)) revert BadSetting();
        (registry, router, loopModule, adapter) = (IRegistryM(deps[0]), IRouterV2(deps[1]), ILoopM(deps[2]), deps[3]);
        emit DepsSet(deps[0], deps[1], deps[2], deps[3]);
    }

    function _run(SafeCall[] memory calls) internal {
        for (uint256 i; i < calls.length; ++i) {
            if (calls[i].to == address(SAFE) || calls[i].to == address(this)) revert BadCall(calls[i].to);
            if (!SAFE.execTransactionFromModule(calls[i].to, calls[i].value, calls[i].data, 0)) revert SafeCallFailed();
        }
    }

    function _safe(address to, bytes memory data) internal {
        if (!SAFE.execTransactionFromModule(to, 0, data, 0)) revert SafeCallFailed();
    }
}