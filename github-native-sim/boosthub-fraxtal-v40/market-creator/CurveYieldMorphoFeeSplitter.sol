// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

/// @notice Minimal ABI of the unchanged, deployed Morpho Blue core.
interface IMorphoCurveYield {
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }

    function createMarket(MarketParams calldata params) external;
    function accrueInterest(MarketParams calldata params) external;
    function market(bytes32 id) external view returns (
        uint128 totalSupplyAssets,
        uint128 totalSupplyShares,
        uint128 totalBorrowAssets,
        uint128 totalBorrowShares,
        uint128 lastUpdate,
        uint128 fee
    );
    function position(bytes32 id, address account) external view returns (
        uint256 supplyShares,
        uint128 borrowShares,
        uint128 collateral
    );
    function withdraw(
        MarketParams calldata params,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsWithdrawn, uint256 sharesWithdrawn);
}

/// @title CurveYield Morpho Creator Fee Splitter
/// @notice An optional, permissionless market-creation entry point and per-market
///         routing of fee shares minted by an UNMODIFIED Morpho Blue core.
/// @dev This does NOT have permission to call Morpho.setFee() or setFeeRecipient().
///      The Morpho owner must set the global feeRecipient to this contract,
///      set the requested market fee, and then activate that market.
///      For markets not registered through createMarket(), 100% of this
///      contract's newly received Morpho fee shares accrue to CurveYield.
///      Underlying loan assets are paid by Morpho.withdraw, so claims may
///      temporarily fail when available loan-token liquidity is insufficient.
contract CurveYieldMorphoFeeSplitter {
    uint256 public constant WAD = 1e18;
    uint256 public constant CURVEYIELD_BASE_FEE = 0.02e18;
    uint256 public constant MAX_CREATOR_FEE = 0.15e18;
    uint256 public constant CURVEYIELD_REVENUE_SHARE = 0.20e18;

    IMorphoCurveYield public immutable morpho;
    address public owner;
    address public pendingOwner;
    address public treasury;

    struct CreatorMarket {
        address creator;
        address receiver;
        uint128 creatorFee;
        uint128 totalFee;
        bool active;
    }

    mapping(bytes32 => CreatorMarket) public creatorMarket;
    mapping(bytes32 => uint256) public creatorOwedShares;
    mapping(bytes32 => uint256) public treasuryOwedShares;

    uint256 private _entered;

    error Unauthorized();
    error ZeroAddress();
    error InvalidFee();
    error AlreadyExists();
    error NotRegistered();
    error FeeNotConfigured();
    error NoClaimableShares();
    error InsufficientAssets();
    error ShareAccountingMismatch();
    error Reentrant();

    event MarketRequested(bytes32 indexed id, address indexed creator, address indexed receiver, uint256 creatorFee, uint256 totalFee);
    event MarketActivated(bytes32 indexed id, uint256 totalFee);
    event FeeSharesAccounted(bytes32 indexed id, uint256 creatorShares, uint256 treasuryShares);
    event FeeSharesRedeemed(bytes32 indexed id, address indexed receiver, bool forCreator, uint256 shares, uint256 assets);
    event CreatorReceiverUpdated(bytes32 indexed id, address indexed receiver);
    event TreasuryUpdated(address indexed treasury);
    event OwnershipTransferStarted(address indexed pendingOwner);
    event OwnershipTransferred(address indexed owner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (_entered != 0) revert Reentrant();
        _entered = 1;
        _;
        _entered = 0;
    }

    constructor(address morpho_, address owner_, address treasury_) {
        if (morpho_ == address(0) || owner_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        morpho = IMorphoCurveYield(morpho_);
        owner = owner_;
        treasury = treasury_;
        emit OwnershipTransferred(owner_);
        emit TreasuryUpdated(treasury_);
    }

    function feeBreakdown(uint256 creatorFee)
        public pure returns (uint256 totalFee, uint256 curveYieldFee, uint256 creatorFeeOut)
    {
        if (creatorFee > MAX_CREATOR_FEE) revert InvalidFee();
        curveYieldFee = CURVEYIELD_BASE_FEE + (creatorFee * CURVEYIELD_REVENUE_SHARE / WAD);
        totalFee = creatorFee + curveYieldFee;
        creatorFeeOut = creatorFee;
    }

    function marketId(IMorphoCurveYield.MarketParams calldata params) public pure returns (bytes32) {
        return keccak256(abi.encode(params));
    }

    /// @notice Creates an ordinary Morpho market while recording fee ownership.
    /// @dev The core still creates the market at zero fee. Owner-side setFee
    ///      and activation are separate, explicitly visible follow-up actions.
    function createMarket(
        IMorphoCurveYield.MarketParams calldata params,
        address creatorReceiver,
        uint256 creatorFee
    ) external nonReentrant returns (bytes32 id) {
        if (creatorReceiver == address(0)) revert ZeroAddress();
        (uint256 totalFee,,) = feeBreakdown(creatorFee);
        id = marketId(params);
        if (creatorMarket[id].creator != address(0)) revert AlreadyExists();

        creatorMarket[id] = CreatorMarket({
            creator: msg.sender,
            receiver: creatorReceiver,
            creatorFee: uint128(creatorFee),
            totalFee: uint128(totalFee),
            active: false
        });

        // Morpho remains unmodified and permissionless. This reverts if the
        // selected market exists or the IRM/LLTV is not enabled.
        morpho.createMarket(params);

        emit MarketRequested(id, msg.sender, creatorReceiver, creatorFee, totalFee);
    }

    /// @notice Enables creator fee allocation AFTER the Morpho owner has set
    ///         the expected market fee and the global fee recipient is this splitter.
    /// @dev Accrued shares before activation are conservatively assigned
    ///      to CurveYield; the creator accrues only from subsequent fees.
    function activateMarket(IMorphoCurveYield.MarketParams calldata params) external nonReentrant {
        bytes32 id = marketId(params);
        CreatorMarket storage cfg = creatorMarket[id];
        if (cfg.creator == address(0)) revert NotRegistered();
        if (cfg.active) revert AlreadyExists();
        if (_marketFee(id) != cfg.totalFee) revert FeeNotConfigured();

        morpho.accrueInterest(params);
        _sync(id, false);
        cfg.active = true;
        emit MarketActivated(id, cfg.totalFee);
    }

    /// @notice Accrues and accounts the latest Morpho fee shares.
    /// @dev Requires the Morpho global fee recipient to be this contract to
    ///      receive NEW shares. Legacy shares at the old recipient are untouched.
    function synchronize(IMorphoCurveYield.MarketParams calldata params) external nonReentrant {
        bytes32 id = marketId(params);
        morpho.accrueInterest(params);
        _sync(id, true);
    }

    function claim(
        IMorphoCurveYield.MarketParams calldata params,
        bool forCreator,
        uint256 maximumShares,
        uint256 minimumAssets
    ) external nonReentrant returns (uint256 assetsWithdrawn, uint256 sharesWithdrawn) {
        bytes32 id = marketId(params);
        morpho.accrueInterest(params);
        _sync(id, true);

        CreatorMarket storage cfg = creatorMarket[id];
        if (forCreator && cfg.creator == address(0)) revert NotRegistered();

        uint256 owed = forCreator ? creatorOwedShares[id] : treasuryOwedShares[id];
        sharesWithdrawn = maximumShares == 0 || maximumShares > owed ? owed : maximumShares;
        if (sharesWithdrawn == 0) revert NoClaimableShares();

        // Decrement BEFORE the external call. Revert restores these counters.
        if (forCreator) creatorOwedShares[id] = owed - sharesWithdrawn;
        else treasuryOwedShares[id] = owed - sharesWithdrawn;

        address receiver = forCreator ? cfg.receiver : treasury;
        uint256 burnedShares;
        (assetsWithdrawn, burnedShares) = morpho.withdraw(
            params, 0, sharesWithdrawn, address(this), receiver
        );
        if (burnedShares != sharesWithdrawn) revert ShareAccountingMismatch();
        if (assetsWithdrawn == 0 || assetsWithdrawn < minimumAssets) revert InsufficientAssets();

        emit FeeSharesRedeemed(id, receiver, forCreator, sharesWithdrawn, assetsWithdrawn);
    }

    function setCreatorReceiver(bytes32 id, address nextReceiver) external {
        CreatorMarket storage cfg = creatorMarket[id];
        if (msg.sender != cfg.creator || cfg.creator == address(0)) revert Unauthorized();
        if (nextReceiver == address(0)) revert ZeroAddress();
        cfg.receiver = nextReceiver;
        emit CreatorReceiverUpdated(id, nextReceiver);
    }

    function setTreasury(address nextTreasury) external onlyOwner {
        if (nextTreasury == address(0)) revert ZeroAddress();
        treasury = nextTreasury;
        emit TreasuryUpdated(nextTreasury);
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        if (nextOwner == address(0)) revert ZeroAddress();
        pendingOwner = nextOwner;
        emit OwnershipTransferStarted(nextOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(msg.sender);
    }

    function _marketFee(bytes32 id) internal view returns (uint256 fee) {
        (,,,,, uint128 currentFee) = morpho.market(id);
        return currentFee;
    }

    function _sync(bytes32 id, bool allowCreator) internal {
        (uint256 totalShares,,) = morpho.position(id, address(this));
        uint256 accounted = creatorOwedShares[id] + treasuryOwedShares[id];
        if (totalShares < accounted) revert ShareAccountingMismatch();
        uint256 unaccounted = totalShares - accounted;
        if (unaccounted == 0) return;

        CreatorMarket storage cfg = creatorMarket[id];
        // If the owner's live fee differs from the registered expected fee,
        // no unverified fee configuration earns creator shares.
        uint256 creatorNew = allowCreator && cfg.active && _marketFee(id) == cfg.totalFee
            ? unaccounted * uint256(cfg.creatorFee) / uint256(cfg.totalFee)
            : 0;
        creatorOwedShares[id] += creatorNew;
        treasuryOwedShares[id] += unaccounted - creatorNew;
        emit FeeSharesAccounted(id, creatorNew, unaccounted - creatorNew);
    }
}