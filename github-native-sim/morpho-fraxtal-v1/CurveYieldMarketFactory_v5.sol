// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.19;

import {ICurveYieldMorphoCore} from "./CurveYieldMorphoOwnerAndSplitterV5.sol";
import {CurveYieldMorphoOwnerV5} from "./CurveYieldMorphoOwnerV5.sol";

/// @notice Market creation plus creator/CurveYield fee-share accounting.
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
contract CurveYieldMarketFactory {
    uint256 public constant WAD = 1e18;
    uint256 public constant CURVEYIELD_BASE_FEE = 0.008e18;
    uint256 public constant MAX_CREATOR_FEE = 0.22e18;
    uint256 public constant CURVEYIELD_REVENUE_SHARE = 0.10e18;
    uint256 public constant MORPHO_MAX_FEE = 0.25e18;

    ICurveYieldMorphoCore public immutable morpho;
    CurveYieldMorphoOwnerV5 public governance;
    address public immutable safe;
    address public owner;
    address public pendingOwner;
    address public treasury;
    uint256 public immutable maxCallerFeeWei;
    uint256 public callerFeeWei;

    struct CreatorMarket {
        address creator;
        address receiver;
        uint128 creatorFee;
        uint128 totalFee;
    }

    mapping(bytes32 => CreatorMarket) public creatorMarket;
    mapping(bytes32 => uint256) public creatorOwedShares;
    mapping(bytes32 => uint256) public treasuryOwedShares;
    uint256 private _entered;

    error Unauthorized();
    error ZeroAddress();
    error InvalidFee();
    error MorphoFeeCapExceeded(uint256 requested, uint256 maximum);
    error AlreadyExists();
    error NotRegistered();
    error FeeRoutingInactive();
    error InvalidGovernance();
    error NoClaimableShares();
    error InsufficientAssets();
    error ShareAccountingMismatch();
    error Reentrant();
    error ExcessiveCallerFee();
    error IncorrectCallerFee();
    error InvalidReceiver();
    error EthTransferFailed();

    event MarketCreated(bytes32 indexed id, address indexed creator, address indexed receiver,
                        uint256 creatorFee, uint256 totalFee);
    event FeeSharesAccounted(bytes32 indexed id, uint256 creatorShares, uint256 treasuryShares);
    event FeeSharesRedeemed(bytes32 indexed id, address indexed receiver, bool forCreator,
                            uint256 shares, uint256 assets);
    event CreatorReceiverUpdated(bytes32 indexed id, address indexed receiver);
    event TreasuryUpdated(address indexed treasury);
    event GovernanceUpdated(address indexed previousGovernance, address indexed nextGovernance);
    event OwnershipTransferStarted(address indexed pendingOwner);
    event OwnershipTransferred(address indexed owner);
    event CallerFeeUpdated(uint256 previousFeeWei, uint256 newFeeWei);
    event CallerFeesWithdrawn(address indexed receiver, uint256 amount);

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

    constructor(
        address morpho_, address governance_, address owner_, address treasury_,
        uint256 initialCallerFeeWei_, uint256 maxCallerFeeWei_
    ) {
        if (morpho_ == address(0) || governance_ == address(0) || owner_ == address(0)
            || treasury_ == address(0)) revert ZeroAddress();
        morpho = ICurveYieldMorphoCore(morpho_);
        CurveYieldMorphoOwnerV5 controller = CurveYieldMorphoOwnerV5(governance_);
        // Splitter administration starts at the Safe, not the controller.
        if (governance_.code.length == 0 ||
            address(controller.morpho()) != morpho_ ||
            controller.safe() != owner_) revert InvalidGovernance();
        if (initialCallerFeeWei_ > maxCallerFeeWei_) revert ExcessiveCallerFee();
        governance = controller;
        safe = owner_;
        owner = owner_;
        treasury = treasury_;
        maxCallerFeeWei = maxCallerFeeWei_;
        callerFeeWei = initialCallerFeeWei_;
        emit OwnershipTransferred(owner_);
        emit TreasuryUpdated(treasury_);
    }

    function feeBreakdown(uint256 creatorFee)
        public pure returns (uint256 totalFee, uint256 curveYieldFee, uint256 creatorFeeOut)
    {
        if (creatorFee > MAX_CREATOR_FEE) revert InvalidFee();
        // The 22% creator cap algebraically guarantees Morpho's 25% maximum.
        unchecked {
            curveYieldFee = CURVEYIELD_BASE_FEE + creatorFee * CURVEYIELD_REVENUE_SHARE / WAD;
            totalFee = creatorFee + curveYieldFee;
        }
        creatorFeeOut = creatorFee;
    }

    function marketId(ICurveYieldMorphoCore.MarketParams calldata params)
        public pure returns (bytes32)
    {
        return keccak256(abi.encode(params));
    }

    /// @notice One permissionless transaction: register creator, create market,
    function createMarket(
        ICurveYieldMorphoCore.MarketParams calldata params,
        address creatorReceiver,
        uint256 creatorFee
    ) external payable nonReentrant returns (bytes32 id) {
        if (msg.value != callerFeeWei) revert IncorrectCallerFee();
        if (creatorReceiver == address(0)) revert ZeroAddress();
        (uint256 totalFee,,) = feeBreakdown(creatorFee);
        if (morpho.owner() != address(governance) || morpho.feeRecipient() != address(this))
            revert FeeRoutingInactive();

        id = marketId(params);
        if (creatorMarket[id].creator != address(0)) revert AlreadyExists();

        creatorMarket[id] = CreatorMarket({
            creator: msg.sender,
            receiver: creatorReceiver,
            creatorFee: uint128(creatorFee),
            totalFee: uint128(totalFee)
        });

        morpho.createMarket(params);
        governance.setFee(params, totalFee);
        emit MarketCreated(id, msg.sender, creatorReceiver, creatorFee, totalFee);
    }

    function claim(
        ICurveYieldMorphoCore.MarketParams calldata params,
        bool forCreator,
        uint256 maximumShares,
        uint256 minimumAssets
    ) external nonReentrant returns (uint256 assetsWithdrawn, uint256 sharesWithdrawn) {
        bytes32 id = marketId(params);
        morpho.accrueInterest(params);
        _sync(id);

        CreatorMarket storage cfg = creatorMarket[id];
        if (forCreator && cfg.creator == address(0)) revert NotRegistered();

        uint256 owed = forCreator ? creatorOwedShares[id] : treasuryOwedShares[id];
        sharesWithdrawn = maximumShares == 0 || maximumShares > owed ? owed : maximumShares;
        if (sharesWithdrawn == 0) revert NoClaimableShares();

        // sharesWithdrawn <= owed.
        unchecked {
            if (forCreator) creatorOwedShares[id] = owed - sharesWithdrawn;
            else treasuryOwedShares[id] = owed - sharesWithdrawn;
        }

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
        if (cfg.creator == address(0)) revert NotRegistered();
        if (msg.sender != cfg.creator && msg.sender != cfg.receiver) revert Unauthorized();
        if (nextReceiver == address(0)) revert ZeroAddress();
        cfg.receiver = nextReceiver;
        emit CreatorReceiverUpdated(id, nextReceiver);
    }

    /// @notice Switch the fee/market controller without transferring ownership
    function setGovernance(address nextGovernance) external {
        if (msg.sender != safe) revert Unauthorized();
        if (nextGovernance.code.length == 0) revert InvalidGovernance();
        CurveYieldMorphoOwnerV5 next = CurveYieldMorphoOwnerV5(nextGovernance);
        address registeredSplitter = next.marketFactory();
        if (address(next.morpho()) != address(morpho) ||
            next.safe() != safe ||
            (registeredSplitter != address(0) && registeredSplitter != address(this)))
            revert InvalidGovernance();
        address previous = address(governance);
        governance = next;
        emit GovernanceUpdated(previous, nextGovernance);
    }

    function setCallerFee(uint256 nextFeeWei) external onlyOwner {
        if (nextFeeWei > maxCallerFeeWei) revert ExcessiveCallerFee();
        uint256 oldFee = callerFeeWei;
        callerFeeWei = nextFeeWei;
        emit CallerFeeUpdated(oldFee, nextFeeWei);
    }

    function withdrawCallerFees(address payable receiver) external onlyOwner {
        if (receiver == address(0)) revert InvalidReceiver();
        uint256 amount = address(this).balance;
        (bool success,) = receiver.call{value: amount}("");
        if (!success) revert EthTransferFailed();
        emit CallerFeesWithdrawn(receiver, amount);
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

    function _sync(bytes32 id) internal {
        (uint256 totalShares,,) = morpho.position(id, address(this));
        uint256 accounted = creatorOwedShares[id] + treasuryOwedShares[id];
        if (totalShares < accounted) revert ShareAccountingMismatch();
        uint256 unaccounted;
        unchecked { unaccounted = totalShares - accounted; }
        if (unaccounted == 0) return;

        CreatorMarket storage cfg = creatorMarket[id];
        uint256 creatorNew = cfg.creator != address(0) && _marketFee(id) == cfg.totalFee
            ? unaccounted * uint256(cfg.creatorFee) / uint256(cfg.totalFee)
            : 0;
        // Accounting is bounded by Morpho totalShares.
        unchecked {
            creatorOwedShares[id] += creatorNew;
            treasuryOwedShares[id] += unaccounted - creatorNew;
        }
        emit FeeSharesAccounted(id, creatorNew, unaccounted - creatorNew);
    }
}