// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @notice Morpho Blue ABI-compatible structs. The field order and widths are immutable.
struct CYMarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

struct CYMarket {
    uint128 totalSupplyAssets;
    uint128 totalSupplyShares;
    uint128 totalBorrowAssets;
    uint128 totalBorrowShares;
    uint128 lastUpdate;
    uint128 fee;
}

interface ICYIrm {
    function borrowRate(CYMarketParams memory params, CYMarket memory market) external returns (uint256);
    function borrowRateView(CYMarketParams memory params, CYMarket memory market) external view returns (uint256);
}

interface ICYMorpho {
    function accrueInterest(CYMarketParams calldata params) external;
    function market(bytes32 id) external view returns (CYMarket memory);
}

interface ICYYieldSource {
    function aprReady() external view returns (bool);
    function getAPR() external view returns (uint256);
}

interface ICYUnmodifiedAdaptiveIrm is ICYIrm {
    function MORPHO() external view returns (address);
}

abstract contract CurveYieldIrmBase {
    uint256 public constant WAD = 1e18;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant HARD_MAX_APR = 3.65e18; // 365% simple APR; NOT compounded APY.
    uint256 public constant HARD_MAX_SPY = HARD_MAX_APR / SECONDS_PER_YEAR;
    address public immutable MORPHO;

    error NotMorpho();
    error InvalidParameter();
    error NotOwner();

    constructor(address morpho_) {
        if (morpho_ == address(0) || morpho_.code.length == 0) revert InvalidParameter();
        MORPHO = morpho_;
    }

    modifier onlyMorpho() {
        if (msg.sender != MORPHO) revert NotMorpho();
        _;
    }

    function _id(CYMarketParams memory p) internal pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }

    function _requireThisIrm(CYMarketParams memory p) internal view {
        if (p.irm != address(this)) revert InvalidParameter();
    }

    function _accrueExisting(CYMarketParams memory p) internal {
        if (ICYMorpho(MORPHO).market(_id(p)).lastUpdate != 0) {
            ICYMorpho(MORPHO).accrueInterest(p);
        }
    }

    function _utilization(CYMarket memory m) internal pure returns (uint256 u) {
        if (m.totalSupplyAssets == 0) return 0;
        u = uint256(m.totalBorrowAssets) * WAD / uint256(m.totalSupplyAssets);
        if (u > WAD) u = WAD;
    }

    function _toSpy(uint256 apr) internal pure returns (uint256) {
        if (apr > HARD_MAX_APR) apr = HARD_MAX_APR;
        return apr / SECONDS_PER_YEAR;
    }

    function _capSpy(uint256 spy) internal pure returns (uint256) {
        return spy > HARD_MAX_SPY ? HARD_MAX_SPY : spy;
    }
}

/// @notice V2 of the existing Fraxtal collateral-yield IRM. Existing deployed V1
/// markets are NOT modified. V2 preserves the V1 curve, yield-observation lag,
/// collateral-vault restriction, rebates and constructor ABI, while enforcing
/// borrow APR <= min(constructor cap, 365%, 5 * observed collateral APR).
contract CurveYieldCollateralYieldIRMV2 is CurveYieldIrmBase, ICYIrm {
    uint256 public constant MAX_MULTIPLIER = 10e18;
    uint256 public constant MAX_CONFIG_APR = 5e18;
    uint256 public constant MAX_YIELD_COST_MULTIPLIER = 5e18;

    struct Curve {
        uint256 minimumMultiplier;
        uint256 targetMultiplier;
        uint256 maximumMultiplier;
        uint256 targetUtilization;
        uint256 aprRebate;
    }

    address public owner;
    ICYYieldSource public immutable yieldVault;
    uint256 public immutable fallbackCollateralApr;
    uint256 public immutable maximumCollateralApr;
    uint256 public immutable maximumBorrowApr;

    mapping(bytes32 => Curve) public curves;
    mapping(bytes32 => bool) public configured;
    mapping(bytes32 => bool) public initialized;
    mapping(bytes32 => uint256) public cachedCollateralApr;

    event OwnershipTransferred(address indexed oldOwner, address indexed nextOwner);
    event CurveConfigured(bytes32 indexed id, uint256 minimum, uint256 target, uint256 maximum, uint256 utilization, uint256 rebate);
    event YieldObserved(bytes32 indexed id, uint256 apr);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address morpho_, address owner_, address vault_,
        uint256 fallbackApr_, uint256 collateralCap_, uint256 borrowCap_
    ) CurveYieldIrmBase(morpho_) {
        if (owner_ == address(0) || vault_.code.length == 0 ||
            collateralCap_ > MAX_CONFIG_APR || fallbackApr_ > collateralCap_ ||
            borrowCap_ == 0 || borrowCap_ > HARD_MAX_APR) revert InvalidParameter();
        owner = owner_;
        yieldVault = ICYYieldSource(vault_);
        fallbackCollateralApr = fallbackApr_;
        maximumCollateralApr = collateralCap_;
        maximumBorrowApr = borrowCap_;
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        if (nextOwner == address(0)) revert InvalidParameter();
        emit OwnershipTransferred(owner, nextOwner);
        owner = nextOwner;
    }

    function setCurve(CYMarketParams memory p, Curve memory c) external onlyOwner {
        _requireThisIrm(p);
        if (p.collateralToken != address(yieldVault) ||
            c.minimumMultiplier > c.targetMultiplier ||
            c.targetMultiplier > c.maximumMultiplier ||
            c.maximumMultiplier > MAX_MULTIPLIER ||
            c.targetUtilization == 0 || c.targetUtilization >= WAD ||
            c.aprRebate > WAD) revert InvalidParameter();
        bytes32 id = _id(p);
        // Never apply a new curve retroactively to interest that has not accrued.
        if (configured[id]) _accrueExisting(p);
        else if (ICYMorpho(MORPHO).market(id).lastUpdate != 0) revert InvalidParameter();
        curves[id] = c;
        configured[id] = true;
        emit CurveConfigured(id, c.minimumMultiplier, c.targetMultiplier, c.maximumMultiplier, c.targetUtilization, c.aprRebate);
    }

    function borrowRate(CYMarketParams memory p, CYMarket memory m) external override onlyMorpho returns (uint256) {
        bytes32 id = _id(p);
        if (!configured[id]) revert InvalidParameter();
        uint256 apr = initialized[id] ? cachedCollateralApr[id] : _readApr();
        uint256 result = _rate(apr, curves[id], m);
        uint256 nextApr = _readApr();
        cachedCollateralApr[id] = nextApr;
        initialized[id] = true;
        emit YieldObserved(id, nextApr);
        return result;
    }

    function borrowRateView(CYMarketParams memory p, CYMarket memory m) external view override returns (uint256) {
        bytes32 id = _id(p);
        if (!configured[id]) revert InvalidParameter();
        return _rate(initialized[id] ? cachedCollateralApr[id] : _readApr(), curves[id], m);
    }

    function liveBorrowRateView(CYMarketParams memory p, CYMarket memory m) external view returns (uint256) {
        bytes32 id = _id(p);
        if (!configured[id]) revert InvalidParameter();
        return _rate(_readApr(), curves[id], m);
    }

    function effectiveMultiplier(CYMarketParams memory p, CYMarket memory m) external view returns (uint256) {
        bytes32 id = _id(p);
        if (!configured[id]) revert InvalidParameter();
        return _multiplier(curves[id], _utilization(m));
    }

    function _readApr() internal view returns (uint256 result) {
        result = fallbackCollateralApr;
        try yieldVault.aprReady() returns (bool ready) {
            if (ready) {
                try yieldVault.getAPR() returns (uint256 measured) { result = measured; } catch {}
            }
        } catch {}
        if (result > maximumCollateralApr) result = maximumCollateralApr;
    }

    function _multiplier(Curve memory c, uint256 utilization) internal pure returns (uint256) {
        if (utilization <= c.targetUtilization) {
            return c.minimumMultiplier +
                (c.targetMultiplier - c.minimumMultiplier) * utilization / c.targetUtilization;
        }
        return c.targetMultiplier +
            (c.maximumMultiplier - c.targetMultiplier) *
            (utilization - c.targetUtilization) / (WAD - c.targetUtilization);
    }

    function _rate(uint256 collateralApr, Curve memory c, CYMarket memory m) internal view returns (uint256) {
        uint256 borrowApr = collateralApr * _multiplier(c, _utilization(m)) / WAD;
        borrowApr = borrowApr > c.aprRebate ? borrowApr - c.aprRebate : 0;
        uint256 yieldCostCap = collateralApr * MAX_YIELD_COST_MULTIPLIER / WAD;
        if (borrowApr > yieldCostCap) borrowApr = yieldCostCap;
        if (borrowApr > maximumBorrowApr) borrowApr = maximumBorrowApr;
        return _toSpy(borrowApr);
    }
}

/// @notice Euler-style configurable utilization kink with a hyperbolic high-
/// utilization segment. Configured separately per Morpho market.
/// curvature=0 is a linear kink; larger curvature delays increases until
/// closer to 100% utilization. No automatic parameter changes.
contract CurveYieldEulerUtilizationIRMV1 is CurveYieldIrmBase, ICYIrm {
    struct Curve {
        uint256 minimumApr;
        uint256 targetApr;
        uint256 maximumApr;
        uint256 targetUtilization;
        uint256 curvature;
    }

    address public owner;
    mapping(bytes32 => Curve) public curves;
    mapping(bytes32 => bool) public configured;
    event CurveConfigured(bytes32 indexed id, uint256 minApr, uint256 targetApr, uint256 maxApr, uint256 targetUtilization, uint256 curvature);
    event OwnershipTransferred(address indexed oldOwner, address indexed nextOwner);

    constructor(address morpho_, address owner_) CurveYieldIrmBase(morpho_) {
        if (owner_ == address(0)) revert InvalidParameter();
        owner = owner_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        if (nextOwner == address(0)) revert InvalidParameter();
        emit OwnershipTransferred(owner, nextOwner);
        owner = nextOwner;
    }

    function setCurve(CYMarketParams memory p, Curve memory c) external onlyOwner {
        _requireThisIrm(p);
        if (c.minimumApr > c.targetApr || c.targetApr > c.maximumApr ||
            c.maximumApr > HARD_MAX_APR ||
            c.targetUtilization == 0 || c.targetUtilization >= WAD ||
            c.curvature > 10e18) revert InvalidParameter();
        bytes32 id = _id(p);
        if (configured[id]) _accrueExisting(p);
        else if (ICYMorpho(MORPHO).market(id).lastUpdate != 0) revert InvalidParameter();
        curves[id] = c;
        configured[id] = true;
        emit CurveConfigured(id, c.minimumApr, c.targetApr, c.maximumApr, c.targetUtilization, c.curvature);
    }

    function borrowRate(CYMarketParams memory p, CYMarket memory m) external view override onlyMorpho returns (uint256) {
        return _borrowRate(p, m);
    }

    function borrowRateView(CYMarketParams memory p, CYMarket memory m) external view override returns (uint256) {
        return _borrowRate(p, m);
    }

    function _borrowRate(CYMarketParams memory p, CYMarket memory m) internal view returns (uint256) {
        bytes32 id = _id(p);
        if (!configured[id]) revert InvalidParameter();
        Curve memory c = curves[id];
        uint256 utilization = _utilization(m);
        uint256 apr;
        if (utilization <= c.targetUtilization) {
            apr = c.minimumApr + (c.targetApr - c.minimumApr) * utilization / c.targetUtilization;
        } else {
            uint256 x = (utilization - c.targetUtilization) * WAD / (WAD - c.targetUtilization);
            uint256 denominator = WAD + c.curvature * (WAD - x) / WAD;
            uint256 progress = x * WAD / denominator;
            apr = c.targetApr + (c.maximumApr - c.targetApr) * progress / WAD;
        }
        return _toSpy(apr);
    }
}

/// @notice No owner, setters, storage or possible future rate changes.
contract CurveYieldImmutableStaticIRMV1 is CurveYieldIrmBase, ICYIrm {
    uint256 public immutable apr;
    uint256 public immutable ratePerSecond;

    constructor(address morpho_, uint256 apr_) CurveYieldIrmBase(morpho_) {
        if (apr_ > HARD_MAX_APR) revert InvalidParameter();
        apr = apr_;
        ratePerSecond = _toSpy(apr_);
    }

    function borrowRate(CYMarketParams memory, CYMarket memory) external view override onlyMorpho returns (uint256) {
        return ratePerSecond;
    }

    function borrowRateView(CYMarketParams memory, CYMarket memory) external view override returns (uint256) {
        return ratePerSecond;
    }
}

/// @notice Owner-selectable static-rate targets, with an enforceable continuous
/// rate ramp. APR floor, ceiling and maximum rate-change per day are constructor
/// immutables. Each market has a separate ramp so updates cannot retroactively
/// reprice unrelated markets.
contract CurveYieldGovernedStaticIRMV1 is CurveYieldIrmBase, ICYIrm {
    struct Ramp {
        uint256 startApr;
        uint256 targetApr;
        uint256 startTime;
        uint256 duration;
    }

    address public owner;
    uint256 public immutable minimumApr;
    uint256 public immutable maximumApr;
    uint256 public immutable initialApr;
    uint256 public immutable maximumAprChangePerDay;
    mapping(bytes32 => Ramp) public ramps;
    mapping(bytes32 => bool) public configured;

    event RateTargetSet(bytes32 indexed id, uint256 previousApr, uint256 targetApr, uint256 selectedAprChangePerDay, uint256 duration);
    event OwnershipTransferred(address indexed oldOwner, address indexed nextOwner);

    constructor(
        address morpho_, address owner_, uint256 minimumApr_, uint256 maximumApr_,
        uint256 initialApr_, uint256 maximumAprChangePerDay_
    ) CurveYieldIrmBase(morpho_) {
        if (owner_ == address(0) || minimumApr_ > initialApr_ ||
            initialApr_ > maximumApr_ || maximumApr_ > HARD_MAX_APR ||
            maximumAprChangePerDay_ == 0 || maximumAprChangePerDay_ > HARD_MAX_APR)
            revert InvalidParameter();
        owner = owner_;
        minimumApr = minimumApr_;
        maximumApr = maximumApr_;
        initialApr = initialApr_;
        maximumAprChangePerDay = maximumAprChangePerDay_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        if (nextOwner == address(0)) revert InvalidParameter();
        emit OwnershipTransferred(owner, nextOwner);
        owner = nextOwner;
    }

    /// @notice Change a market's target APR. Rate moves linearly at most the
    /// selected APR percentage points per day, itself bounded by the constructor.
    /// Previous elapsed interest is accrued BEFORE changing the schedule.
    function setTargetRate(CYMarketParams memory p, uint256 targetApr_, uint256 aprChangePerDay)
        external onlyOwner
    {
        _requireThisIrm(p);
        if (targetApr_ < minimumApr || targetApr_ > maximumApr ||
            aprChangePerDay == 0 || aprChangePerDay > maximumAprChangePerDay)
            revert InvalidParameter();
        bytes32 id = _id(p);
        _accrueExisting(p);
        uint256 current = _current(_ramp(id), block.timestamp);
        uint256 delta = current > targetApr_ ? current - targetApr_ : targetApr_ - current;
        uint256 duration = delta == 0 ? 0 : (delta * 1 days + aprChangePerDay - 1) / aprChangePerDay;
        ramps[id] = Ramp(current, targetApr_, block.timestamp, duration);
        configured[id] = true;
        emit RateTargetSet(id, current, targetApr_, aprChangePerDay, duration);
    }

    function currentApr(CYMarketParams memory p) external view returns (uint256) {
        return _current(_ramp(_id(p)), block.timestamp);
    }

    function borrowRate(CYMarketParams memory p, CYMarket memory m) external view override onlyMorpho returns (uint256) {
        return _borrowRate(p, m);
    }

    function borrowRateView(CYMarketParams memory p, CYMarket memory m) external view override returns (uint256) {
        return _borrowRate(p, m);
    }

    function _borrowRate(CYMarketParams memory p, CYMarket memory m) internal view returns (uint256) {
        Ramp memory r = _ramp(_id(p));
        uint256 from = uint256(m.lastUpdate);
        uint256 now_ = block.timestamp;
        if (from == 0 || from >= now_) return _toSpy(_current(r, now_));
        // Exact interval-average APR under a linearly changing rate.
        uint256 area = _integral(r, now_) - _integral(r, from);
        return _toSpy(area / (now_ - from));
    }

    function _ramp(bytes32 id) internal view returns (Ramp memory r) {
        if (configured[id]) return ramps[id];
        return Ramp(initialApr, initialApr, 0, 0);
    }

    function _current(Ramp memory r, uint256 at) internal pure returns (uint256) {
        if (at <= r.startTime) return r.startApr;
        if (r.duration == 0 || at - r.startTime >= r.duration) return r.targetApr;
        uint256 delta = r.startApr > r.targetApr ? r.startApr - r.targetApr : r.targetApr - r.startApr;
        uint256 part = delta * (at - r.startTime) / r.duration;
        return r.targetApr >= r.startApr ? r.startApr + part : r.startApr - part;
    }

    /// @dev Integral of APR-WAD over seconds from timestamp zero to at.
    /// Because the owner's setter accrues first, no market has unaccrued time
    /// crossing the start of an overwritten historical ramp.
    function _integral(Ramp memory r, uint256 at) internal pure returns (uint256) {
        if (at <= r.startTime) return at * r.startApr;
        uint256 elapsed = at - r.startTime;
        uint256 base = r.startTime * r.startApr;
        if (r.duration == 0) return base + elapsed * r.targetApr;
        if (elapsed >= r.duration) {
            uint256 rampArea = r.duration * (r.startApr + r.targetApr) / 2;
            return base + rampArea + (elapsed - r.duration) * r.targetApr;
        }
        uint256 delta = r.startApr > r.targetApr ? r.startApr - r.targetApr : r.targetApr - r.startApr;
        uint256 triangular = delta * elapsed * elapsed / (2 * r.duration);
        uint256 rectangular = elapsed * r.startApr;
        return r.targetApr >= r.startApr ? base + rectangular + triangular : base + rectangular - triangular;
    }
}

/// @notice Cap-only adapter for the completely UNMODIFIED upstream Morpho
/// AdaptiveCurveIrm. Deploy THIS adapter first, deploy the upstream contract
/// with constructor MORPHO=address(adapter), then initialize it once. Authorize
/// the adapter (not the upstream model) in the actual Morpho Blue core.
/// Upstream's own state updates work because msg.sender is the adapter.
contract CurveYieldCappedUnmodifiedMorphoIRMV1 is CurveYieldIrmBase, ICYIrm {
    address public immutable initializer;
    ICYUnmodifiedAdaptiveIrm public underlying;

    event Initialized(address indexed upstreamUnmodifiedIrm);

    constructor(address morpho_, address initializer_) CurveYieldIrmBase(morpho_) {
        if (initializer_ == address(0)) revert InvalidParameter();
        initializer = initializer_;
    }

    function initialize(address unmodifiedIrm) external {
        if (msg.sender != initializer) revert NotOwner();
        if (address(underlying) != address(0) || unmodifiedIrm.code.length == 0 ||
            ICYUnmodifiedAdaptiveIrm(unmodifiedIrm).MORPHO() != address(this))
            revert InvalidParameter();
        underlying = ICYUnmodifiedAdaptiveIrm(unmodifiedIrm);
        emit Initialized(unmodifiedIrm);
    }

    function borrowRate(CYMarketParams memory p, CYMarket memory m) external override onlyMorpho returns (uint256) {
        if (address(underlying) == address(0)) revert InvalidParameter();
        return _capSpy(underlying.borrowRate(p, m));
    }

    function borrowRateView(CYMarketParams memory p, CYMarket memory m) external view override returns (uint256) {
        if (address(underlying) == address(0)) revert InvalidParameter();
        return _capSpy(underlying.borrowRateView(p, m));
    }
}
