// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * @title AVKATConsolidatedSafeModule v3 - STANDALONE, SOURCE-ONLY REFERENCE IMPLEMENTATION
 * @notice Katana/Gnosis Safe module. All Safe assets remain Safe-owned except transient
 *         Morpho flash loan balances and temporary sale proceeds inside the module.
 * @dev Read deployment and security notes before use. This v3 source has NOT
 *      been compiled, tested, audited, or deployed.
 *      Does not call or depend on ANY earlier AVKAT Safe module or PositionRegistry.
 *      Every swap, including flash callbacks, range preparation, and vault preparation,
 *      is executed ONLY by the independently deployed, Safe-selected external swapper.
 *      No pool swapping, DEX callbacks, path traversal or exchange pricing lives here.
 *      Only the Safe may configure executors, range definitions, vaults or policies.
 */

struct AvkatMarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

interface IAvkatSafe {
    function execTransactionFromModuleReturnData(address to, uint256 value, bytes calldata data, uint8 operation)
        external returns (bool success, bytes memory returnData);
}
interface IAvkatMorpho {
    function accrueInterest(AvkatMarketParams memory mp) external;
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
    function idToMarketParams(bytes32 id) external view
        returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv);
    function position(bytes32 marketId, address user) external view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);
    function market(bytes32 marketId) external view
        returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets,
                 uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee);
    function supplyCollateral(AvkatMarketParams memory mp, uint256 amount, address onBehalf, bytes calldata data) external;
    function borrow(AvkatMarketParams memory mp, uint256 assets, uint256 shares, address onBehalf, address receiver)
        external returns (uint256 assetsBorrowed, uint256 sharesBorrowed);
    function repay(AvkatMarketParams memory mp, uint256 assets, uint256 shares, address onBehalf, bytes calldata data)
        external returns (uint256 assetsRepaid, uint256 sharesRepaid);
    function withdrawCollateral(AvkatMarketParams memory mp, uint256 assets, address onBehalf, address receiver) external;
}
interface IAvkatERC20 {
    function balanceOf(address owner) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
    function transfer(address recipient, uint256 value) external returns (bool);
}
interface IAvkatRate {
    function convertToShares(uint256 assets) external view returns (uint256);
}
interface IAvkatOracle { function price() external view returns (uint256); }
// External swappers have owner-configurable ABI selectors and statically encoded inputs.
// All swap routing and price quotation remain inside whichever external router the Safe selects.
interface IAvkatPositionManager {
    struct MintParams {
        address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper;
        uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min;
        address recipient; uint256 deadline;
    }
    struct IncreaseParams {
        uint256 tokenId; uint256 amount0Desired; uint256 amount1Desired;
        uint256 amount0Min; uint256 amount1Min; uint256 deadline;
    }
    struct DecreaseParams {
        uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline;
    }
    struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }
    function positions(uint256 tokenId) external view returns
        (uint96 nonce, address operator, address token0, address token1, uint24 fee,
         int24 tickLower, int24 tickUpper, uint128 liquidity,
         uint256 feeGrowth0, uint256 feeGrowth1, uint128 tokensOwed0, uint128 tokensOwed1);
    function ownerOf(uint256 tokenId) external view returns (address);
    function mint(MintParams calldata p) external returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function increaseLiquidity(IncreaseParams calldata p) external returns (uint128 liquidity, uint256 amount0, uint256 amount1);
    function decreaseLiquidity(DecreaseParams calldata p) external returns (uint256 amount0, uint256 amount1);
    function collect(CollectParams calldata p) external returns (uint256 amount0, uint256 amount1);
    function approve(address to, uint256 tokenId) external;
    function burn(uint256 tokenId) external;
}
interface IAvkatStaker {
    function stake(uint256 tokenId) external;
    function unstake(uint256 tokenId) external;
    function getStaker(uint256 tokenId) external view returns (address);
}
interface IAvkatCharm {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function deposit(uint256 max0, uint256 max1, uint256 min0, uint256 min1, address receiver)
        external returns (uint256 shares, uint256 deposited0, uint256 deposited1);
    function withdraw(uint256 shares, uint256 min0, uint256 min1, address receiver)
        external returns (uint256 received0, uint256 received1);
}
interface IAvkatERC4626 {
    function asset() external view returns (address);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
}

contract AVKATConsolidatedSafeModule {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 public constant MAX_LTV = 769_000_000_000_000_000; // 76.9%, below 77% Morpho LLTV
    uint256 public constant MAX_SAFETY_BUFFER_BPS = 1_000;
    uint256 private constant MAX_SEARCH_ROUNDS = 28;

    uint8 public constant VAULT_CHARM = 1;
    uint8 public constant VAULT_ERC4626 = 2;
    uint8 private constant FLASH_UP = 1;
    uint8 private constant FLASH_DOWN = 2;

    IAvkatSafe public immutable SAFE;
    IAvkatMorpho public immutable MORPHO;
    address public immutable KAT;
    address public immutable AVKAT;
    bytes32 public immutable LOOP_MARKET;

    address public constant DEFAULT_ROUTER = 0x01F9894f92ea9224fECc8C35482E20a05De13582;
    // Router ABI field kinds. The Safe controls both the selector and ordered argument layout.
    uint8 public constant FIELD_FIXED_WORD = 0;
    uint8 public constant FIELD_TOKEN_IN = 1;
    uint8 public constant FIELD_TOKEN_OUT = 2;
    uint8 public constant FIELD_AMOUNT_IN = 3;
    uint8 public constant FIELD_POLICY_MIN_OUT = 4;
    uint8 public constant FIELD_SAFE_RECIPIENT = 5;
    uint8 public constant FIELD_DEADLINE = 6;
    uint8 public constant FIELD_CALLER = 7;
    struct RouterField { uint8 kind; bytes32 fixedWord; }

    address public SWAPPER;
    bytes4 public swapSelector = 0xe20c448d;
    bytes4 public quoteSelector = bytes4(keccak256("twapMinimumOut(address,address,uint256)"));
    uint8 public quoteResultWord;
    uint32 public routerDeadlineSeconds = 300; // Katana observed 1 second/block: ~300 blocks
    RouterField[] public swapInputFields;
    RouterField[] public quoteInputFields;
    uint256 public targetLtv = 765_000_000_000_000_000;
    uint256 public maxFlashKat = 500e18;
    uint256 public minPremiumBps = 0; // Safe-set policy: premium over intrinsic avKAT rate
    uint256 public quoteSafetyBufferBps = 100; // additional 1% conservative haircut
    mapping(address => bool) public isExecutor;

    struct Range {
        address npm;
        address staker;
        address token0;
        address token1;
        uint24 fee;
        uint256 tokenId; // zero means empty range ready for a new mint
        uint32 minRebalanceInterval;
        uint16 maxRebalancesPerDay;
        uint64 lastRebalanceAt;
        uint64 currentDay;
        uint16 rebalancesToday;
        bool enabled;
    }
    struct Vault { uint8 kind; address token0; address token1; bool enabled; }
    struct RangeExit {
        uint256 rangeId;
        uint128 liquidity; // type(uint128).max = all liquidity
        uint256 min0;
        uint256 min1;
        bool burnIfEmpty;
    }
    struct VaultExit {
        address vault;
        uint256 shares; // zero = ALL Safe-owned shares
        uint256 min0; // for 4626, min0 = minimum underlying assets
        uint256 min1; // ignored for 4626
    }
    struct Swap {
        address tokenIn;
        address tokenOut;
        uint256 amountIn; // zero = entire available Safe-held input for this specific swap
        uint256 minOut; // caller minimum; the external swapper applies its own route protection
    }
    struct PreSteps {
        RangeExit[] ranges;
        VaultExit[] vaults;
        Swap[] toKat;
    }
    struct MintSpec {
        int24 lower;
        int24 upper;
        uint256 desired0;
        uint256 desired1;
        uint256 min0;
        uint256 min1;
        uint256 deadline;
    }
    struct LoopUp {
        uint256 maxFlash; // requested search upper bound, additionally capped by maxFlashKat
        uint256 minFlash; // 0 permits any nonzero flash; otherwise revert below this amount
        uint256 keepKat; // leave at least this much KAT in Safe
        uint256 maxLtv;  // <= owner-set targetLtv; 0 uses targetLtv
        uint256 deadline;
    }
    struct Deloop {
        uint256 maxFlash;
        uint256 avkatToSell; // avKAT collateral withdrawn after debt repayment
        uint256 maxSafeKatContribution; // available Safe KAT used to settle the flash
        uint256 keepKat;
        uint256 minSaleKat;
        uint256 maxLtv; // <= targetLtv, 0 uses targetLtv
        uint256 deadline;
    }

    // Fully local position/vault tracking; NO external AVKAT module or legacy registry.
    mapping(uint256 => Range) public ranges;
    mapping(address => Vault) public vaults;
    bool private _locked;
    uint8 private transient _flashMode;
    bytes32 private transient _flashCommitment;

    error NotSafe();
    error NotExecutor();
    error Busy();
    error BadConfiguration();
    error BadAmount();
    error BadRange();
    error BadVault();
    error NotOwnedBySafe();
    error SafeCallFailed(address target);
    error TokenCallFailed(address target);
    error BadFlashCallback();
    error NoFeasibleFlash();
    error SlippageTooHigh();
    error LtvTooHigh(uint256 actual, uint256 maximum);
    error UnexpectedDebt(uint256 actual, uint256 expected);
    error InvalidDeadline();

    event ExecutorSet(address indexed executor, bool enabled);
    event SwapRouterSet(address indexed newRouter);
    event RouterInterfaceConfigured(address indexed router, bytes4 swapMethod, bytes4 quoteMethod,
                                    uint8 quoteResultWord, uint32 deadlineSeconds);
    event PolicySet(uint256 targetLtv, uint256 maxFlashKat, uint256 minPremiumBps, uint256 quoteSafetyBufferBps);
    event RangeConfigured(uint256 indexed id, address npm, uint256 tokenId, bool enabled);
    event VaultConfigured(address indexed vault, uint8 kind, bool enabled);
    event RangeLiquidityRemoved(uint256 indexed id, uint256 indexed tokenId, uint128 liquidity);
    event RangeMinted(uint256 indexed id, uint256 indexed tokenId);
    event RangeRebalanced(uint256 indexed id, uint256 oldTokenId, uint256 newTokenId);
    event Looped(uint256 flashKat, uint256 safeKatUsed, uint256 avkatSupplied, uint256 resultingLtv);
    event Delooped(uint256 debtRepaidKat, uint256 avkatSold, uint256 safeKatUsed, uint256 resultingLtv);

    modifier onlySafe() { if (msg.sender != address(SAFE)) revert NotSafe(); _; }
    modifier onlyExecutor() {
        if (msg.sender != address(SAFE) && !isExecutor[msg.sender]) revert NotExecutor();
        if (_locked) revert Busy();
        _locked = true;
        _;
        _locked = false;
    }

    constructor(
        address safe_, address morpho_, address kat_, address avkat_, bytes32 marketId_
    ) {
        if (safe_.code.length == 0 || morpho_.code.length == 0 || kat_.code.length == 0 ||
            avkat_.code.length == 0 || DEFAULT_ROUTER.code.length == 0) revert BadConfiguration();
        SAFE = IAvkatSafe(safe_);
        MORPHO = IAvkatMorpho(morpho_);
        KAT = kat_;
        AVKAT = avkat_;
        LOOP_MARKET = marketId_;
        SWAPPER = DEFAULT_ROUTER;
        // swapExactInput(tokenIn, tokenOut, amountIn, 0, SAFE, block.timestamp + 300)
        swapInputFields.push(RouterField(FIELD_TOKEN_IN, bytes32(0)));
        swapInputFields.push(RouterField(FIELD_TOKEN_OUT, bytes32(0)));
        swapInputFields.push(RouterField(FIELD_AMOUNT_IN, bytes32(0)));
        swapInputFields.push(RouterField(FIELD_FIXED_WORD, bytes32(0)));
        swapInputFields.push(RouterField(FIELD_SAFE_RECIPIENT, bytes32(0)));
        swapInputFields.push(RouterField(FIELD_DEADLINE, bytes32(0)));
        // twapMinimumOut(tokenIn, tokenOut, amountIn) returns one uint256.
        quoteInputFields.push(RouterField(FIELD_TOKEN_IN, bytes32(0)));
        quoteInputFields.push(RouterField(FIELD_TOKEN_OUT, bytes32(0)));
        quoteInputFields.push(RouterField(FIELD_AMOUNT_IN, bytes32(0)));
        AvkatMarketParams memory mp = _params();
        if (mp.loanToken != kat_ || mp.collateralToken != avkat_ || mp.lltv <= MAX_LTV) {
            revert BadConfiguration();
        }
    }

    // ---- Owner-controlled settings: no standalone executor can change these ----
    function setExecutor(address executor, bool enabled) external onlySafe {
        if (executor == address(0) || executor == address(this)) revert BadConfiguration();
        isExecutor[executor] = enabled;
        emit ExecutorSet(executor, enabled);
    }
    /// @notice Safely replace the external swapper AND its method/argument ABI in one Safe action.
    /// @dev RouterField supports arbitrary static 32-byte ABI arguments and their order; dynamic
    ///      bytes, arrays, and tuples need a separate external ABI adapter rather than a guessed encoding.
    ///      FIELD_FIXED_WORD permits any Safe-approved constant. All output must reach the Safe.
    function setSwapper(
        address router,
        bytes4 swapMethod,
        RouterField[] calldata swapArguments,
        bytes4 quoteMethod,
        RouterField[] calldata quoteArguments,
        uint8 resultWord,
        uint32 deadlineSeconds
    ) external onlySafe {
        if (router.code.length == 0 || router == address(this) || router == address(SAFE) ||
            swapMethod == bytes4(0) || quoteMethod == bytes4(0) ||
            swapArguments.length == 0 || swapArguments.length > 12 ||
            quoteArguments.length == 0 || quoteArguments.length > 12 ||
            resultWord > 3 || deadlineSeconds > 86_400) revert BadConfiguration();
        delete swapInputFields;
        delete quoteInputFields;
        for (uint256 i; i < swapArguments.length; ++i) {
            if (swapArguments[i].kind > FIELD_CALLER) revert BadConfiguration();
            swapInputFields.push(swapArguments[i]);
        }
        for (uint256 i; i < quoteArguments.length; ++i) {
            if (quoteArguments[i].kind > FIELD_CALLER) revert BadConfiguration();
            quoteInputFields.push(quoteArguments[i]);
        }
        SWAPPER = router;
        swapSelector = swapMethod;
        quoteSelector = quoteMethod;
        quoteResultWord = resultWord;
        routerDeadlineSeconds = deadlineSeconds;
        emit SwapRouterSet(router);
        emit RouterInterfaceConfigured(router, swapMethod, quoteMethod, resultWord, deadlineSeconds);
    }
    function routerSwapFieldCount() external view returns (uint256) { return swapInputFields.length; }
    function routerQuoteFieldCount() external view returns (uint256) { return quoteInputFields.length; }
    function setPolicy(uint256 target_, uint256 maxFlash_, uint256 minPremium_, uint256 bufferBps_) external onlySafe {
        if (target_ == 0 || target_ > MAX_LTV || maxFlash_ == 0 ||
            minPremium_ > BPS || bufferBps_ > MAX_SAFETY_BUFFER_BPS) revert BadConfiguration();
        (targetLtv, maxFlashKat, minPremiumBps, quoteSafetyBufferBps) =
            (target_, maxFlash_, minPremium_, bufferBps_);
        emit PolicySet(target_, maxFlash_, minPremium_, bufferBps_);
    }
    function configureRange(
        uint256 id, address npm, address staker, address token0, address token1, uint24 fee,
        uint256 existingTokenId, uint32 minInterval, uint16 maxPerDay, bool enabled
    ) external onlySafe {
        if (id == 0 || npm.code.length == 0 || token0 == address(0) || token1 == address(0) ||
            token0 == token1 || fee == 0 || maxPerDay == 0 || (staker != address(0) && staker.code.length == 0)) {
            revert BadConfiguration();
        }
        Range storage r = ranges[id];
        // Do not silently abandon a live NFT by rewriting its range configuration.
        if (r.tokenId != 0 &&
            (r.tokenId != existingTokenId || r.npm != npm || r.staker != staker)) revert BadConfiguration();
        if (existingTokenId != 0) _checkNft(npm, staker, existingTokenId, token0, token1, fee);
        r.npm = npm; r.staker = staker; r.token0 = token0; r.token1 = token1; r.fee = fee;
        r.tokenId = existingTokenId; r.minRebalanceInterval = minInterval;
        r.maxRebalancesPerDay = maxPerDay; r.enabled = enabled;
        emit RangeConfigured(id, npm, existingTokenId, enabled);
    }
    function configureVault(address vault, uint8 kind, bool enabled) external onlySafe {
        if (vault.code.length == 0) revert BadVault();
        address t0; address t1;
        if (kind == VAULT_CHARM) {
            t0 = IAvkatCharm(vault).token0();
            t1 = IAvkatCharm(vault).token1();
        } else if (kind == VAULT_ERC4626) {
            t0 = IAvkatERC4626(vault).asset();
        } else revert BadVault();
        if (t0 == address(0) || (kind == VAULT_CHARM && (t1 == address(0) || t0 == t1))) revert BadVault();
        vaults[vault] = Vault(kind, t0, t1, enabled);
        emit VaultConfigured(vault, kind, enabled);
    }

    // ---- Atomic operation: several NFT/vault exits, several KAT conversions, one flash/collateral/borrow ----
    function atomicLoopUp(PreSteps calldata pre, LoopUp calldata p) external onlyExecutor {
        if (block.timestamp > p.deadline) revert InvalidDeadline();
        _runPreSteps(pre);
        AvkatMarketParams memory mp = _params();
        MORPHO.accrueInterest(mp);
        uint256 held = _balance(KAT, address(SAFE));
        if (held > p.keepKat) held -= p.keepKat;
        else held = 0;
        uint256 target = _target(p.maxLtv);
        uint256 limit = p.maxFlash < maxFlashKat ? p.maxFlash : maxFlashKat;
        // Morpho must still have funds to deliver the fresh KAT borrow while the flash is outstanding.
        uint256 liquid = _balance(KAT, address(MORPHO)) / 2;
        if (limit > liquid) limit = liquid;
        uint256 flash = _findFlash(limit, held, target);
        if (flash == 0 || flash < p.minFlash) revert NoFeasibleFlash();
        bytes memory payload = abi.encode(FLASH_UP, flash, held, uint256(0), uint256(0), target, p.deadline);
        _beginFlash(flash, FLASH_UP, payload);
        uint256 resultingLtv = ltvOf();
        if (resultingLtv > target) revert LtvTooHigh(resultingLtv, target);
    }

    /**
     * @notice Flash deleverage: repay first, withdraw a bounded portion of avKAT collateral, sell it externally,
     *         settle flash from sale proceeds + Safe KAT contribution; any KAT surplus goes back to Safe.
     * @dev Caller chooses the avKAT sale quantity; debt repayment is automatically sized to reach LTV target
     *      after that collateral withdrawal. It may finish *below*, never above, the target LTV.
     */
    function atomicDeleverage(PreSteps calldata pre, Deloop calldata p) external onlyExecutor {
        if (block.timestamp > p.deadline) revert InvalidDeadline();
        _runPreSteps(pre);
        AvkatMarketParams memory mp = _params();
        MORPHO.accrueInterest(mp);
        (uint256 debt, uint256 collateral, uint256 oraclePrice) = _positionState(mp);
        if (p.avkatToSell > collateral) revert BadAmount();
        uint256 target = _target(p.maxLtv);
        uint256 remainingValue = _mulDiv(collateral - p.avkatToSell, oraclePrice, 1e36);
        uint256 allowedDebt = _mulDiv(remainingValue, target, WAD);
        if (debt <= allowedDebt) revert NoFeasibleFlash();
        uint256 flash = debt - allowedDebt;
        // One wei margin prevents an equality-bound rounding edge in the debt-share accounting.
        if (flash < debt) ++flash;
        if (flash > p.maxFlash || flash > maxFlashKat || flash > debt) revert NoFeasibleFlash();
        uint256 held = _balance(KAT, address(SAFE));
        if (held > p.keepKat) held -= p.keepKat;
        else held = 0;
        if (held > p.maxSafeKatContribution) held = p.maxSafeKatContribution;
        if (held > flash) held = flash;
        if (p.avkatToSell == 0 && held < flash) revert BadAmount();
        // minSaleKat also serves as a guaranteed flash repayment floor. Over-delivery is refunded to Safe.
        uint256 requiredSale = flash - held;
        uint256 minimumSale = p.minSaleKat > requiredSale ? p.minSaleKat : requiredSale;
        if (p.avkatToSell != 0) {
            uint256 protectedMinimum = _conservativeQuote(
                address(this), AVKAT, KAT, p.avkatToSell
            );
            if (protectedMinimum == 0) revert SlippageTooHigh();
            if (protectedMinimum < requiredSale) revert SlippageTooHigh();
        }
        bytes memory payload = abi.encode(FLASH_DOWN, flash, held, p.avkatToSell, minimumSale, target, p.deadline);
        _beginFlash(flash, FLASH_DOWN, payload);
        uint256 resultingLtv = ltvOf();
        if (resultingLtv > target) revert LtvTooHigh(resultingLtv, target);
    }

    /**
     * @dev Morpho calls this during exactly one active flash. All pre-steps are already complete.
     *      UP: 1 external KAT->avKAT swap, 1 avKAT collateral supply, 1 KAT borrow, repay flash.
     *      DOWN: 1 Morpho debt repayment, 1 collateral withdrawal, 1 external avKAT->KAT swap, repay flash.
     */
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != address(MORPHO) || _flashMode == 0 ||
            keccak256(data) != _flashCommitment) revert BadFlashCallback();
        (uint8 mode, uint256 flash, uint256 held, uint256 avToSell,
         uint256 minSaleKat, uint256 target, uint256 deadline) =
            abi.decode(data, (uint8, uint256, uint256, uint256, uint256, uint256, uint256));
        if (mode != _flashMode || flash != assets || block.timestamp > deadline) revert BadFlashCallback();
        _flashMode = 0; // no recursive Morpho callback
        _flashCommitment = bytes32(0);
        AvkatMarketParams memory mp = _params();
        if (mode == FLASH_UP) {
            if (held != 0) _safeTransfer(KAT, address(this), held);
            uint256 totalInput = assets + held;
            uint256 minOut = _conservativeQuote(address(this), KAT, AVKAT, totalInput);
            if (minOut == 0 || !_hasRequiredPremium(totalInput, minOut)) revert SlippageTooHigh();
            uint256 beforeAv = _balance(AVKAT, address(SAFE));
            _externalSwapFromSelf(KAT, AVKAT, totalInput, minOut);
            uint256 totalAv = _balance(AVKAT, address(SAFE));
            if (totalAv <= beforeAv) revert SlippageTooHigh();
            _safeApprove(AVKAT, address(MORPHO), totalAv);
            _safe(address(MORPHO), abi.encodeCall(IAvkatMorpho.supplyCollateral,
                (mp, totalAv, address(SAFE), bytes(""))));
            _safeApprove(AVKAT, address(MORPHO), 0);
            // EXACTLY ONE Morpho borrow, with its assets delivered to this module to repay the flash.
            _safe(address(MORPHO), abi.encodeCall(IAvkatMorpho.borrow,
                (mp, assets, 0, address(SAFE), address(this))));
            uint256 currentLtv = ltvOf();
            if (currentLtv > target) revert LtvTooHigh(currentLtv, target);
            _approveSelf(KAT, address(MORPHO), assets);
            emit Looped(assets, held, totalAv, currentLtv);
        } else if (mode == FLASH_DOWN) {
            _approveSelf(KAT, address(MORPHO), assets);
            (uint256 repaid,) = MORPHO.repay(mp, assets, 0, address(SAFE), "");
            if (repaid > assets) revert UnexpectedDebt(repaid, assets);
            _approveSelf(KAT, address(MORPHO), 0);
            uint256 saleKat;
            if (avToSell != 0) {
                _safe(address(MORPHO), abi.encodeCall(IAvkatMorpho.withdrawCollateral,
                    (mp, avToSell, address(SAFE), address(this))));
                // Swaps ALWAYS deliver proceeds to SAFE, including flash deleverage.
                saleKat = _externalSwapFromSelf(AVKAT, KAT, avToSell, minSaleKat);
            }
            uint256 alreadyKat = _balance(KAT, address(this));
            uint256 contribution;
            if (alreadyKat < assets) {
                contribution = assets - alreadyKat;
                // Sale proceeds may fund flash settlement in addition to the capped
                // contribution from previously held Safe KAT.
                if (contribution > held + saleKat) revert SlippageTooHigh();
                _safeTransfer(KAT, address(this), contribution);
            }
            if (_balance(KAT, address(this)) < assets) revert SlippageTooHigh();
            uint256 currentLtv = ltvOf();
            if (currentLtv > target) revert LtvTooHigh(currentLtv, target);
            uint256 surplus = _balance(KAT, address(this)) - assets;
            if (surplus != 0) _transferSelf(KAT, address(SAFE), surplus);
            _approveSelf(KAT, address(MORPHO), assets);
            emit Delooped(repaid, avToSell, contribution, currentLtv);
        } else revert BadFlashCallback();
    }

    // ---- Multiple position exits and conversions; external SWAPPER handles every trade ----
    function _runPreSteps(PreSteps calldata pre) internal {
        for (uint256 i; i < pre.ranges.length; ++i) {
            RangeExit calldata e = pre.ranges[i];
            _withdrawRange(e.rangeId, e.liquidity, e.min0, e.min1, e.burnIfEmpty);
        }
        for (uint256 i; i < pre.vaults.length; ++i) {
            VaultExit calldata v = pre.vaults[i];
            _withdrawVault(v.vault, v.shares, v.min0, v.min1);
        }
        for (uint256 i; i < pre.toKat.length; ++i) {
            Swap calldata sw = pre.toKat[i];
            if (sw.tokenOut != KAT || sw.tokenIn == KAT || sw.tokenIn == AVKAT) revert BadConfiguration();
            _externalSwapFromSafe(sw);
        }
    }
    function _withdrawVault(address vault, uint256 shares, uint256 min0, uint256 min1) internal {
        Vault storage v = vaults[vault];
        if (!v.enabled) revert BadVault();
        uint256 owned = _balance(vault, address(SAFE));
        if (shares == 0) shares = owned;
        if (shares == 0 || shares > owned) revert BadAmount();
        if (v.kind == VAULT_CHARM) {
            _safe(vault, abi.encodeCall(IAvkatCharm.withdraw, (shares, min0, min1, address(SAFE))));
        } else if (v.kind == VAULT_ERC4626) {
            bytes memory result = _safe(vault, abi.encodeCall(IAvkatERC4626.redeem,
                (shares, address(SAFE), address(SAFE))));
            if (abi.decode(result, (uint256)) < min0) revert SlippageTooHigh();
        } else revert BadVault();
    }
    function withdrawVault(address vault, uint256 shares, uint256 min0, uint256 min1) external onlyExecutor {
        _withdrawVault(vault, shares, min0, min1);
    }
    function depositVault(address vault, uint256 amount0, uint256 amount1, uint256 min0,
                          uint256 min1, uint256 minShares, Swap[] calldata preparationSwaps)
        external onlyExecutor
    {
        Vault storage v = vaults[vault];
        if (!v.enabled || (amount0 == 0 && amount1 == 0)) revert BadVault();
        _executeExternalSwaps(preparationSwaps);
        if (v.kind == VAULT_CHARM) {
            _safeApprove(v.token0, vault, amount0);
            _safeApprove(v.token1, vault, amount1);
            bytes memory result = _safe(vault, abi.encodeCall(IAvkatCharm.deposit,
                (amount0, amount1, min0, min1, address(SAFE))));
            (uint256 shares,,) = abi.decode(result, (uint256, uint256, uint256));
            if (shares < minShares) revert SlippageTooHigh();
            _safeApprove(v.token0, vault, 0);
            _safeApprove(v.token1, vault, 0);
        } else if (v.kind == VAULT_ERC4626) {
            if (amount1 != 0) revert BadAmount();
            _safeApprove(v.token0, vault, amount0);
            uint256 shares = abi.decode(_safe(vault, abi.encodeCall(IAvkatERC4626.deposit,
                (amount0, address(SAFE)))), (uint256));
            if (shares < minShares) revert SlippageTooHigh();
            _safeApprove(v.token0, vault, 0);
        } else revert BadVault();
    }

    /// @notice Optional standalone swaps. The ONLY swap executor is the external SWAPPER.
    /// @dev Safe-approved router profile/route and owner-defined operator permissions apply.
    function executeApprovedSwaps(Swap[] calldata requests) external onlyExecutor {
        _executeExternalSwaps(requests);
    }
    function _executeExternalSwaps(Swap[] calldata requests) internal {
        for (uint256 i; i < requests.length; ++i) _externalSwapFromSafe(requests[i]);
    }

    // ---- Concentrated-liquidity mint, increase, withdraw and rebalance ----
    function withdrawRange(uint256 id, uint128 liquidity, uint256 min0, uint256 min1, bool burnIfEmpty)
        external onlyExecutor {
        _withdrawRange(id, liquidity, min0, min1, burnIfEmpty);
    }
    function _withdrawRange(uint256 id, uint128 liquidity, uint256 min0, uint256 min1, bool burnIfEmpty)
        internal returns (uint256 oldId) {
        Range storage r = ranges[id];
        if (!r.enabled || r.tokenId == 0) revert BadRange();
        oldId = r.tokenId;
        bool wasStaked = _unstakeIfNeeded(r);
        (,,,,,,, uint128 currentLiquidity,,,,) = IAvkatPositionManager(r.npm).positions(oldId);
        uint128 take = liquidity == type(uint128).max ? currentLiquidity : liquidity;
        if (take > currentLiquidity) revert BadAmount();
        if (take != 0) {
            _safe(r.npm, abi.encodeCall(IAvkatPositionManager.decreaseLiquidity,
                (IAvkatPositionManager.DecreaseParams(oldId, take, min0, min1, block.timestamp))));
        } else if (min0 != 0 || min1 != 0) revert BadAmount();
        _safe(r.npm, abi.encodeCall(IAvkatPositionManager.collect,
            (IAvkatPositionManager.CollectParams(oldId, address(SAFE), type(uint128).max, type(uint128).max))));
        if (burnIfEmpty) {
            if (take != currentLiquidity) revert BadAmount();
            _safe(r.npm, abi.encodeCall(IAvkatPositionManager.burn, (oldId)));
            r.tokenId = 0;
        } else if (wasStaked) _restake(r, oldId);
        emit RangeLiquidityRemoved(id, oldId, take);
    }
    function createRangeLiquidity(uint256 id, MintSpec calldata spec, Swap[] calldata preparationSwaps)
        external onlyExecutor returns (uint256 tokenId)
    {
        Range storage r = ranges[id];
        if (!r.enabled || r.tokenId != 0) revert BadRange();
        _executeExternalSwaps(preparationSwaps);
        tokenId = _mintRange(r, id, spec);
    }
    function addRangeLiquidity(uint256 id, uint256 desired0, uint256 desired1, uint256 min0, uint256 min1,
                               uint256 deadline, Swap[] calldata preparationSwaps) external onlyExecutor {
        Range storage r = ranges[id];
        if (!r.enabled || r.tokenId == 0) revert BadRange();
        if (block.timestamp > deadline) revert InvalidDeadline();
        _executeExternalSwaps(preparationSwaps);
        bool staked = _unstakeIfNeeded(r);
        _safeApprove(r.token0, r.npm, desired0);
        _safeApprove(r.token1, r.npm, desired1);
        _safe(r.npm, abi.encodeCall(IAvkatPositionManager.increaseLiquidity,
            (IAvkatPositionManager.IncreaseParams(r.tokenId, desired0, desired1, min0, min1, deadline))));
        _safeApprove(r.token0, r.npm, 0);
        _safeApprove(r.token1, r.npm, 0);
        if (staked) _restake(r, r.tokenId);
    }
    function rebalanceRange(uint256 id, uint256 minWithdraw0, uint256 minWithdraw1,
                            Swap[] calldata ratioSwaps, MintSpec calldata replacement)
        external onlyExecutor returns (uint256 newTokenId) {
        Range storage r = ranges[id];
        if (!r.enabled || r.tokenId == 0) revert BadRange();
        uint256 nowDay = block.timestamp / 1 days;
        if (block.timestamp < uint256(r.lastRebalanceAt) + r.minRebalanceInterval) revert BadRange();
        if (r.currentDay != nowDay) { r.currentDay = uint64(nowDay); r.rebalancesToday = 0; }
        if (r.rebalancesToday >= r.maxRebalancesPerDay) revert BadRange();
        uint256 old = r.tokenId;
        _withdrawRange(id, type(uint128).max, minWithdraw0, minWithdraw1, true);
        // Ratio selection is off-chain, not implemented by the module. Every actual
        // conversion is outsourced to the owner-approved external swapper.
        for (uint256 i; i < ratioSwaps.length; ++i) {
            Swap calldata sw = ratioSwaps[i];
            if ((sw.tokenIn != r.token0 && sw.tokenIn != r.token1) ||
                (sw.tokenOut != r.token0 && sw.tokenOut != r.token1) || sw.tokenIn == sw.tokenOut ||
                sw.amountIn == 0) revert BadConfiguration();
            _externalSwapFromSafe(sw);
        }
        newTokenId = _mintRange(r, id, replacement);
        r.lastRebalanceAt = uint64(block.timestamp);
        ++r.rebalancesToday;
        emit RangeRebalanced(id, old, newTokenId);
    }
    function _mintRange(Range storage r, uint256 id, MintSpec calldata s) internal returns (uint256 tid) {
        if (s.lower >= s.upper || block.timestamp > s.deadline || s.desired0 + s.desired1 == 0) {
            revert BadAmount();
        }
        _safeApprove(r.token0, r.npm, s.desired0);
        _safeApprove(r.token1, r.npm, s.desired1);
        bytes memory ret = _safe(r.npm, abi.encodeCall(IAvkatPositionManager.mint,
            (IAvkatPositionManager.MintParams(r.token0, r.token1, r.fee, s.lower, s.upper,
                s.desired0, s.desired1, s.min0, s.min1, address(SAFE), s.deadline))));
        (tid,,,) = abi.decode(ret, (uint256, uint128, uint256, uint256));
        _safeApprove(r.token0, r.npm, 0);
        _safeApprove(r.token1, r.npm, 0);
        r.tokenId = tid;
        if (r.staker != address(0)) _restake(r, tid);
        emit RangeMinted(id, tid);
    }
    function _unstakeIfNeeded(Range storage r) internal returns (bool staked) {
        address currentOwner = IAvkatPositionManager(r.npm).ownerOf(r.tokenId);
        if (currentOwner == r.staker && r.staker != address(0)) {
            if (IAvkatStaker(r.staker).getStaker(r.tokenId) != address(SAFE)) revert NotOwnedBySafe();
            _safe(r.staker, abi.encodeCall(IAvkatStaker.unstake, (r.tokenId)));
            staked = true;
        } else if (currentOwner != address(SAFE)) revert NotOwnedBySafe();
        if (IAvkatPositionManager(r.npm).ownerOf(r.tokenId) != address(SAFE)) revert NotOwnedBySafe();
    }
    function _restake(Range storage r, uint256 tid) internal {
        _safe(r.npm, abi.encodeCall(IAvkatPositionManager.approve, (r.staker, tid)));
        _safe(r.staker, abi.encodeCall(IAvkatStaker.stake, (tid)));
    }
    function _checkNft(address npm, address staker, uint256 tid, address token0, address token1, uint24 fee)
        internal view {
        (,,address t0,address t1,uint24 f,,,,,,,) = IAvkatPositionManager(npm).positions(tid);
        if (t0 != token0 || t1 != token1 || f != fee) revert BadRange();
        address owner = IAvkatPositionManager(npm).ownerOf(tid);
        if (owner == address(SAFE)) return;
        if (staker == address(0) || owner != staker ||
            IAvkatStaker(staker).getStaker(tid) != address(SAFE)) revert NotOwnedBySafe();
    }

    // ---- All swap execution and pricing outsourced to the Safe-approved external SWAPPER ----
    /// @dev This is only the approval and invocation adapter; it implements NO swap
    /// routing, pool interaction, path calculation, price feeds, or DEX callback.
    function _externalSwapFromSafe(Swap calldata request) internal returns (uint256 received) {
        address from = request.tokenIn;
        address to = request.tokenOut;
        if (from == address(0) || to == address(0) || from == to) revert BadConfiguration();
        uint256 input = request.amountIn == 0 ? _balance(from, address(SAFE)) : request.amountIn;
        if (input == 0) revert BadAmount();
        uint256 routerFloor = _conservativeQuote(address(SAFE), from, to, input);
        if (routerFloor == 0) revert SlippageTooHigh();
        uint256 minimum = request.minOut > routerFloor ? request.minOut : routerFloor;
        uint256 beforeOut = _balance(to, address(SAFE));
        _safeApprove(from, SWAPPER, input);
        _safe(SWAPPER, _routerCalldata(swapSelector, swapInputFields, address(SAFE),
            from, to, input, minimum));
        _safeApprove(from, SWAPPER, 0);
        received = _balance(to, address(SAFE)) - beforeOut;
        if (received < minimum) revert SlippageTooHigh();
    }
    /// @dev The module may temporarily hold flash assets; all swap output nevertheless
    /// goes to the Safe. Repayment proceeds are transferred back via the Safe only as needed.
    function _externalSwapFromSelf(address from, address to, uint256 input, uint256 minOut)
        internal returns (uint256 received) {
        if (input == 0) revert BadConfiguration();
        uint256 beforeOut = _balance(to, address(SAFE));
        _approveSelf(from, SWAPPER, input);
        (bool ok, bytes memory ret) = SWAPPER.call(_routerCalldata(
            swapSelector, swapInputFields, address(this), from, to, input, minOut));
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
        _approveSelf(from, SWAPPER, 0);
        received = _balance(to, address(SAFE)) - beforeOut;
        if (received < minOut) revert SlippageTooHigh();
    }
    /// @dev Only ABI encoding is performed here. No route selection, liquidity, DEX
    /// math, pricing or swap execution lives inside this Safe module.
    function _routerCalldata(
        bytes4 selector, RouterField[] storage fields, address caller,
        address from, address to, uint256 amount, uint256 minimum
    ) internal view returns (bytes memory payload) {
        payload = abi.encodePacked(selector);
        for (uint256 i; i < fields.length; ++i) {
            RouterField storage f = fields[i];
            bytes32 w;
            if (f.kind == FIELD_FIXED_WORD) w = f.fixedWord;
            else if (f.kind == FIELD_TOKEN_IN) w = bytes32(uint256(uint160(from)));
            else if (f.kind == FIELD_TOKEN_OUT) w = bytes32(uint256(uint160(to)));
            else if (f.kind == FIELD_AMOUNT_IN) w = bytes32(amount);
            else if (f.kind == FIELD_POLICY_MIN_OUT) w = bytes32(minimum);
            else if (f.kind == FIELD_SAFE_RECIPIENT) w = bytes32(uint256(uint160(address(SAFE))));
            else if (f.kind == FIELD_DEADLINE) w = bytes32(block.timestamp + routerDeadlineSeconds);
            else if (f.kind == FIELD_CALLER) w = bytes32(uint256(uint160(caller)));
            else revert BadConfiguration();
            payload = bytes.concat(payload, abi.encodePacked(w));
        }
    }
    /// @notice Pricing and route protection are delegated to the selected router.
    /// @dev Default quote is CurveYieldSushiV3FeeRouter.twapMinimumOut(...).
    ///      Alternate routers may supply 1-to-4 static return words; choose the
    ///      protected minimum's return word when configuring the router.
    function _conservativeQuote(address caller, address from, address to, uint256 amount)
        internal view returns (uint256) {
        (bool ok, bytes memory ret) = SWAPPER.staticcall(_routerCalldata(
            quoteSelector, quoteInputFields, caller, from, to, amount, 0));
        if (!ok || ret.length < 32 * (uint256(quoteResultWord) + 1)) return 0;
        uint256 minimum;
        uint256 index = uint256(quoteResultWord);
        assembly { minimum := mload(add(add(ret, 32), mul(index, 32))) }
        return _mulDiv(minimum, BPS - quoteSafetyBufferBps, BPS);
    }
    /// @dev AVKAT intrinsic share price is a risk policy, not internal swap pricing.
    function _hasRequiredPremium(uint256 katAmount, uint256 avOut) internal view returns (bool) {
        uint256 intrinsic = IAvkatRate(AVKAT).convertToShares(WAD);
        uint256 intrinsicOut = _mulDiv(katAmount, intrinsic, WAD);
        uint256 requiredOut = _mulDiv(intrinsicOut, BPS + minPremiumBps, BPS);
        return avOut >= requiredOut;
    }

    // ---- Conservative flash-size selection, Morpho accounting and safe execution ----
    function _findFlash(uint256 cap, uint256 held, uint256 target) internal view returns (uint256) {
        if (cap == 0) return 0;
        (uint256 debt, uint256 collateral, uint256 price) = _positionState(_params());
        uint256 existingAv = _balance(AVKAT, address(SAFE));
        if (_loopFeasible(cap, held, target, debt, collateral, existingAv, price)) return cap;
        uint256 low;
        uint256 high = cap;
        for (uint256 i; i < MAX_SEARCH_ROUNDS && low < high; ++i) {
            uint256 mid = low + (high - low + 1) / 2;
            if (_loopFeasible(mid, held, target, debt, collateral, existingAv, price)) low = mid;
            else high = mid - 1;
        }
        return low;
    }
    function _loopFeasible(uint256 flash, uint256 held, uint256 target, uint256 debt,
                           uint256 collateral, uint256 existingAv, uint256 price)
        internal view returns (bool) {
        uint256 input = flash + held;
        if (input == 0) return false;
        uint256 out = _conservativeQuote(address(this), KAT, AVKAT, input);
        if (out == 0 || !_hasRequiredPremium(input, out)) return false;
        uint256 value = _mulDiv(collateral + existingAv + out, price, 1e36);
        uint256 allowedDebt = _mulDiv(value, target, WAD);
        return debt + flash <= allowedDebt;
    }
    function _beginFlash(uint256 assets, uint8 mode, bytes memory payload) internal {
        if (assets == 0 || _flashMode != 0) revert BadFlashCallback();
        _flashMode = mode;
        _flashCommitment = keccak256(payload);
        MORPHO.flashLoan(KAT, assets, payload);
        if (_flashMode != 0 || _flashCommitment != bytes32(0)) revert BadFlashCallback();
        _approveSelf(KAT, address(MORPHO), 0);
        // Every legitimate path returned Morpho's KAT to the lender before leaving the flash call.
    }
    function ltvOf() public view returns (uint256) {
        (uint256 debt, uint256 collateral, uint256 price) = _positionState(_params());
        if (debt == 0) return 0;
        uint256 collateralValue = _mulDiv(collateral, price, 1e36);
        if (collateralValue == 0) return type(uint256).max;
        return _mulDivUp(debt, WAD, collateralValue);
    }
    function _positionState(AvkatMarketParams memory mp)
        internal view returns (uint256 debt, uint256 collateral, uint256 price) {
        (,uint128 borrowShares,uint128 collateralShares) = MORPHO.position(LOOP_MARKET, address(SAFE));
        (,,uint128 totalBorrowAssets,uint128 totalBorrowShares,,) = MORPHO.market(LOOP_MARKET);
        debt = _mulDivUp(borrowShares, uint256(totalBorrowAssets) + 1, uint256(totalBorrowShares) + 1e6);
        collateral = collateralShares;
        price = IAvkatOracle(mp.oracle).price();
        if (price == 0) revert BadConfiguration();
    }
    function _params() internal view returns (AvkatMarketParams memory mp) {
        (mp.loanToken, mp.collateralToken, mp.oracle, mp.irm, mp.lltv) = MORPHO.idToMarketParams(LOOP_MARKET);
        if (mp.loanToken != KAT || mp.collateralToken != AVKAT) revert BadConfiguration();
    }
    function _target(uint256 wanted) internal view returns (uint256) {
        if (wanted == 0) return targetLtv;
        if (wanted > targetLtv || wanted == 0) revert BadConfiguration();
        return wanted;
    }
    function _balance(address token, address owner) internal view returns (uint256) {
        return IAvkatERC20(token).balanceOf(owner);
    }
    function _safe(address destination, bytes memory payload) internal returns (bytes memory result) {
        (bool success, bytes memory data) = SAFE.execTransactionFromModuleReturnData(destination, 0, payload, 0);
        if (!success) revert SafeCallFailed(destination);
        return data;
    }
    function _safeTransfer(address token, address recipient, uint256 amount) internal {
        bytes memory out = _safe(token, abi.encodeCall(IAvkatERC20.transfer, (recipient, amount)));
        if (out.length != 0 && !abi.decode(out, (bool))) revert TokenCallFailed(token);
    }
    function _safeApprove(address token, address spender, uint256 amount) internal {
        bytes memory out = _safe(token, abi.encodeCall(IAvkatERC20.approve, (spender, 0)));
        if (out.length != 0 && !abi.decode(out, (bool))) revert TokenCallFailed(token);
        if (amount == 0) return;
        out = _safe(token, abi.encodeCall(IAvkatERC20.approve, (spender, amount)));
        if (out.length != 0 && !abi.decode(out, (bool))) revert TokenCallFailed(token);
    }
    function _approveSelf(address token, address spender, uint256 amount) internal {
        _callToken(token, abi.encodeCall(IAvkatERC20.approve, (spender, 0)));
        if (amount != 0) _callToken(token, abi.encodeCall(IAvkatERC20.approve, (spender, amount)));
    }
    function _transferSelf(address token, address recipient, uint256 amount) internal {
        _callToken(token, abi.encodeCall(IAvkatERC20.transfer, (recipient, amount)));
    }
    function _callToken(address token, bytes memory callData) internal {
        (bool ok, bytes memory result) = token.call(callData);
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TokenCallFailed(token);
    }

    // Full-precision floor(a*b/denominator), with the same 512-bit algorithm used by established mulDiv libraries.
    function _mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        if (denominator == 0) revert BadAmount();
        uint256 prod0; uint256 prod1;
        assembly {
            let mm := mulmod(a, b, not(0))
            prod0 := mul(a, b)
            prod1 := sub(sub(mm, prod0), lt(mm, prod0))
        }
        if (prod1 == 0) return prod0 / denominator;
        if (denominator <= prod1) revert BadAmount();
        uint256 remainder;
        assembly {
            remainder := mulmod(a, b, denominator)
            prod1 := sub(prod1, gt(remainder, prod0))
            prod0 := sub(prod0, remainder)
        }
        uint256 twos = denominator & (~denominator + 1);
        assembly {
            denominator := div(denominator, twos)
            prod0 := div(prod0, twos)
            twos := add(div(sub(0, twos), twos), 1)
        }
        uint256 inv;
        unchecked {
            prod0 |= prod1 * twos;
            inv = (3 * denominator) ^ 2;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            result = prod0 * inv;
        }
    }
    function _mulDivUp(uint256 a, uint256 b, uint256 d) internal pure returns (uint256 result) {
        result = _mulDiv(a, b, d);
        if (mulmod(a, b, d) > 0) {
            if (result == type(uint256).max) revert BadAmount();
            ++result;
        }
    }
}