// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Fixed-position protocol-owned liquidity manager.
/// @dev Deployment requires an existing Uniswap v3 NFT; transfer it here after deployment.
///      All configured Chainlink feeds MUST quote in the same numeraire (e.g. USD).
///      Only standard ERC20s, fixed-3/plain-NG Curve pools and standard Curve gauges are supported.

interface IERC20PoL {
    function balanceOf(address who) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IERC4626PoL is IERC20PoL {
    function asset() external view returns (address);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function maxDeposit(address receiver) external view returns (uint256);
    function maxRedeem(address owner) external view returns (uint256);
    function previewRedeem(uint256 shares) external view returns (uint256 assets);
    function convertToAssets(uint256 shares) external view returns (uint256 assets);
}

interface IYearnV3PoL is IERC4626PoL {
    function redeem(uint256 shares, address receiver, address owner, uint256 maxLossBps)
        external returns (uint256 assets);
    function maxRedeem(address owner, uint256 maxLossBps) external view returns (uint256);
}

interface ICurve3FixedPoL {
    function add_liquidity(uint256[3] calldata amounts, uint256 minMint) external;
}
interface ICurveNGPoL {
    function add_liquidity(uint256[] calldata amounts, uint256 minMint) external returns (uint256);
}
interface ICurvePoolPoL {
    function coins(uint256 index) external view returns (address);
    function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256);
    function remove_liquidity_one_coin(uint256 lp, int128 coinIndex, uint256 minAmount) external;
}
interface ICurveGaugePoL {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;
    function claim_rewards() external;
    function balanceOf(address account) external view returns (uint256);
}
interface IChainlinkFeedPoL {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (
        uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    );
}
interface IUniV3FactoryPoL {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}
interface IUniV3PoolPoL {
    function slot0() external view returns (
        uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality,
        uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked
    );
    function observe(uint32[] calldata secondsAgos)
        external view returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}
interface IUniV3PositionManagerPoL {
    struct Position {
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
    function positions(uint256 tokenId) external view returns (Position memory);
    function ownerOf(uint256 tokenId) external view returns (address);
    function factory() external view returns (address);
    function increaseLiquidity(IncreaseLiquidityParams calldata params)
        external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1);
    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external payable returns (uint256 amount0, uint256 amount1);
    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}
/// @notice Existing CurveYield OmniRouter; it enforces its own min-output protections.
/// @dev swap returns net output to msg.sender. No caller-defined minOut is used.
interface ICurveYieldRouterPoL {
    function swap(address tokenIn, address tokenOut, uint256 amountIn)
        external returns (uint256 amountOut);
}

/// @title Fixed-position PoL treasury manager (v3)
/// @notice One three-coin Curve pool/gauge, one existing Uniswap v3 NFT,
///         two Yearn v3 vaults and exactly two Euler EVK supply vaults.
///         Owner-defined incoming-fund allocations and share-denominated position migrations.
/// @dev No mint/new range/borrow functionality. Uniswap policy actions require
///      a trusted keeper; rate-triggered migration is public and oracle guarded.
contract PoLManager {
    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;
    uint256 private entered = 1;

    struct DeployConfig {
        address initialOwner;
        address curvePool;
        address curveLpToken;
        address curveGauge;             // zero disables gauge functionality
        address[3] curveCoins;          // exact coins(0..2), no underlying/zap
        bool curveIsNG;                 // true: add_liquidity(uint256[],uint256)
        address uniPositionManager;
        uint256 uniTokenId;             // existing, not minted by this contract
        address[2] yearnVaults;       // Two Yearn v3 vaults, four-argument redeem
        uint8 sdtYearnIndex;           // Exactly one designated Yearn SDT underlying (0 or 1)
        address[2] eulerMarkets;       // Euler EVK ERC4626 supply vaults
        address sdtToken;
        uint8 sdtEulerIndex;           // 0 or 1, must have asset() == SDT
        address swapRouter;            // CurveYield OmniRouter swap(address,address,uint256)
    }

    struct FeedConfig {
        address feed;
        uint32 maxAge;
        uint8 tokenDecimals;
        uint8 feedDecimals;
    }

    struct Route {
        uint128 maxAmountPerSwap;     // raw ERC20 units, configured per Curve conversion
        uint8 curveCoinIndex;
        bool enabled;
    }

    struct UniPolicy {
        uint32 twapSeconds;
        uint32 minActionInterval;
        uint24 maxSpotTwapDifference;
        int24 bufferTicks;
        uint16 outOfRangeWithdrawBps;
        uint128 maxAdd0;
        uint128 maxAdd1;
        bool enabled;
    }

    /// @notice A migration is denominated in native position units:
    ///         Curve LP/gauge receipt units, ERC4626 share units, or NFT liquidity BPS.
    /// @dev Positions: 0 Curve; 1 existing Uni NFT; 2/3 Yearn; 4/5 Euler.
    ///      minDestinationShares is a post-deposit guard, not a router minOut.
    struct Migration {
        uint8 source;
        uint8 destination;
        uint256 amount;            // For NFT ONLY: 1..10000 of current liquidity.
        uint8 curveExitCoin;       // Relevant only when source == Curve.
        uint16 uniToken0Bps;       // Split target NFT funding between token0/token1.
        uint256 minDestinationShares; // Vault/Curve minted shares (not swap minOut).
        uint128 minUniLiquidity;   // Destination NFT newly minted liquidity floor.
        uint256 minUniRemoved0;   // NFT principal removal minima, zero otherwise.
        uint256 minUniRemoved1;
    }

    struct RateParams {
        uint256 quoteAmountIn;       // raw token units for Curve get_dy
        uint256 targetRateWad;       // token-out per token-in, 18 decimals
        uint16 maxOracleDeviationBps;
        uint16 yearnRedeemBps;       // percent of held Yearn shares per event
        uint16 sdtRedeemBps;         // percent of held SDT Euler shares per event
        uint32 minPersistSeconds;
        uint32 cooldownSeconds;
        bool enabled;
    }

    struct RateState {
        RateParams params;
        uint64 armedAt;
        uint64 lastObservedAt;
        uint64 lastTriggeredAt;
        uint256 lastObservedRateWad;
    }

    address public owner;
    address public pendingOwner;
    address public guardian;
    bool public paused;
    mapping(address => bool) public operators;

    address public immutable curvePool;
    address public immutable curveLpToken;
    address public immutable curveGauge;
    address[3] public curveCoins;
    bool public immutable curveIsNG;
    bool public autoStakeCurve;

    address public immutable uniPositionManager;
    address public immutable uniPool;
    uint256 public immutable uniTokenId;
    address public immutable uniToken0;
    address public immutable uniToken1;
    int24 public immutable uniLowerTick;
    int24 public immutable uniUpperTick;
    UniPolicy public uniPolicy;
    uint256 public lastUniActionAt;

    address[2] public yearnVaults;
    address[2] public yearnAssets;
    uint8 public immutable sdtYearnIndex;
    address[2] public eulerMarkets;
    address[2] public eulerAssets;
    address public immutable sdtToken;
    uint8 public immutable sdtEulerIndex;
    address public immutable swapRouter;

    // 0,1: Yearn; 2,3: Euler. PPS in raw asset units per one full vault share.
    uint256[4] public highWatermarkPPS;
    uint256[4] public trackedShares;
    uint256[4] private shareUnits;

    uint16 public cyvlSDTProfitShare; // Basis points, 0..5000 (0%..50%).
    address public cyvlSDTProfitRecipient;
    mapping(address => uint128) public sdtSwapLimits;
    address[] public gaugeRewardTokens;
    uint256 public uniPrincipalOwed0;
    uint256 public uniPrincipalOwed1;
    uint256 public uniPendingCompound0;
    uint256 public uniPendingCompound1;
    bool public uniNftReceived;

    mapping(address => FeedConfig) public priceFeeds;
    mapping(address => Route) internal routes;
    mapping(uint8 => RateState) internal rateStates; // fromIndex * 3 + toIndex
    uint16 public maxCurveSlippageBps = 300;
    uint16 public maxYearnLossBps = 100;
    uint16 public maxEulerLossBps = 100;
    uint32 public globalRateCooldown = 1 days;
    uint256 public lastGlobalRateExecutionAt;

    // Six-position percentage table; all configured BPS must total 10000.
    uint16[6] public positionAllocationBps;
    bool public allocationsConfigured;
    uint16 public uniAllocationToken0Bps = 5000;

    // Track only externally arrived ERC20 balance increases, not cash flows
    // generated internally by redemptions, harvests or router conversions.
    address[] public fundingTokens;
    mapping(address => bool) public isFundingToken;
    mapping(address => uint256) public observedFundingBalance;
    mapping(address => uint256) public availableIncomingFunds;

    event OwnerProposed(address indexed newOwner);
    event OwnerAccepted(address indexed newOwner);
    event OperatorUpdated(address indexed operator, bool enabled);
    event Paused(bool paused);
    event PriceFeedSet(address indexed token, address indexed feed, uint32 maxAge);
    event RouteSet(address indexed token, uint8 indexed coinIndex, bool enabled);
    event SdtSwapLimitSet(address indexed token, uint128 maximum);
    event ProfitShareSet(uint16 bps, address indexed recipient);
    event ProfitPaid(address indexed recipient, uint256 sdtAmount);
    event WatermarkUpdated(uint8 indexed slot, uint256 pps, uint256 sharesRedeemed, uint256 assetsPaid);
    event GaugeRewardTokensSet(address[] tokens);
    event UniCompounded(uint256 amount0, uint256 amount1, uint128 liquidity);
    event CurveDeposit(uint8 indexed coinIndex, uint256 assets, uint256 lpMinted, bool staked);
    event CurveWithdrawal(uint8 indexed coinIndex, uint256 lpBurned, uint256 assetsReceived);
    event GaugeHarvested(uint256 rewardsProcessed);
    event UniPolicyAction(uint8 indexed action, uint256 amount0, uint256 amount1, uint128 liquidity);
    event UniFeesCollected(uint256 amount0, uint256 amount1);
    event VaultDeposit(address indexed vault, uint256 assets, uint256 shares);
    event VaultRedeem(address indexed vault, uint256 shares, uint256 assets);
    event RateRuleSet(uint8 indexed from, uint8 indexed to, bool enabled);
    event RateObserved(uint8 indexed from, uint8 indexed to, uint256 spotRateWad, bool armed);
    event RateTriggered(uint8 indexed from, uint8 indexed to, uint256 yearnShares, uint256 sdtShares);
    event SwapConverted(address indexed input, address indexed output, uint256 amountIn, uint256 amountOut);
    event PositionAllocationsSet(uint16[6] allocationBps);
    event UniAllocationSplitSet(uint16 token0Bps);
    event FundingTokenSet(address indexed token, bool enabled);
    event IncomingFundsDetected(address indexed token, uint256 amount);
    event IncomingFundsAllocated(address indexed token, uint256 amount);
    event LiquidityMigrated(uint8 indexed source, uint8 indexed destination,
        uint256 sourceUnits, uint256 destinationUnits);

    error Unauthorized();
    error InvalidConfiguration();
    error WrongState();
    error OutOfBounds();
    error InvalidOracle();
    error TooMuchSlippage();
    error InvalidToken();
    error InvalidNFT();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }
    modifier onlyOperator() {
        if (msg.sender != owner && !operators[msg.sender]) revert Unauthorized();
        _;
    }
    modifier whenActive() {
        if (paused) revert WrongState();
        _;
    }
    /// @dev Capture external transfers before any internal token movement, then
    ///      reset observed balances after it. This prevents redeems/harvests from
    ///      being mistaken for new treasury deposits in the next allocation call.
    modifier trackIncoming() {
        _observeFundingTokens();
        _;
        _checkpointFundingTokens();
    }

    modifier nonReentrant() {
        if (entered != 1) revert WrongState();
        entered = 2;
        _;
        entered = 1;
    }

    constructor(DeployConfig memory c) {
        if (
            c.initialOwner == address(0) || c.curvePool.code.length == 0 ||
            c.curveLpToken.code.length == 0 || c.uniPositionManager.code.length == 0 ||
            c.yearnVaults[0].code.length == 0 || c.yearnVaults[1].code.length == 0 ||
            c.yearnVaults[0] == c.yearnVaults[1] || c.swapRouter.code.length == 0 ||
            c.sdtYearnIndex > 1 ||
            c.sdtToken.code.length == 0 || c.sdtEulerIndex > 1 ||
            c.eulerMarkets[0].code.length == 0 || c.eulerMarkets[1].code.length == 0 ||
            c.eulerMarkets[0] == c.eulerMarkets[1] ||
            c.yearnVaults[0] == c.eulerMarkets[0] || c.yearnVaults[0] == c.eulerMarkets[1] ||
            c.yearnVaults[1] == c.eulerMarkets[0] || c.yearnVaults[1] == c.eulerMarkets[1] ||
            (c.curveGauge != address(0) && c.curveGauge.code.length == 0)
        ) revert InvalidConfiguration();
        owner = c.initialOwner;
        curvePool = c.curvePool;
        curveLpToken = c.curveLpToken;
        curveGauge = c.curveGauge;
        curveIsNG = c.curveIsNG;
        uniPositionManager = c.uniPositionManager;
        uniTokenId = c.uniTokenId;
        sdtYearnIndex = c.sdtYearnIndex;
        for (uint8 i; i < 2; ++i) {
            yearnVaults[i] = c.yearnVaults[i];
            yearnAssets[i] = IERC4626PoL(c.yearnVaults[i]).asset();
            if (yearnAssets[i].code.length == 0) revert InvalidConfiguration();
            _initializeWatermark(i, c.yearnVaults[i]);
        }
        sdtToken = c.sdtToken;
        sdtEulerIndex = c.sdtEulerIndex;
        swapRouter = c.swapRouter;
        if (yearnAssets[c.sdtYearnIndex] != c.sdtToken) revert InvalidConfiguration();

        for (uint256 i; i < 3; ++i) {
            if (c.curveCoins[i].code.length == 0) revert InvalidConfiguration();
            if (ICurvePoolPoL(c.curvePool).coins(i) != c.curveCoins[i]) revert InvalidConfiguration();
            for (uint256 j; j < i; ++j) {
                if (c.curveCoins[i] == c.curveCoins[j]) revert InvalidConfiguration();
            }
            curveCoins[i] = c.curveCoins[i];
        }
        for (uint256 i; i < 2; ++i) {
            eulerMarkets[i] = c.eulerMarkets[i];
            eulerAssets[i] = IERC4626PoL(c.eulerMarkets[i]).asset();
            if (eulerAssets[i].code.length == 0) revert InvalidConfiguration();
            _initializeWatermark(uint8(i + 2), c.eulerMarkets[i]);
        }
        if (eulerAssets[c.sdtEulerIndex] != c.sdtToken) revert InvalidConfiguration();
        if (c.curveGauge != address(0)) {
            // Check lp_token() wherever the gauge exposes it. Some legacy gauge
            // implementations omit this getter; their asset must be checked
            // against deployment configuration before enabling staking.
            (bool gaugeReadable, bytes memory gaugeData) = c.curveGauge.staticcall(
                abi.encodeWithSignature("lp_token()")
            );
            if (gaugeReadable && gaugeData.length >= 32 &&
                abi.decode(gaugeData, (address)) != c.curveLpToken) revert InvalidConfiguration();
        }

        IUniV3PositionManagerPoL.Position memory p =
            IUniV3PositionManagerPoL(c.uniPositionManager).positions(c.uniTokenId);
        if (p.token0.code.length == 0 || p.token1.code.length == 0 || p.tickLower >= p.tickUpper) {
            revert InvalidNFT();
        }
        uniToken0 = p.token0;
        uniToken1 = p.token1;
        uniLowerTick = p.tickLower;
        uniUpperTick = p.tickUpper;
        address pool = IUniV3FactoryPoL(IUniV3PositionManagerPoL(c.uniPositionManager).factory())
            .getPool(p.token0, p.token1, p.fee);
        if (pool.code.length == 0) revert InvalidNFT();
        uniPool = pool;
    }

    // ---------------------------------------------------------------------
    // AUTHORIZATION & CONFIGURATION
    // ---------------------------------------------------------------------

    function _initializeWatermark(uint8 slot, address vault) private {
        uint8 decimals_ = IERC20PoL(vault).decimals();
        if (decimals_ > 36) revert InvalidConfiguration();
        uint256 unit = 10 ** uint256(decimals_);
        uint256 pps = IERC4626PoL(vault).convertToAssets(unit);
        if (pps == 0) revert InvalidConfiguration();
        shareUnits[slot] = unit;
        highWatermarkPPS[slot] = pps;
    }

    function setCyvlSDTProfitShare(uint16 bps) external onlyOwner {
        if (bps > 5000 || (bps != 0 && cyvlSDTProfitRecipient.code.length == 0)) {
            revert InvalidConfiguration();
        }
        // Starting a positive fee after a zero-fee interval establishes a new
        // acquisition high watermark; old appreciation is not retroactively taxed.
        if (cyvlSDTProfitShare == 0 && bps != 0) {
            for (uint8 slot; slot < 4; ++slot) {
                uint256 pps = currentPPS(slot);
                if (pps > highWatermarkPPS[slot]) {
                    highWatermarkPPS[slot] = pps;
                    emit WatermarkUpdated(slot, pps, 0, 0);
                }
                address vault = _vault(slot);
                trackedShares[slot] = IERC20PoL(vault).balanceOf(address(this));
            }
        }
        cyvlSDTProfitShare = bps;
        emit ProfitShareSet(bps, cyvlSDTProfitRecipient);
    }

    function setCyvlSDTProfitRecipient(address recipient) external onlyOwner {
        if (recipient.code.length == 0) revert InvalidConfiguration();
        cyvlSDTProfitRecipient = recipient;
        emit ProfitShareSet(cyvlSDTProfitShare, recipient);
    }

    /// @notice Approves inputs for conversion to SDT only; actual routes and price guards live on the router.
    function setSdtSwapLimit(address input, uint128 maxPerSwap) external onlyOwner {
        if (input == address(0) || input == sdtToken) revert InvalidConfiguration();
        if (maxPerSwap != 0 && input.code.length == 0) revert InvalidToken();
        sdtSwapLimits[input] = maxPerSwap;
        emit SdtSwapLimitSet(input, maxPerSwap);
    }

    function setGaugeRewardTokens(address[] calldata rewardTokens) external onlyOwner {
        if (rewardTokens.length > 16) revert OutOfBounds();
        delete gaugeRewardTokens;
        for (uint256 i; i < rewardTokens.length; ++i) {
            if (rewardTokens[i].code.length == 0) revert InvalidToken();
            for (uint256 j; j < i; ++j) {
                if (rewardTokens[i] == rewardTokens[j]) revert InvalidConfiguration();
            }
            gaugeRewardTokens.push(rewardTokens[i]);
        }
        emit GaugeRewardTokensSet(rewardTokens);
    }

    function proposeOwner(address successor) external onlyOwner {
        if (successor == address(0)) revert InvalidConfiguration();
        pendingOwner = successor;
        emit OwnerProposed(successor);
    }

    function acceptOwner() external {
        if (msg.sender == address(0) || msg.sender != pendingOwner) revert Unauthorized();
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnerAccepted(msg.sender);
    }

    function setOperator(address account, bool enabled) external onlyOwner {
        if (account == address(0)) revert InvalidConfiguration();
        operators[account] = enabled;
        emit OperatorUpdated(account, enabled);
    }

    function setGuardian(address account) external onlyOwner { guardian = account; }
    function setPaused(bool state) external {
        if (msg.sender != owner && !(msg.sender == guardian && state)) revert Unauthorized();
        paused = state;
        emit Paused(state);
    }

    function setSafetyLimits(uint16 curveSlippage, uint16 yearnLoss, uint16 eulerLoss)
        external onlyOwner
    {
        if (curveSlippage > 1500 || yearnLoss > 1000 || eulerLoss > 1000) revert OutOfBounds();
        maxCurveSlippageBps = curveSlippage;
        maxYearnLossBps = yearnLoss;
        maxEulerLossBps = eulerLoss;
    }

    function setPriceFeed(address token, address feed, uint32 maxAge) external onlyOwner {
        if (token.code.length == 0 || feed.code.length == 0 || maxAge == 0 || maxAge > 7 days) {
            revert InvalidConfiguration();
        }
        uint8 d = IERC20PoL(token).decimals();
        uint8 fd = IChainlinkFeedPoL(feed).decimals();
        if (d > 18 || fd > 18) revert OutOfBounds();
        priceFeeds[token] = FeedConfig(feed, maxAge, d, fd);
        _priceWad(token); // reject stale / invalid oracle at configuration time
        emit PriceFeedSet(token, feed, maxAge);
    }

    function quoteTokenAmount(address tokenIn, address tokenOut, uint256 amountIn)
        public view returns (uint256)
    {
        FeedConfig memory fIn = priceFeeds[tokenIn];
        FeedConfig memory fOut = priceFeeds[tokenOut];
        if (fIn.feed == address(0) || fOut.feed == address(0)) revert InvalidOracle();
        uint256 usdValueWad = amountIn * _priceWad(tokenIn) / (10 ** fIn.tokenDecimals);
        return usdValueWad * (10 ** fOut.tokenDecimals) / _priceWad(tokenOut);
    }

    function _priceWad(address token) internal view returns (uint256) {
        FeedConfig memory f = priceFeeds[token];
        if (f.feed == address(0)) revert InvalidOracle();
        (uint80 round, int256 px,, uint256 updatedAt, uint80 answeredInRound) =
            IChainlinkFeedPoL(f.feed).latestRoundData();
        if (px <= 0 || updatedAt == 0 || updatedAt > block.timestamp ||
            block.timestamp - updatedAt > f.maxAge || answeredInRound < round)
        {
            revert InvalidOracle();
        }
        return uint256(px) * 10 ** (18 - f.feedDecimals);
    }

    function _oracleFloor(address tokenIn, address tokenOut, uint256 amountIn, uint16 toleranceBps)
        internal view returns (uint256)
    {
        if (toleranceBps >= BPS) revert OutOfBounds();
        uint256 floor = quoteTokenAmount(tokenIn, tokenOut, amountIn) * (BPS - toleranceBps) / BPS;
        if (floor == 0) revert InvalidOracle();
        return floor;
    }

    /// @notice Associate a treasury input with one Curve coin; router owns the actual path.
    function setRoute(address input, uint8 coinIndex, uint128 maxAmount, bool enabled)
        external onlyOwner
    {
        if (coinIndex > 2 || input == address(0)) revert OutOfBounds();
        if (enabled && (input.code.length == 0 || maxAmount == 0)) revert InvalidConfiguration();
        routes[input] = Route(maxAmount, coinIndex, enabled);
        emit RouteSet(input, coinIndex, enabled);
    }

    function getRoute(address token) external view returns (Route memory) { return routes[token]; }

    function setCurveAutoStake(bool enabled) external onlyOwner {
        if (enabled && curveGauge == address(0)) revert InvalidConfiguration();
        autoStakeCurve = enabled;
    }

    // ---------------------------------------------------------------------
    // NEWLY TRANSFERRED FUNDS AND SIX-WAY ALLOCATION
    // ---------------------------------------------------------------------

    function setPositionAllocations(uint16[6] calldata bps) external onlyOwner {
        uint256 total;
        for (uint8 i; i < 6; ++i) total += bps[i];
        if (total != BPS) revert InvalidConfiguration();
        for (uint8 i; i < 6; ++i) positionAllocationBps[i] = bps[i];
        allocationsConfigured = true;
        emit PositionAllocationsSet(bps);
    }

    /// @notice Set the funding split for additional liquidity on the *same* NFT.
    /// @dev Does not change ticks, positions or the NFT identifier.
    function setUniAllocationToken0Bps(uint16 bps) external onlyOwner {
        if (bps > BPS) revert OutOfBounds();
        uniAllocationToken0Bps = bps;
        emit UniAllocationSplitSet(bps);
    }

    /// @notice Whitelist a standard, non-rebasing funding ERC20. An already
    ///         held balance is baseline capital, not newly transferred funds.
    function setFundingToken(address token, bool enabled) external onlyOwner {
        if (enabled == isFundingToken[token]) revert WrongState();
        if (enabled) {
            if (token.code.length == 0 || token == curveLpToken || token == curveGauge ||
                token == yearnVaults[0] || token == yearnVaults[1] ||
                token == eulerMarkets[0] || token == eulerMarkets[1] ||
                fundingTokens.length >= 12) revert InvalidConfiguration();
            isFundingToken[token] = true;
            fundingTokens.push(token);
        } else {
            uint256 length = fundingTokens.length;
            for (uint256 i; i < length; ++i) {
                if (fundingTokens[i] == token) {
                    fundingTokens[i] = fundingTokens[length - 1];
                    fundingTokens.pop();
                    break;
                }
            }
            isFundingToken[token] = false;
            availableIncomingFunds[token] = 0;
        }
        observedFundingBalance[token] = IERC20PoL(token).balanceOf(address(this));
        emit FundingTokenSet(token, enabled);
    }

    function _observeFundingTokens() internal {
        for (uint256 i; i < fundingTokens.length; ++i) {
            address token = fundingTokens[i];
            uint256 actual = IERC20PoL(token).balanceOf(address(this));
            uint256 prior = observedFundingBalance[token];
            if (actual > prior) {
                uint256 delta = actual - prior;
                availableIncomingFunds[token] += delta;
                emit IncomingFundsDetected(token, delta);
            } else if (actual < prior && availableIncomingFunds[token] > actual) {
                availableIncomingFunds[token] = actual;
            }
            observedFundingBalance[token] = actual;
        }
    }

    function _checkpointFundingTokens() internal {
        for (uint256 i; i < fundingTokens.length; ++i) {
            address token = fundingTokens[i];
            uint256 actual = IERC20PoL(token).balanceOf(address(this));
            if (availableIncomingFunds[token] > actual) availableIncomingFunds[token] = actual;
            observedFundingBalance[token] = actual;
        }
    }

    /// @notice Unsynchronized incoming ERC20 amount, including transfers since
    ///         the previous manager operation. Keeper may pass amount=0 to deploy all.
    function pendingIncomingFunds(address token) external view returns (uint256 pending) {
        if (!isFundingToken[token]) return 0;
        uint256 actual = IERC20PoL(token).balanceOf(address(this));
        uint256 known = observedFundingBalance[token];
        pending = availableIncomingFunds[token];
        if (actual > known) pending += actual - known;
        if (pending > actual) pending = actual;
    }

    /// @notice Explicitly refresh direct-transfer credits without allocating.
    function syncIncomingFunds() external nonReentrant trackIncoming { }

    /// @notice Distribute the caller-specified portion of *newly received*
    ///         ERC20 funds according to the owner table. Pass amount=0 to
    ///         allocate the entire pending incoming credit. The router enforces
    ///         swap price guards; this contract passes no minOut to swaps.
    /// @dev One execution is atomic: if a position cannot accept its slice,
    ///      nothing is moved. Unspent Uni NFT inputs remain idle treasury funds.
    function allocateIncomingFunds(address token, uint256 amount)
        external onlyOperator whenActive nonReentrant trackIncoming
        returns (uint256[6] memory receivedUnits)
    {
        if (!allocationsConfigured || !isFundingToken[token]) revert InvalidConfiguration();
        if (amount == 0) amount = availableIncomingFunds[token];
        if (amount == 0 || amount > availableIncomingFunds[token]) revert InvalidConfiguration();
        availableIncomingFunds[token] -= amount;
        uint256 remaining = amount;
        uint8 last;
        for (uint8 i; i < 6; ++i) if (positionAllocationBps[i] != 0) last = i;
        for (uint8 i; i < 6; ++i) {
            uint256 part = i == last ? remaining : amount * positionAllocationBps[i] / BPS;
            if (i != last) remaining -= part;
            if (part == 0) continue;
            receivedUnits[i] = _investToPosition(
                i, token, part, address(0), 0, uniAllocationToken0Bps, 0, 1
            );
        }
        emit IncomingFundsAllocated(token, amount);
    }

    // ---------------------------------------------------------------------
    // TOKEN MOVEMENT & CONTROLLED CONVERSIONS
    // ---------------------------------------------------------------------

    function _erc20Call(address token, bytes memory data) private {
        if (token.code.length == 0) revert InvalidToken();
        (bool ok, bytes memory result) = token.call(data);
        if (!ok || (result.length != 0 && (result.length < 32 || !abi.decode(result, (bool))))) {
            revert TransferFailed();
        }
    }

    function _approveExact(address token, address spender, uint256 amount) private {
        _erc20Call(token, abi.encodeWithSelector(IERC20PoL.approve.selector, spender, 0));
        if (amount != 0) {
            _erc20Call(token, abi.encodeWithSelector(IERC20PoL.approve.selector, spender, amount));
        }
    }

    function rescueToken(address token, address recipient, uint256 amount) external onlyOwner nonReentrant trackIncoming {
        if (recipient == address(0)) revert InvalidConfiguration();
        // Managed receipt shares are never ordinary "dust"; extracting them
        // here would bypass high-watermark revenue splitting.
        if (token == yearnVaults[0] || token == yearnVaults[1] ||
            token == eulerMarkets[0] || token == eulerMarkets[1]) revert InvalidConfiguration();
        _erc20Call(token, abi.encodeWithSelector(IERC20PoL.transfer.selector, recipient, amount));
    }

    function _curveCoin(address token) internal view returns (bool found, uint8 index) {
        for (uint8 i; i < 3; ++i) {
            if (token == curveCoins[i]) return (true, i);
        }
    }

    /// @notice Use the existing router's own oracle/TWAP/slippage protections.
    /// @dev Neither this contract nor harvest() supplies a separate minimum output.
    function _swap(address input, address output, uint256 amount) internal returns (uint256 received) {
        if (amount == 0 || input == output) revert InvalidConfiguration();
        uint256 beforeBalance = IERC20PoL(output).balanceOf(address(this));
        _approveExact(input, swapRouter, amount);
        uint256 reported = ICurveYieldRouterPoL(swapRouter).swap(input, output, amount);
        _approveExact(input, swapRouter, 0);
        received = IERC20PoL(output).balanceOf(address(this)) - beforeBalance;
        if (received == 0 || received != reported) revert TooMuchSlippage();
        emit SwapConverted(input, output, amount, received);
    }

    function _convertToSDT(address token, uint256 amount) internal returns (uint256) {
        if (amount == 0) return 0;
        if (token == sdtToken) return amount; // SDT Yearn / Euler: withdraw only.
        uint128 maxAmount = sdtSwapLimits[token];
        if (maxAmount == 0 || amount > maxAmount) revert InvalidConfiguration();
        return _swap(token, sdtToken, amount);
    }

    function _convertToCurveCoin(address token, uint256 amount)
        internal returns (uint8 index, uint256 amountOut)
    {
        (bool direct, uint8 directIndex) = _curveCoin(token);
        if (direct) return (directIndex, amount);
        Route storage cfg = routes[token];
        if (!cfg.enabled || cfg.maxAmountPerSwap == 0 || amount > cfg.maxAmountPerSwap) {
            revert InvalidConfiguration();
        }
        uint8 coinIndex = cfg.curveCoinIndex;
        amountOut = _swap(token, curveCoins[coinIndex], amount);
        return (coinIndex, amountOut);
    }

    // ---------------------------------------------------------------------
    // CURVE STABLEPOOL (SINGLE-COIN IN AND OUT)
    // ---------------------------------------------------------------------

    function _curveDeposit(uint8 coinIndex, uint256 amount, uint256 callerMinLp)
        internal returns (uint256 minted)
    {
        if (coinIndex > 2 || amount == 0) revert OutOfBounds();
        uint256 floor = _oracleFloor(curveCoins[coinIndex], curveLpToken, amount, maxCurveSlippageBps);
        uint256 minimum = callerMinLp > floor ? callerMinLp : floor;
        uint256 beforeLp = IERC20PoL(curveLpToken).balanceOf(address(this));
        address input = curveCoins[coinIndex];
        _approveExact(input, curvePool, amount);
        if (curveIsNG) {
            uint256[] memory quantities = new uint256[](3);
            quantities[coinIndex] = amount;
            ICurveNGPoL(curvePool).add_liquidity(quantities, minimum);
        } else {
            uint256[3] memory quantities;
            quantities[coinIndex] = amount;
            ICurve3FixedPoL(curvePool).add_liquidity(quantities, minimum);
        }
        _approveExact(input, curvePool, 0);
        minted = IERC20PoL(curveLpToken).balanceOf(address(this)) - beforeLp;
        if (minted < minimum) revert TooMuchSlippage();
        if (autoStakeCurve) {
            _approveExact(curveLpToken, curveGauge, minted);
            ICurveGaugePoL(curveGauge).deposit(minted);
            _approveExact(curveLpToken, curveGauge, 0);
        }
        emit CurveDeposit(coinIndex, amount, minted, autoStakeCurve);
    }

    function depositCurveOne(uint8 coinIndex, uint256 amount, uint256 minLp)
        external onlyOperator whenActive nonReentrant trackIncoming returns (uint256)
    {
        return _curveDeposit(coinIndex, amount, minLp);
    }

    function _curveWithdraw(uint8 coinIndex, uint256 lpAmount, uint256 callerMinOut,
        bool unstakeFirst) internal returns (uint256 received)
    {
        if (coinIndex > 2 || lpAmount == 0) revert OutOfBounds();
        if (unstakeFirst) {
            if (curveGauge == address(0)) revert InvalidConfiguration();
            ICurveGaugePoL(curveGauge).withdraw(lpAmount);
        }
        uint256 floor = _oracleFloor(curveLpToken, curveCoins[coinIndex], lpAmount, maxCurveSlippageBps);
        uint256 minimum = callerMinOut > floor ? callerMinOut : floor;
        uint256 beforeBal = IERC20PoL(curveCoins[coinIndex]).balanceOf(address(this));
        _approveExact(curveLpToken, curvePool, lpAmount);
        ICurvePoolPoL(curvePool).remove_liquidity_one_coin(lpAmount, int128(uint128(coinIndex)), minimum);
        _approveExact(curveLpToken, curvePool, 0);
        received = IERC20PoL(curveCoins[coinIndex]).balanceOf(address(this)) - beforeBal;
        if (received < minimum) revert TooMuchSlippage();
        emit CurveWithdrawal(coinIndex, lpAmount, received);
    }

    function withdrawCurveOne(uint8 coinIndex, uint256 lpAmount, uint256 minAmountOut,
        bool unstakeFirst) external onlyOperator nonReentrant trackIncoming returns (uint256)
    {
        return _curveWithdraw(coinIndex, lpAmount, minAmountOut, unstakeFirst);
    }

    function stakeCurveLp(uint256 lpAmount) external onlyOperator whenActive nonReentrant trackIncoming {
        if (curveGauge == address(0) || lpAmount == 0) revert InvalidConfiguration();
        _approveExact(curveLpToken, curveGauge, lpAmount);
        ICurveGaugePoL(curveGauge).deposit(lpAmount);
        _approveExact(curveLpToken, curveGauge, 0);
    }

    function unstakeCurveLp(uint256 lpAmount) external onlyOperator nonReentrant trackIncoming {
        if (curveGauge == address(0) || lpAmount == 0) revert InvalidConfiguration();
        ICurveGaugePoL(curveGauge).withdraw(lpAmount);
    }

    /// @dev Harvest is consolidated below; this older standalone entrypoint is intentionally removed.

    // ---------------------------------------------------------------------
    // ONE IMMUTABLE UNISWAP V3 NFT; NO MINT OR RANGE REPLACEMENT
    // ---------------------------------------------------------------------

    /// @notice Accepts ONLY the specified NFT from the specified position manager.
    function onERC721Received(address, address, uint256 tokenId, bytes calldata)
        external returns (bytes4)
    {
        if (msg.sender != uniPositionManager || tokenId != uniTokenId || uniNftReceived) revert InvalidNFT();
        // Existing tokensOwed may include old principal; do not count it as new earned fees.
        IUniV3PositionManagerPoL.Position memory p =
            IUniV3PositionManagerPoL(uniPositionManager).positions(tokenId);
        uniPrincipalOwed0 = p.tokensOwed0;
        uniPrincipalOwed1 = p.tokensOwed1;
        uniNftReceived = true;
        return this.onERC721Received.selector;
    }

    function _ownedUniPosition() internal view returns (IUniV3PositionManagerPoL.Position memory p) {
        IUniV3PositionManagerPoL manager = IUniV3PositionManagerPoL(uniPositionManager);
        if (manager.ownerOf(uniTokenId) != address(this)) revert InvalidNFT();
        p = manager.positions(uniTokenId);
        if (p.token0 != uniToken0 || p.token1 != uniToken1 ||
            p.tickLower != uniLowerTick || p.tickUpper != uniUpperTick) revert InvalidNFT();
    }

    /// @notice Operator/keeper-controlled policy using Uniswap pool's TWAP tick.
    function configureUniPolicy(UniPolicy calldata policy) external onlyOwner {
        if (
            policy.twapSeconds < 60 || policy.twapSeconds > 86400 ||
            policy.minActionInterval < 300 || policy.maxSpotTwapDifference > 2500 ||
            policy.bufferTicks < 0 || policy.bufferTicks > 2000 ||
            policy.outOfRangeWithdrawBps > BPS ||
            int256(uniLowerTick) + int256(policy.bufferTicks) >=
                int256(uniUpperTick) - int256(policy.bufferTicks)
        ) revert OutOfBounds();
        if (policy.enabled && (policy.outOfRangeWithdrawBps == 0 ||
            policy.maxAdd0 == 0 || policy.maxAdd1 == 0)) revert InvalidConfiguration();
        uniPolicy = policy;
    }

    function uniTicks() public view returns (int24 twap, int24 spot) {
        uint32 duration = uniPolicy.twapSeconds;
        if (duration == 0) revert InvalidConfiguration();
        uint32[] memory secondsAgo = new uint32[](2);
        secondsAgo[0] = duration;
        secondsAgo[1] = 0;
        (int56[] memory cumulatives,) = IUniV3PoolPoL(uniPool).observe(secondsAgo);
        if (cumulatives.length != 2) revert InvalidOracle();
        int56 diff = cumulatives[1] - cumulatives[0];
        int56 d = int56(uint56(duration));
        twap = int24(diff / d);
        if (diff < 0 && diff % d != 0) --twap; // mathematical floor for negative ticks
        (,spot,,,,,) = IUniV3PoolPoL(uniPool).slot0();
    }

    /// @return action 0 = none, 1 = add inside range, 2 = withdraw outside range.
    function uniSignal() public view returns (uint8 action, int24 twap, int24 spot) {
        UniPolicy memory cfg = uniPolicy;
        if (!cfg.enabled) return (0, 0, 0);
        (twap, spot) = uniTicks();
        uint256 distance = twap > spot
            ? uint256(int256(twap) - int256(spot))
            : uint256(int256(spot) - int256(twap));
        if (distance > cfg.maxSpotTwapDifference) return (0, twap, spot);
        int256 t = int256(twap);
        int256 buffer = int256(cfg.bufferTicks);
        if (t >= int256(uniLowerTick) + buffer &&
            t <= int256(uniUpperTick) - buffer) return (1, twap, spot);
        if (t < int256(uniLowerTick) - buffer ||
            t > int256(uniUpperTick) + buffer) return (2, twap, spot);
        return (0, twap, spot);
    }

    /// @notice Conditional add/withdraw; trusted operator sets safe min token and
    ///         minimum liquidity quantities. Policy will not modify position ranges.
    function executeUniPolicy(uint256 desired0, uint256 desired1,
        uint256 min0, uint256 min1, uint128 minLiquidityAdded)
        external onlyOperator whenActive nonReentrant trackIncoming returns (uint8 action)
    {
        if (block.timestamp < lastUniActionAt + uniPolicy.minActionInterval) revert WrongState();
        (action,,) = uniSignal();
        if (action == 0) revert WrongState();
        IUniV3PositionManagerPoL.Position memory position = _ownedUniPosition();
        lastUniActionAt = block.timestamp;
        if (action == 1) {
            uint256 bal0 = IERC20PoL(uniToken0).balanceOf(address(this));
            uint256 bal1 = IERC20PoL(uniToken1).balanceOf(address(this));
            uint256 spare0 = bal0 > uniPendingCompound0 ? bal0 - uniPendingCompound0 : 0;
            uint256 spare1 = bal1 > uniPendingCompound1 ? bal1 - uniPendingCompound1 : 0;
            uint256 amount0 = _least(desired0, _least(uniPolicy.maxAdd0, spare0));
            uint256 amount1 = _least(desired1, _least(uniPolicy.maxAdd1, spare1));
            if (amount0 == 0 && amount1 == 0) revert WrongState();
            _approveExact(uniToken0, uniPositionManager, amount0);
            _approveExact(uniToken1, uniPositionManager, amount1);
            (uint128 delta, uint256 used0, uint256 used1) =
                IUniV3PositionManagerPoL(uniPositionManager).increaseLiquidity(
                    IUniV3PositionManagerPoL.IncreaseLiquidityParams({
                        tokenId: uniTokenId,
                        amount0Desired: amount0,
                        amount1Desired: amount1,
                        amount0Min: min0,
                        amount1Min: min1,
                        deadline: block.timestamp
                    })
                );
            _approveExact(uniToken0, uniPositionManager, 0);
            _approveExact(uniToken1, uniPositionManager, 0);
            if (delta == 0 || delta < minLiquidityAdded) revert TooMuchSlippage();
            emit UniPolicyAction(1, used0, used1, delta);
        } else {
            uint128 removal = uint128(uint256(position.liquidity) *
                uniPolicy.outOfRangeWithdrawBps / BPS);
            if (removal == 0) revert WrongState();
            (uint256 removed0, uint256 removed1) =
                IUniV3PositionManagerPoL(uniPositionManager).decreaseLiquidity(
                    IUniV3PositionManagerPoL.DecreaseLiquidityParams({
                        tokenId: uniTokenId, liquidity: removal,
                        amount0Min: min0, amount1Min: min1,
                        deadline: block.timestamp
                    })
                );
            uniPrincipalOwed0 += removed0;
            uniPrincipalOwed1 += removed1;
            emit UniPolicyAction(2, removed0, removed1, removal);
            // Recovered principal must not be treated as harvested swap fees.
        }
    }

    /// @dev NFT fee collection is deliberately restricted to unified harvest().

    /// @notice Explicit emergency handoff; the NFT ID/range can never be replaced.
    function withdrawUniNFT(address recipient) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert InvalidConfiguration();
        _ownedUniPosition();
        IUniV3PositionManagerPoL(uniPositionManager).safeTransferFrom(address(this), recipient, uniTokenId);
        // The same fixed NFT may be returned later; its then-outstanding
        // tokensOwed are conservatively classified as principal on re-entry.
        uniNftReceived = false;
        uniPrincipalOwed0 = 0;
        uniPrincipalOwed1 = 0;
    }

    // ---------------------------------------------------------------------
    // YEARN V3 / TWO EULER EVK SUPPLY VAULTS
    // ---------------------------------------------------------------------


    /// @dev All four managed ERC4626 positions use one deposit pipeline.
    function _vault(uint8 slot) internal view returns (address) {
        if (slot > 3) revert OutOfBounds();
        return slot < 2 ? yearnVaults[slot] : eulerMarkets[slot - 2];
    }
    function _asset(uint8 slot) internal view returns (address) {
        if (slot > 3) revert OutOfBounds();
        return slot < 2 ? yearnAssets[slot] : eulerAssets[slot - 2];
    }
    function _maxRedeemVault(uint8 slot) internal view returns (uint256) {
        address vault = _vault(slot);
        return slot < 2
            ? IYearnV3PoL(vault).maxRedeem(address(this), maxYearnLossBps)
            : IERC4626PoL(vault).maxRedeem(address(this));
    }
    function _depositVault(uint8 slot, uint256 amount, uint256 minShares)
        internal returns (uint256 shares)
    {
        if (amount == 0) revert OutOfBounds();
        _prepareDeposit(slot);
        address vault = _vault(slot);
        if (amount > IERC4626PoL(vault).maxDeposit(address(this))) revert OutOfBounds();
        address asset = _asset(slot);
        uint256 beforeShares = IERC20PoL(vault).balanceOf(address(this));
        _approveExact(asset, vault, amount);
        shares = IERC4626PoL(vault).deposit(amount, address(this));
        _approveExact(asset, vault, 0);
        if (shares == 0 || shares < minShares ||
            IERC20PoL(vault).balanceOf(address(this)) - beforeShares != shares) revert TooMuchSlippage();
        trackedShares[slot] += shares;
        emit VaultDeposit(vault, amount, shares);
    }
    function _redeemVault(uint8 slot, uint256 shares, uint256 minAssets)
        internal returns (uint256 assets)
    {
        if (shares == 0 || shares > _maxRedeemVault(slot)) revert OutOfBounds();
        address vault = _vault(slot);
        address asset = _asset(slot);
        uint256 expected = IERC4626PoL(vault).previewRedeem(shares);
        uint256 beforeAssets = IERC20PoL(asset).balanceOf(address(this));
        assets = slot < 2
            ? IYearnV3PoL(vault).redeem(shares, address(this), address(this), maxYearnLossBps)
            : IERC4626PoL(vault).redeem(shares, address(this), address(this));
        uint256 received = IERC20PoL(asset).balanceOf(address(this)) - beforeAssets;
        uint256 allowedLoss = slot < 2 ? maxYearnLossBps : maxEulerLossBps;
        uint256 floor = expected * (BPS - allowedLoss) / BPS;
        if (received != assets || assets == 0 || assets < _greater(minAssets, floor)) revert TooMuchSlippage();
        uint256 registered = trackedShares[slot];
        trackedShares[slot] = shares >= registered ? 0 : registered - shares;
        emit VaultRedeem(vault, shares, assets);
    }
    function depositYearn(uint8 index, uint256 amount, uint256 minShares)
        external onlyOperator whenActive nonReentrant trackIncoming returns (uint256 shares)
    {
        return _depositYearn(index, amount, minShares);
    }

    function _depositYearn(uint8 index, uint256 amount, uint256 minShares)
        internal returns (uint256 shares) {
        if (index > 1) revert OutOfBounds();
        return _depositVault(index, amount, minShares);
    }

    function _redeemYearn(uint8 index, uint256 shares, uint256 minAssets)
        internal returns (uint256 assets) {
        if (index > 1) revert OutOfBounds();
        return _redeemVault(index, shares, minAssets);
    }

    function redeemYearn(uint8 index, uint256 shares, uint256 minAssets)
        external onlyOperator nonReentrant trackIncoming returns (uint256)
    {
        if (index > 1) revert OutOfBounds();
        _requireNoUnharvestedGain(index);
        return _redeemYearn(index, shares, minAssets);
    }

    function depositEuler(uint8 marketIndex, uint256 amount, uint256 minShares)
        external onlyOperator whenActive nonReentrant trackIncoming returns (uint256 shares)
    {
        return _depositEuler(marketIndex, amount, minShares);
    }

    function _depositEuler(uint8 marketIndex, uint256 amount, uint256 minShares)
        internal returns (uint256 shares) {
        if (marketIndex > 1) revert OutOfBounds();
        return _depositVault(marketIndex + 2, amount, minShares);
    }

    function _redeemEuler(uint8 marketIndex, uint256 shares, uint256 minAssets)
        internal returns (uint256 assets) {
        if (marketIndex > 1) revert OutOfBounds();
        return _redeemVault(marketIndex + 2, shares, minAssets);
    }

    function redeemEuler(uint8 marketIndex, uint256 shares, uint256 minAssets)
        external onlyOperator nonReentrant trackIncoming returns (uint256)
    {
        if (marketIndex > 1) revert OutOfBounds();
        _requireNoUnharvestedGain(uint8(marketIndex + 2));
        return _redeemEuler(marketIndex, shares, minAssets);
    }

    // ---------------------------------------------------------------------
    // POSITION-TO-POSITION MIGRATION; ONE EXISTING NFT ONLY
    // ---------------------------------------------------------------------

    /// @dev Source denominations:
    ///      0 = LP/gauge units (unstake only what's needed),
    ///      1 = BPS of current NFT liquidity (not NFT fraction of fee claims),
    ///      2/3 = exact Yearn shares, 4/5 = exact Euler shares.
    function migrateLiquidity(Migration calldata m)
        external onlyOperator whenActive nonReentrant trackIncoming
        returns (uint256 destinationUnits)
    {
        if (m.source >= 6 || m.destination >= 6 || m.source == m.destination ||
            m.amount == 0 || m.uniToken0Bps > BPS) revert OutOfBounds();
        address inputA;
        address inputB;
        uint256 assetsA;
        uint256 assetsB;
        if (m.source == 0) {
            if (m.curveExitCoin > 2) revert OutOfBounds();
            uint256 idleLp = IERC20PoL(curveLpToken).balanceOf(address(this));
            if (m.amount > idleLp) {
                if (curveGauge == address(0)) revert WrongState();
                ICurveGaugePoL(curveGauge).withdraw(m.amount - idleLp);
            }
            inputA = curveCoins[m.curveExitCoin];
            assetsA = _curveWithdraw(m.curveExitCoin, m.amount, 0, false);
        } else if (m.source == 1) {
            (assetsA, assetsB) = _removeUniPrincipal(
                m.amount, m.minUniRemoved0, m.minUniRemoved1
            );
            inputA = uniToken0;
            inputB = uniToken1;
        } else if (m.source < 4) {
            uint8 yearnIndex = m.source - 2;
            _requireNoUnharvestedGain(yearnIndex);
            inputA = yearnAssets[yearnIndex];
            assetsA = _redeemYearn(yearnIndex, m.amount, 0);
        } else {
            uint8 eulerIndex = m.source - 4;
            _requireNoUnharvestedGain(uint8(eulerIndex + 2));
            inputA = eulerAssets[eulerIndex];
            assetsA = _redeemEuler(eulerIndex, m.amount, 0);
        }
        destinationUnits = _investToPosition(
            m.destination, inputA, assetsA, inputB, assetsB,
            m.uniToken0Bps, m.minDestinationShares, m.minUniLiquidity
        );
        emit LiquidityMigrated(m.source, m.destination, m.amount, destinationUnits);
    }

    /// @dev Collect *only* the amounts credited by the current decrease,
    ///      leaving preexisting fee claims and principal debt on the NFT.
    ///      Decreasing NFT liquidity never changes its tick range or creates NFTs.
    function _removeUniPrincipal(uint256 bps, uint256 min0, uint256 min1)
        internal returns (uint256 amount0, uint256 amount1)
    {
        if (bps == 0 || bps > BPS) revert OutOfBounds();
        IUniV3PositionManagerPoL.Position memory p = _ownedUniPosition();
        uint128 removedLiquidity = uint128(uint256(p.liquidity) * bps / BPS);
        if (removedLiquidity == 0) revert WrongState();
        (amount0, amount1) = IUniV3PositionManagerPoL(uniPositionManager).decreaseLiquidity(
            IUniV3PositionManagerPoL.DecreaseLiquidityParams({
                tokenId: uniTokenId,
                liquidity: removedLiquidity,
                amount0Min: min0, amount1Min: min1,
                deadline: block.timestamp
            })
        );
        if (amount0 > type(uint128).max || amount1 > type(uint128).max) revert OutOfBounds();
        uniPrincipalOwed0 += amount0;
        uniPrincipalOwed1 += amount1;
        (uint256 paid0, uint256 paid1) = IUniV3PositionManagerPoL(uniPositionManager).collect(
            IUniV3PositionManagerPoL.CollectParams({
                tokenId: uniTokenId,
                recipient: address(this),
                amount0Max: uint128(amount0),
                amount1Max: uint128(amount1)
            })
        );
        if (paid0 != amount0 || paid1 != amount1) revert WrongState();
        uniPrincipalOwed0 -= paid0;
        uniPrincipalOwed1 -= paid1;
        emit UniPolicyAction(2, paid0, paid1, removedLiquidity);
    }

    function _toUnderlying(address token, address underlying, uint256 amount)
        internal returns (uint256)
    {
        if (amount == 0) return 0;
        if (token == underlying) return amount;
        return _swap(token, underlying, amount);
    }

    /// @dev Any source produces at most two assets; only NFT withdrawals
    ///      produce both. All swaps use the existing guarded router ABI.
    function _investToPosition(
        uint8 destination, address tokenA, uint256 amountA,
        address tokenB, uint256 amountB, uint16 uniToken0SplitBps,
        uint256 minShares, uint128 minUniLiquidity
    ) internal returns (uint256 destinationUnits) {
        if (amountA == 0 && amountB == 0) revert WrongState();
        if (destination == 0) {
            if (amountA != 0) {
                (uint8 coin, uint256 assets) = _convertToCurveCoin(tokenA, amountA);
                destinationUnits += _curveDeposit(coin, assets, 0);
            }
            if (amountB != 0) {
                (uint8 coin, uint256 assets) = _convertToCurveCoin(tokenB, amountB);
                destinationUnits += _curveDeposit(coin, assets, 0);
            }
        } else if (destination == 1) {
            if (amountB != 0 || uniToken0SplitBps > BPS) revert InvalidConfiguration();
            destinationUnits = _addUniFromAsset(tokenA, amountA, uniToken0SplitBps, minUniLiquidity);
        } else if (destination < 4) {
            uint8 idx = destination - 2;
            address asset = yearnAssets[idx];
            uint256 converted = _toUnderlying(tokenA, asset, amountA) +
                _toUnderlying(tokenB, asset, amountB);
            destinationUnits = _depositYearn(idx, converted, minShares);
        } else if (destination < 6) {
            uint8 idx = destination - 4;
            address asset = eulerAssets[idx];
            uint256 converted = _toUnderlying(tokenA, asset, amountA) +
                _toUnderlying(tokenB, asset, amountB);
            destinationUnits = _depositEuler(idx, converted, minShares);
        } else {
            revert OutOfBounds();
        }
        if (destinationUnits == 0 || destinationUnits < minShares) revert TooMuchSlippage();
    }

    function _addUniFromAsset(address token, uint256 amount, uint16 token0Bps, uint128 minLiquidity)
        internal returns (uint256 minted)
    {
        if (amount == 0 || !uniPolicy.enabled || token0Bps > BPS) revert InvalidConfiguration();
        _ownedUniPosition();
        (uint8 action,,) = uniSignal();
        if (action != 1) revert WrongState();
        uint256 part0 = amount * token0Bps / BPS;
        uint256 part1 = amount - part0;
        uint256 amount0 = _toUnderlying(token, uniToken0, part0);
        uint256 amount1 = _toUnderlying(token, uniToken1, part1);
        if (amount0 == 0 && amount1 == 0) revert WrongState();
        if (amount0 > uniPolicy.maxAdd0 || amount1 > uniPolicy.maxAdd1) revert OutOfBounds();
        _approveExact(uniToken0, uniPositionManager, amount0);
        _approveExact(uniToken1, uniPositionManager, amount1);
        (uint128 liquidity, uint256 used0, uint256 used1) =
            IUniV3PositionManagerPoL(uniPositionManager).increaseLiquidity(
                IUniV3PositionManagerPoL.IncreaseLiquidityParams({
                    tokenId: uniTokenId,
                    amount0Desired: amount0, amount1Desired: amount1,
                    amount0Min: 0, amount1Min: 0,
                    deadline: block.timestamp
                })
            );
        _approveExact(uniToken0, uniPositionManager, 0);
        _approveExact(uniToken1, uniPositionManager, 0);
        if (liquidity == 0 || liquidity < minLiquidity ||
            used0 > amount0 || used1 > amount1) revert TooMuchSlippage();
        minted = liquidity;
        emit UniCompounded(used0, used1, liquidity);
    }

    // ---------------------------------------------------------------------
    // UNIFIED HARVEST: CURVE REWARDS, UNI FEES, YEARN/EULER PPS PROFITS
    // ---------------------------------------------------------------------

    /// @notice A one-share PPS quote per source, in raw underlying token units.
    function currentPPS(uint8 slot) public view returns (uint256) {
        if (slot > 3) revert OutOfBounds();
        address vault = _vault(slot);
        return IERC4626PoL(vault).convertToAssets(shareUnits[slot]);
    }

    /// @dev Depositing or redeeming shares while profit is outstanding would
    ///      distort the high-watermark entitlement. Harvest first.
    function _requireNoUnharvestedGain(uint8 slot) internal view {
        if (cyvlSDTProfitShare > 0 && trackedShares[slot] != 0 &&
            currentPPS(slot) > highWatermarkPPS[slot]) revert WrongState();
    }

    /// @dev When a position begins with zero registered shares, reset its
    ///      acquisition watermark to current PPS. Newly deposited capital must
    ///      not receive a share of profits accumulated before the deposit.
    function _prepareDeposit(uint8 slot) internal {
        _requireNoUnharvestedGain(slot);
        if (trackedShares[slot] == 0) {
            uint256 newPPS = currentPPS(slot);
            if (newPPS > highWatermarkPPS[slot]) {
                highWatermarkPPS[slot] = newPPS;
                emit WatermarkUpdated(slot, newPPS, 0, 0);
            }
        }
    }

    function pendingProfitShares(uint8 slot) external view returns (uint256) {
        if (slot > 3) revert OutOfBounds();
        address vault = _vault(slot);
        uint256 price = currentPPS(slot);
        uint256 hwm = highWatermarkPPS[slot];
        if (price <= hwm || cyvlSDTProfitShare == 0) return 0;
        uint256 eligible = _least(trackedShares[slot], IERC20PoL(vault).balanceOf(address(this)));
        uint256 gainAssets = eligible * (price - hwm) / shareUnits[slot];
        uint256 payoutAssets = gainAssets * cyvlSDTProfitShare / BPS;
        return payoutAssets * shareUnits[slot] / price;
    }

    /// @dev Share-price gains only: do not redeem principal to pay hypothetical
    ///      NAV profit. Skip illiquid markets without changing their watermark.
    function _harvestPPS(uint8 slot) internal returns (uint256 payoutInSDT) {
        address vault = _vault(slot);
        uint256 price = currentPPS(slot);
        uint256 hwm = highWatermarkPPS[slot];
        uint256 actualShares = IERC20PoL(vault).balanceOf(address(this));
        if (price <= hwm || actualShares == 0 || cyvlSDTProfitShare == 0) {
            // No recipient entitlement when share=0. Keep the high water mark monotonic.
            if (price > hwm && (cyvlSDTProfitShare == 0 || actualShares == 0)) {
                highWatermarkPPS[slot] = price;
                emit WatermarkUpdated(slot, price, 0, 0);
            }
            // Shares transferred directly into this contract begin earning at
            // the next crystallized price, not retroactively.
            if (price <= hwm || cyvlSDTProfitShare == 0 || actualShares == 0) {
                trackedShares[slot] = actualShares;
            }
            return 0;
        }
        uint256 eligible = _least(actualShares, trackedShares[slot]);
        if (eligible == 0) {
            highWatermarkPPS[slot] = price;
            trackedShares[slot] = actualShares;
            emit WatermarkUpdated(slot, price, 0, 0);
            return 0;
        }
        uint256 accruedAssets = eligible * (price - hwm) / shareUnits[slot];
        uint256 payoutAssets = accruedAssets * cyvlSDTProfitShare / BPS;
        uint256 sharesToRedeem = payoutAssets * shareUnits[slot] / price;
        if (sharesToRedeem == 0) return 0; // Do not forgive dust gains.
        if (sharesToRedeem > _maxRedeemVault(slot)) return 0;
        uint256 withdrawn = slot < 2
            ? _redeemYearn(slot, sharesToRedeem, 0)
            : _redeemEuler(uint8(slot - 2), sharesToRedeem, 0);
        address asset = _asset(slot);
        payoutInSDT = _convertToSDT(asset, withdrawn);
        highWatermarkPPS[slot] = price;
        trackedShares[slot] = IERC20PoL(vault).balanceOf(address(this));
        emit WatermarkUpdated(slot, price, sharesToRedeem, withdrawn);
    }

    /// @dev Harvest only newly claimed reward tokens; pre-existing treasury
    ///      balances are neither reclassified as profit nor transferred.
    function _harvestGaugeRewards() internal returns (uint256 sdtPortion) {
        if (curveGauge == address(0)) return 0;
        uint256 n = gaugeRewardTokens.length;
        uint256[] memory priorBalances = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            priorBalances[i] = IERC20PoL(gaugeRewardTokens[i]).balanceOf(address(this));
        }
        ICurveGaugePoL(curveGauge).claim_rewards();
        // Snapshot *all* received token deltas before conversions. Otherwise a
        // swap into another listed reward token would be counted again as yield.
        uint256[] memory actualClaims = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            actualClaims[i] = IERC20PoL(gaugeRewardTokens[i]).balanceOf(address(this)) - priorBalances[i];
        }
        for (uint256 i; i < n; ++i) {
            address token = gaugeRewardTokens[i];
            uint256 claimed = actualClaims[i];
            if (claimed == 0) continue;
            uint256 share = claimed * cyvlSDTProfitShare / BPS;
            if (share != 0) sdtPortion += _convertToSDT(token, share);
            uint256 reinvest = claimed - share;
            if (reinvest != 0) {
                (uint8 coin, uint256 result) = _convertToCurveCoin(token, reinvest);
                _curveDeposit(coin, result, 0);
            }
        }
        emit GaugeHarvested(n);
    }

    /// @dev Removed-liquidity principal is tracked separately, including any
    ///      principal owed before the NFT was first deposited into the manager.
    function _harvestUniFees() internal returns (uint256 sdtPortion) {
        _ownedUniPosition();
        (uint256 received0, uint256 received1) =
            IUniV3PositionManagerPoL(uniPositionManager).collect(
                IUniV3PositionManagerPoL.CollectParams({
                    tokenId: uniTokenId,
                    recipient: address(this),
                    amount0Max: type(uint128).max,
                    amount1Max: type(uint128).max
                })
            );
        emit UniFeesCollected(received0, received1);
        uint256 principal0 = _least(received0, uniPrincipalOwed0);
        uint256 principal1 = _least(received1, uniPrincipalOwed1);
        uniPrincipalOwed0 -= principal0;
        uniPrincipalOwed1 -= principal1;
        uint256 earned0 = received0 - principal0;
        uint256 earned1 = received1 - principal1;
        uint256 cut0 = earned0 * cyvlSDTProfitShare / BPS;
        uint256 cut1 = earned1 * cyvlSDTProfitShare / BPS;
        if (cut0 != 0) sdtPortion += _convertToSDT(uniToken0, cut0);
        if (cut1 != 0) sdtPortion += _convertToSDT(uniToken1, cut1);
        uniPendingCompound0 += earned0 - cut0;
        uniPendingCompound1 += earned1 - cut1;

        // Only compound when the NFT is within its configured TWAP-safe band;
        // the NFT and its existing tick range are never replaced.
        if (!uniPolicy.enabled) return sdtPortion;
        (uint8 signal,,) = uniSignal();
        if (signal != 1) return sdtPortion;
        uint256 amount0 = _least(uniPendingCompound0, IERC20PoL(uniToken0).balanceOf(address(this)));
        uint256 amount1 = _least(uniPendingCompound1, IERC20PoL(uniToken1).balanceOf(address(this)));
        amount0 = _least(amount0, uniPolicy.maxAdd0);
        amount1 = _least(amount1, uniPolicy.maxAdd1);
        // Inside a concentrated range, both token sides are required to mint
        // useful liquidity; leave one-sided fees reserved until another harvest.
        if (amount0 == 0 || amount1 == 0) return sdtPortion;
        _approveExact(uniToken0, uniPositionManager, amount0);
        _approveExact(uniToken1, uniPositionManager, amount1);
        // Failure to add tiny or unbalanced residual fees should not prevent
        // the revenue payout from the other positions; keep them for later.
        try IUniV3PositionManagerPoL(uniPositionManager).increaseLiquidity(
            IUniV3PositionManagerPoL.IncreaseLiquidityParams({
                tokenId: uniTokenId,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp
            })
        ) returns (uint128 liquidity, uint256 used0, uint256 used1) {
            if (liquidity != 0) {
                uniPendingCompound0 -= used0;
                uniPendingCompound1 -= used1;
                emit UniCompounded(used0, used1, liquidity);
            }
        } catch {
            // Failed LP addition is atomic in the external position manager.
            // Its unspent token balances remain available for future harvests.
        }
        _approveExact(uniToken0, uniPositionManager, 0);
        _approveExact(uniToken1, uniPositionManager, 0);
    }

    /// @notice Split *realized* Curve gauge rewards and Uniswap NFT fees,
    ///         and the increase above each Yearn/Euler share-price high watermark.
    ///         Convert all payouts to SDT before a single transfer to recipient.
    function harvest() external onlyOperator whenActive nonReentrant trackIncoming returns (uint256 sdtPaid) {
        if (cyvlSDTProfitShare != 0 && cyvlSDTProfitRecipient.code.length == 0) {
            revert InvalidConfiguration();
        }
        sdtPaid += _harvestGaugeRewards();
        sdtPaid += _harvestUniFees();
        for (uint8 slot; slot < 4; ++slot) {
            sdtPaid += _harvestPPS(slot);
        }
        if (sdtPaid > 0) {
            _erc20Call(sdtToken,
                abi.encodeWithSelector(IERC20PoL.transfer.selector, cyvlSDTProfitRecipient, sdtPaid));
            emit ProfitPaid(cyvlSDTProfitRecipient, sdtPaid);
        }
    }

    // ---------------------------------------------------------------------
    // RATE OBSERVATIONS AND CONDITIONAL YEARN + SDT -> CURVE MIGRATION
    // ---------------------------------------------------------------------

    function _rateKey(uint8 fromIndex, uint8 toIndex) internal pure returns (uint8) {
        if (fromIndex > 2 || toIndex > 2 || fromIndex == toIndex) revert OutOfBounds();
        return fromIndex * 3 + toIndex;
    }

    function setRateRule(uint8 fromIndex, uint8 toIndex, RateParams calldata params) external onlyOwner {
        uint8 key = _rateKey(fromIndex, toIndex);
        if (params.enabled && (
            params.quoteAmountIn == 0 || params.targetRateWad == 0 ||
            params.maxOracleDeviationBps > 2000 || params.maxOracleDeviationBps == 0 ||
            (params.yearnRedeemBps == 0 && params.sdtRedeemBps == 0) ||
            params.yearnRedeemBps > BPS || params.sdtRedeemBps > BPS ||
            params.minPersistSeconds < 300 || params.cooldownSeconds < 3600
        )) revert InvalidConfiguration();
        RateState storage state = rateStates[key];
        state.params = params;
        state.armedAt = 0;
        state.lastObservedAt = 0;
        emit RateRuleSet(fromIndex, toIndex, params.enabled);
    }

    function setGlobalRateCooldown(uint32 seconds_) external onlyOwner {
        if (seconds_ < 3600 || seconds_ > 30 days) revert OutOfBounds();
        globalRateCooldown = seconds_;
    }

    function getRateRule(uint8 fromIndex, uint8 toIndex) external view returns (RateState memory) {
        return rateStates[_rateKey(fromIndex, toIndex)];
    }

    /// @notice Single-source spot quote plus independent USD-feed reference check.
    /// @dev Persistent observation is NOT a Curve TWAP; two separately observed
    ///      good quotes with oracle cross-check are required before migration.
    function rateStatus(uint8 fromIndex, uint8 toIndex)
        public view returns (uint256 spotRateWad, uint256 oracleRateWad, uint256 deviationBps)
    {
        uint8 key = _rateKey(fromIndex, toIndex);
        RateParams memory cfg = rateStates[key].params;
        if (cfg.quoteAmountIn == 0) revert InvalidConfiguration();
        uint256 out = ICurvePoolPoL(curvePool).get_dy(
            int128(uint128(fromIndex)), int128(uint128(toIndex)), cfg.quoteAmountIn
        );
        address tokenIn = curveCoins[fromIndex];
        address tokenOut = curveCoins[toIndex];
        FeedConfig memory fIn = priceFeeds[tokenIn];
        FeedConfig memory fOut = priceFeeds[tokenOut];
        if (fIn.feed == address(0) || fOut.feed == address(0)) revert InvalidOracle();
        uint256 scaled = 10 ** fOut.tokenDecimals;
        uint256 denom = cfg.quoteAmountIn;
        spotRateWad = out * (10 ** fIn.tokenDecimals) * WAD / denom / scaled;
        uint256 expectedOut = quoteTokenAmount(tokenIn, tokenOut, cfg.quoteAmountIn);
        oracleRateWad = expectedOut * (10 ** fIn.tokenDecimals) * WAD / denom / scaled;
        if (oracleRateWad == 0) revert InvalidOracle();
        uint256 delta = spotRateWad > oracleRateWad
            ? spotRateWad - oracleRateWad : oracleRateWad - spotRateWad;
        deviationBps = delta * BPS / oracleRateWad;
    }

    /// @notice Anyone can record a qualifying snapshot. Falling below the
    ///         threshold disarms the rule. Independent feeds must be fresh.
    function observeRate(uint8 fromIndex, uint8 toIndex) external whenActive nonReentrant {
        RateState storage state = rateStates[_rateKey(fromIndex, toIndex)];
        if (!state.params.enabled) revert WrongState();
        (uint256 spot,,uint256 deviation) = rateStatus(fromIndex, toIndex);
        bool qualifying = spot >= state.params.targetRateWad &&
            deviation <= state.params.maxOracleDeviationBps;
        if (qualifying) {
            if (state.armedAt == 0) state.armedAt = uint64(block.timestamp);
        } else {
            state.armedAt = 0;
        }
        state.lastObservedRateWad = spot;
        state.lastObservedAt = uint64(block.timestamp);
        emit RateObserved(fromIndex, toIndex, spot, qualifying);
    }

    /// @notice Fully permissionless once a rate has been observed above the
    ///         configured target for a minimum interval. Executes bounded
    ///         redemptions and immediately one-coin deposits into Curve.
    function executeRateTrigger(uint8 fromIndex, uint8 toIndex)
        external whenActive nonReentrant trackIncoming returns (uint256 yearnShares, uint256 sdtShares)
    {
        RateState storage state = rateStates[_rateKey(fromIndex, toIndex)];
        RateParams memory cfg = state.params;
        if (!cfg.enabled || state.armedAt == 0 ||
            block.timestamp < uint256(state.armedAt) + cfg.minPersistSeconds ||
            block.timestamp < uint256(state.lastTriggeredAt) + cfg.cooldownSeconds ||
            block.timestamp < lastGlobalRateExecutionAt + globalRateCooldown) revert WrongState();
        (uint256 spot,,uint256 deviation) = rateStatus(fromIndex, toIndex);
        if (spot < cfg.targetRateWad || deviation > cfg.maxOracleDeviationBps) revert WrongState();
        // Block migration of unharvested profits; harvest() must crystallize the
        // recipient's entitlement before principal can be reallocated.
        _requireNoUnharvestedGain(0);
        _requireNoUnharvestedGain(uint8(sdtEulerIndex + 2));
        yearnShares = IERC20PoL(yearnVaults[0]).balanceOf(address(this)) * cfg.yearnRedeemBps / BPS;
        sdtShares = IERC20PoL(eulerMarkets[sdtEulerIndex]).balanceOf(address(this)) * cfg.sdtRedeemBps / BPS;
        if (yearnShares > 0) {
            yearnShares = _least(yearnShares,
                IYearnV3PoL(yearnVaults[0]).maxRedeem(address(this), maxYearnLossBps));
        }
        if (sdtShares > 0) {
            sdtShares = _least(sdtShares,
                IERC4626PoL(eulerMarkets[sdtEulerIndex]).maxRedeem(address(this)));
        }
        if (yearnShares == 0 && sdtShares == 0) revert WrongState();
        state.lastTriggeredAt = uint64(block.timestamp);
        state.armedAt = 0;
        lastGlobalRateExecutionAt = block.timestamp;
        if (yearnShares != 0) {
            uint256 redeemedYearn = _redeemYearn(0, yearnShares, 0);
            (uint8 coin, uint256 converted) = _convertToCurveCoin(yearnAssets[0], redeemedYearn);
            _curveDeposit(coin, converted, 0);
        }
        if (sdtShares != 0) {
            uint256 redeemedSdt = _redeemEuler(sdtEulerIndex, sdtShares, 0);
            (uint8 coin, uint256 converted) = _convertToCurveCoin(sdtToken, redeemedSdt);
            _curveDeposit(coin, converted, 0);
        }
        emit RateTriggered(fromIndex, toIndex, yearnShares, sdtShares);
    }

    // ---------------------------------------------------------------------
    // READS / UTILITIES
    // ---------------------------------------------------------------------

    function curveExposure() external view returns (uint256 idleLp, uint256 gaugeStakedLp) {
        idleLp = IERC20PoL(curveLpToken).balanceOf(address(this));
        if (curveGauge != address(0)) gaugeStakedLp = ICurveGaugePoL(curveGauge).balanceOf(address(this));
    }

    function vaultShares() external view returns (
        uint256 yearnShares0, uint256 yearnShares1, uint256 eulerShares0, uint256 eulerShares1
    ) {
        yearnShares0 = IERC20PoL(yearnVaults[0]).balanceOf(address(this));
        yearnShares1 = IERC20PoL(yearnVaults[1]).balanceOf(address(this));
        eulerShares0 = IERC20PoL(eulerMarkets[0]).balanceOf(address(this));
        eulerShares1 = IERC20PoL(eulerMarkets[1]).balanceOf(address(this));
    }

    function _least(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
    function _greater(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a : b;
    }
}