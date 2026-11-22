// SPDX-License-Identifier: MIT
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
pragma solidity ^0.8.20;

// Based on beefyfinance/beefy-contracts/contracts/BIFI/vaults/BeefyVaultV7.sol
// Original blob SHA: ac3e92ec59a18d728ae57575202c4f31d05a4786
// v63: ERC-4626 entrypoints reuse original v61 Beefy accounting and valuation.
// v2: Send 100% of the fee from the final share withdrawal to adminFeeReceiver.
import "@openzeppelin-4/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin-4/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin-4/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin-4/contracts/access/Ownable.sol";
import "@openzeppelin-4/contracts/utils/math/Math.sol";
import "./interfaces/IStrategyBoostHubV1.sol";

interface IEmergencyDualFXNMasterV54 {
    function emergencyWithdraw(uint256 amount) external;
}

contract BeefyVaultV7FixedV2 is ERC20, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    IStrategyBoostHubV1 public immutable strategy;
    IERC20 public immutable underlying;
    uint256 public immutable withdrawalFeeBps;
    uint256 public depositFeeBps;
    address public adminFeeReceiver;
    address public pendingAdminFeeReceiver;
    uint256 public adminFeeReceiverChangeReadyAt;

    uint256 public constant FEE_DENOMINATOR = 10_000;
    uint256 public constant MAX_DEPOSIT_FEE_BPS = 100;
    uint256 public constant ADMIN_FEE_SHARE_BPS = 3_000;
    uint256 public constant RECEIVER_CHANGE_DELAY = 7 days;

    // One vault-level ring; every observation contains its actual timestamp and PPS.
    // A checkpoint may be recorded at most once per 12 hours, including manual updates.
    struct APYSample { uint40 timestamp; uint216 pps; }
    APYSample[10] private apyHistory;
    uint40 public lastAPYCheckpoint;
    uint8 public apyNext;
    uint8 public apyCount;
    uint256 public constant APY_MIN_INTERVAL = 12 hours;
    uint256 public constant APY_SAMPLES = 10;
    uint256 private constant APY_HOOK_GAS = 300_000;
    uint256 private constant APY_HOOK_RESERVE = 250_000;
    uint256 private constant WAD = 1e18;
    uint256 private constant YEAR = 365 days;
    // Saturation prevents an extreme PPS movement from reverting public APY reads.
    uint256 private constant MAX_APY_WAD = 1_000_000e18;
    uint256 private constant MAX_FACTOR_WAD = WAD + MAX_APY_WAD;

    // Standard ERC-4626 events; assets denote user-supplied/user-received amounts.
    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares);

    event APYUpdated(uint256 indexed timestamp, uint256 pps, uint8 observations);
    event APYHistoryReset();

    event DepositFeeChanged(uint256 oldFeeBps, uint256 newFeeBps);
    event AdminFeeReceiverProposed(address indexed previousReceiver, address indexed proposedReceiver, uint256 readyAt);
    event AdminFeeReceiverChanged(address indexed previousReceiver, address indexed newReceiver);
    event WithdrawalFeeCharged(address indexed account, uint256 grossUnderlying, uint256 shareholderRetention, uint256 administratorPayment);
    event EmergencyWithdrawal(address indexed account, uint256 sharesBurned, uint256 grossUnderlying, uint256 assetsPaid);

    constructor(
        IStrategyBoostHubV1 _strategy,
        string memory _name,
        string memory _symbol,
        uint256 _withdrawalFeeBps,
        address _adminFeeReceiver
    ) ERC20(_name, _symbol) {
        require(address(_strategy) != address(0) && address(_strategy).code.length > 0, "Invalid strategy");
        require(_adminFeeReceiver != address(0), "Invalid fee receiver");
        require(_withdrawalFeeBps <= FEE_DENOMINATOR, "Invalid withdrawal fee");
        require(_strategy.vault() == address(this), "Strategy not bound to vault");
        IERC20 _want = IERC20(_strategy.want());
        require(address(_want) != address(0), "Invalid underlying");
        strategy = _strategy;
        underlying = _want;
        withdrawalFeeBps = _withdrawalFeeBps;
        adminFeeReceiver = _adminFeeReceiver;
    }

    function setDepositFeeBps(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= MAX_DEPOSIT_FEE_BPS, "Deposit fee exceeds 1%");
        emit DepositFeeChanged(depositFeeBps, _feeBps);
        depositFeeBps = _feeBps;
    }

    function want() public view returns (IERC20) {
        return underlying;
    }

    function balance() public view returns (uint256) {
        return want().balanceOf(address(this)) + strategy.balanceOf();
    }

    function available() public view returns (uint256) {
        return want().balanceOf(address(this));
    }

    function getPricePerFullShare() public view returns (uint256) {
        return totalSupply() == 0 ? 1e18 : balance() * 1e18 / totalSupply();
    }

    /// @notice ERC-4626 asset metadata used by Curve StableSwap-NG (asset type 3).
    function asset() external view returns (address) {
        return address(underlying);
    }

    function totalAssets() external view returns (uint256) {
        return balance();
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return assets;
        uint256 pool = balance();
        return pool == 0 ? 0 : Math.mulDiv(assets, supply, pool);
    }

    /// @notice Underlying assets represented by shares, using the vault's existing NAV accounting.
    /// @dev Curve calls this with 10**decimals() shares to derive its normalized pool rate.
    function convertToAssets(uint256 shares) public view returns (uint256) {
        uint256 supply = totalSupply();
        return supply == 0 ? shares : shares * balance() / supply;
    }

    /// @dev Investment entry losses cannot be quoted exactly before execution.
    ///      The preview includes the configured deposit fee but assumes unchanged
    ///      market liquidity; final minting uses actual post-investment NAV.
    function previewDeposit(uint256 assets) public view returns (uint256) {
        uint256 netAssets = assets - Math.mulDiv(assets, depositFeeBps, FEE_DENOMINATOR);
        return convertToShares(netAssets);
    }

    /// @dev Rounds asset expenditure upward; a mint reverts if real investment
    ///      execution cannot fund all requested shares at this quoted amount.
    function previewMint(uint256 shares) public view returns (uint256) {
        if (shares == 0) return 0;
        uint256 supply = totalSupply();
        uint256 netAssets = supply == 0 ? shares : Math.mulDiv(shares, balance(), supply, Math.Rounding.Up);
        uint256 bps = FEE_DENOMINATOR - depositFeeBps;
        return Math.mulDiv(netAssets, FEE_DENOMINATOR, bps, Math.Rounding.Up);
    }

    /// @notice Minimum share burn to receive exactly `assets` after the withdrawal fee.
    function previewWithdraw(uint256 assets) public view returns (uint256) {
        if (assets == 0) return 0;
        uint256 netBps = FEE_DENOMINATOR - withdrawalFeeBps;
        require(netBps != 0, "100% withdrawal fee");
        uint256 gross = Math.mulDiv(assets, FEE_DENOMINATOR, netBps, Math.Rounding.Up);
        // The fee rounds DOWN. Adjust away the at-most-one-unit overestimate.
        if (gross != 0) {
            uint256 smaller = gross - 1;
            if (smaller - Math.mulDiv(smaller, withdrawalFeeBps, FEE_DENOMINATOR) >= assets) gross = smaller;
        }
        uint256 supply = totalSupply();
        if (supply == 0) return gross;
        uint256 pool = balance();
        require(pool != 0, "Empty NAV");
        return Math.mulDiv(gross, supply, pool, Math.Rounding.Up);
    }

    /// @notice Assets delivered after the immutable withdrawal fee, rounded downward.
    function previewRedeem(uint256 shares) public view returns (uint256) {
        uint256 gross = convertToAssets(shares);
        return gross - Math.mulDiv(gross, withdrawalFeeBps, FEE_DENOMINATOR);
    }

    /// @dev No configured deposit cap. A failing strategy deposit can still revert.
    function maxDeposit(address receiver) external pure returns (uint256) {
        return receiver == address(0) ? 0 : type(uint256).max;
    }

    function maxMint(address receiver) external pure returns (uint256) {
        return receiver == address(0) ? 0 : type(uint256).max;
    }

    function maxRedeem(address owner) external view returns (uint256) {
        return balanceOf(owner);
    }

    function maxWithdraw(address owner) external view returns (uint256) {
        return previewRedeem(balanceOf(owner));
    }

    /// @notice Permissionless vault-only PPS snapshot. Never more than once every 12 hours.
    /// @dev All vault accounting actions also best-effort call this same updater.
    function updateAPY() external { _updateAPY(); }

    /// @notice Chronological observations, index zero is oldest retained checkpoint.
    function apySample(uint256 index) external view returns (uint256 timestamp, uint256 pps) {
        require(index < apyCount, "APY_SAMPLE_OOB");
        uint256 oldest = (uint256(apyNext) + APY_SAMPLES - uint256(apyCount)) % APY_SAMPLES;
        APYSample memory sample = apyHistory[(oldest + index) % APY_SAMPLES];
        return (sample.timestamp, sample.pps);
    }

    function _tryUpdateAPY() private {
        // The empty-vault transition invalidates earlier share-price history.
        if (totalSupply() == 0) { _resetAPY(); return; }
        if (apyCount != 0 && block.timestamp < uint256(lastAPYCheckpoint) + APY_MIN_INTERVAL) return;
        // A failing strategy valuation must never block a user withdrawal/deposit.
        if (gasleft() > APY_HOOK_GAS + APY_HOOK_RESERVE) {
            try this.updateAPY{gas: APY_HOOK_GAS}() {} catch {}
        }
    }

    function _resetAPY() private {
        if (apyCount == 0) return;
        apyCount = 0;
        apyNext = 0;
        lastAPYCheckpoint = 0;
        emit APYHistoryReset();
    }

    function _updateAPY() private {
        if (totalSupply() == 0) { _resetAPY(); return; }
        if (apyCount != 0 && block.timestamp < uint256(lastAPYCheckpoint) + APY_MIN_INTERVAL) return;
        uint256 pps = getPricePerFullShare();
        if (pps == 0 || pps > type(uint216).max) return;
        apyHistory[apyNext] = APYSample(uint40(block.timestamp), uint216(pps));
        apyNext = uint8((uint256(apyNext) + 1) % APY_SAMPLES);
        if (apyCount < APY_SAMPLES) ++apyCount;
        lastAPYCheckpoint = uint40(block.timestamp);
        emit APYUpdated(block.timestamp, pps, apyCount);
    }

    function _oldestAPY() private view returns (APYSample memory) {
        uint256 oldest = (uint256(apyNext) + APY_SAMPLES - uint256(apyCount)) % APY_SAMPLES;
        return apyHistory[oldest];
    }

    /// @dev Returns the net share-price appreciation per second (WAD units),
    ///      plus a usable-state flag; negative performance is represented as zero.
    function _growthPerSecond(uint256 ppsNow) private view returns (bool ready, uint256 growthWad, uint256 elapsed) {
        if (totalSupply() == 0 || apyCount == 0 || ppsNow == 0) return (false, 0, 0);
        APYSample memory sample = _oldestAPY();
        if (sample.pps == 0 || sample.timestamp >= block.timestamp) return (false, 0, 0);
        elapsed = block.timestamp - uint256(sample.timestamp);
        growthWad = Math.mulDiv(ppsNow, WAD, uint256(sample.pps));
        return (true, growthWad, elapsed);
    }

    function _readGrowth() private view returns (bool, uint256, uint256) {
        // Preserve an always-safe read if an external strategy PPS valuation reverts.
        try this.getPricePerFullShare() returns (uint256 pps) {
            return _growthPerSecond(pps);
        } catch { return (false, 0, 0); }
    }

    /// @notice True once at least one stored PPS and a later live PPS can be compared.
    /// @dev APY remains readable when fewer than all 10 history slots are filled.
    function apyReady() external view returns (bool) {
        (bool ready,,) = _readGrowth();
        return ready;
    }

    function _boundedMulWad(uint256 a, uint256 b) private pure returns (uint256) {
        if (a >= MAX_FACTOR_WAD || b >= MAX_FACTOR_WAD) return MAX_FACTOR_WAD;
        if (a > MAX_FACTOR_WAD * WAD / b) return MAX_FACTOR_WAD;
        return a * b / WAD;
    }

    function _boundedPowWad(uint256 base, uint256 exponent) private pure returns (uint256 result) {
        result = WAD;
        while (exponent != 0) {
            if ((exponent & 1) != 0) result = _boundedMulWad(result, base);
            exponent >>= 1;
            if (exponent != 0) base = _boundedMulWad(base, base);
        }
    }

    /// @notice Vault-wide compounded annual percentage yield; 1e18 represents 100% APY.
    /// @dev Annualizes the oldest available retained PPS vs current live PPS.
    ///      Complete elapsed periods compound geometrically; the fractional
    ///      remainder is linearly interpolated (negligible at ordinary yields).
    function getAPY() public view returns (uint256) {
        (bool ready, uint256 factorWad, uint256 elapsed) = _readGrowth();
        if (!ready || factorWad <= WAD) return 0;
        uint256 fullPeriods = YEAR / elapsed;
        uint256 remainder = YEAR % elapsed;
        uint256 annualFactor = _boundedPowWad(factorWad, fullPeriods);
        if (remainder != 0) {
            uint256 extra = WAD + Math.mulDiv(factorWad - WAD, remainder, elapsed);
            annualFactor = _boundedMulWad(annualFactor, extra);
        }
        return annualFactor - WAD;
    }

    /// @notice Simple per-second realized PPS growth, retained for lending-oracle compatibility.
    /// @dev This is a per-second rate, NOT an APR-labelled public reading. Use getAPY for APY.
    function rate() external view returns (uint256) {
        (bool ready, uint256 factorWad, uint256 elapsed) = _readGrowth();
        return !ready || factorWad <= WAD ? 0 : (factorWad - WAD) / elapsed;
    }

    function depositAll() external {
        deposit(want().balanceOf(msg.sender));
    }

    /// @notice Legacy Beefy deposit; no change to its original selector.
    function deposit(uint256 assets) public nonReentrant {
        _depositAssets(assets, msg.sender, 0);
    }

    /// @notice ERC-4626 exact-asset deposit, shares minted to `receiver`.
    function deposit(uint256 assets, address receiver) external nonReentrant returns (uint256 shares) {
        return _depositAssets(assets, receiver, 0);
    }

    /// @notice ERC-4626 exact-share mint; reverts if NAV after investing is insufficient.
    function mint(uint256 shares, address receiver) external nonReentrant returns (uint256 assets) {
        require(shares != 0, "Zero shares");
        assets = previewMint(shares);
        require(assets != 0, "Zero assets");
        _depositAssets(assets, receiver, shares);
    }

    /// @dev Exactly the v61 deposit economic path; the new ERC-4626 caller may
    ///      choose a shares receiver or ask to mint exactly the quoted shares.
    function _depositAssets(uint256 _amount, address receiver, uint256 exactShares) private returns (uint256 shares) {
        require(_amount != 0, "Zero deposit");
        require(receiver != address(0), "Invalid receiver");
        uint256 grossAssets = _amount;
        uint256 wantBefore = underlying.balanceOf(address(this));
        uint256 _pool = wantBefore + strategy.balanceOf();
        underlying.safeTransferFrom(msg.sender, address(this), _amount);
        _amount = underlying.balanceOf(address(this)) - wantBefore;
        uint256 fee = _amount * depositFeeBps / FEE_DENOMINATOR;
        if (fee != 0) {
            underlying.safeTransfer(adminFeeReceiver, fee);
            _amount = underlying.balanceOf(address(this)) - wantBefore;
        }
        // Mint for the actual change in NAV after investment (LP slippage),
        // never for the gross input. Prevents overminting at existing holders' expense.
        _earn();
        uint256 afterPool = balance();
        require(afterPool > _pool, "No net assets added");
        _amount = afterPool - _pool;
        uint256 affordableShares = totalSupply() == 0 ? _amount : (_amount * totalSupply()) / _pool;
        require(affordableShares != 0, "Zero shares");
        shares = exactShares == 0 ? affordableShares : exactShares;
        require(shares <= affordableShares, "Mint execution shortfall");
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, grossAssets, shares);
        // Best-effort observation only after all deposit accounting; never required for minting.
        _tryUpdateAPY();
    }

    function earn() public {
        _earn();
        _tryUpdateAPY();
    }

    function _earn() private {
        uint256 _bal = available();
        if (_bal != 0) {
            want().safeTransfer(address(strategy), _bal);
            strategy.deposit();
        }
    }

    function withdrawAll() external {
        withdraw(balanceOf(msg.sender));
    }

    /// @notice Emergency share redemption bypasses only the Convex Curve output guard.
    function emergencyWithdraw(uint256 shares, uint256 minAssetsOut) external nonReentrant {
        _withdrawShares(shares, msg.sender, msg.sender, true, minAssetsOut, 0);
    }

    /// @notice Legacy Beefy share withdrawal, preserving its original selector.
    function withdraw(uint256 shares) public nonReentrant {
        _withdrawShares(shares, msg.sender, msg.sender, false, 0, 0);
    }

    /// @notice ERC-4626 exact-net-asset withdrawal, burning the required shares.
    function withdraw(uint256 assets, address receiver, address owner)
        external nonReentrant returns (uint256 shares)
    {
        require(assets != 0, "Zero assets");
        shares = previewWithdraw(assets);
        _withdrawShares(shares, receiver, owner, false, 0, assets);
    }

    /// @notice ERC-4626 exact-share redemption, transferring net assets to receiver.
    function redeem(uint256 shares, address receiver, address owner)
        external nonReentrant returns (uint256 assets)
    {
        return _withdrawShares(shares, receiver, owner, false, 0, 0);
    }

    /// @dev The same v61 gross-assets calculation, strategy settlement, fee split,
    ///      retained-profit lock, and APY ordering for legacy and ERC-4626 callers.
    function _withdrawShares(
        uint256 _shares, address receiver, address owner, bool emergency,
        uint256 minAssetsOut, uint256 exactAssets
    ) private returns (uint256 assetsOut) {
        require(_shares > 0, "Zero shares");
        require(receiver != address(0), "Invalid receiver");
        require(_shares <= balanceOf(owner), "Insufficient shares");
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, _shares);
        uint256 r = (balance() * _shares) / totalSupply();
        _burn(owner, _shares);

        uint256 b = want().balanceOf(address(this));
        if (b < r) {
            uint256 _withdraw = r - b;
            if (emergency) {
                IEmergencyDualFXNMasterV54(address(strategy)).emergencyWithdraw(_withdraw);
            } else {
                strategy.withdraw(_withdraw);
            }
            uint256 _after = want().balanceOf(address(this));
            uint256 _diff = _after - b;
            require(_diff >= _withdraw, "Strategy withdrawal shortfall");
        }

        // Retain the original 30/70 fee split; lock retained profit in the existing strategy unlock.
        uint256 fee = r * withdrawalFeeBps / FEE_DENOMINATOR;
        uint256 adminPayment = totalSupply() == 0 ? fee : fee * ADMIN_FEE_SHARE_BPS / FEE_DENOMINATOR;
        uint256 retainedForShares = fee - adminPayment;
        if (adminPayment != 0) want().safeTransfer(adminFeeReceiver, adminPayment);
        uint256 netAssets = r - fee;
        // An ERC-4626 withdraw() promises a specified number of net assets;
        // existing Beefy withdraw()/redeem() pay the original full net amount.
        assetsOut = exactAssets == 0 ? netAssets : exactAssets;
        if (exactAssets != 0) {
            require(netAssets >= exactAssets, "Insufficient net assets");
            // Do not strand a final holder's unclaimed assets in a zero-supply vault.
            require(totalSupply() != 0 || exactAssets == netAssets, "Final exit must redeem all");
        }
        if (emergency) require(netAssets >= minAssetsOut, "EMERGENCY_MIN_ASSETS_OUT");
        want().safeTransfer(receiver, assetsOut);
        if (retainedForShares != 0) {
            want().safeTransfer(address(strategy), retainedForShares);
            strategy.lockVaultProfit(retainedForShares);
        }
        emit WithdrawalFeeCharged(owner, r, retainedForShares, adminPayment);
        emit Withdraw(msg.sender, receiver, owner, assetsOut, _shares);
        if (emergency) emit EmergencyWithdrawal(owner, _shares, r, netAssets);
        _tryUpdateAPY(); // optional, after all withdrawal accounting and transfers
    }

    function proposeAdminFeeReceiver(address _newReceiver) external {
        require(msg.sender == adminFeeReceiver, "Fee receiver only");
        require(_newReceiver != address(0) && _newReceiver != adminFeeReceiver, "Invalid new receiver");
        pendingAdminFeeReceiver = _newReceiver;
        adminFeeReceiverChangeReadyAt = block.timestamp + RECEIVER_CHANGE_DELAY;
        emit AdminFeeReceiverProposed(msg.sender, _newReceiver, adminFeeReceiverChangeReadyAt);
    }

    function executeAdminFeeReceiverChange() external {
        require(msg.sender == adminFeeReceiver, "Fee receiver only");
        require(pendingAdminFeeReceiver != address(0), "No proposal");
        require(block.timestamp >= adminFeeReceiverChangeReadyAt, "Seven day delay");
        address previous = adminFeeReceiver;
        adminFeeReceiver = pendingAdminFeeReceiver;
        pendingAdminFeeReceiver = address(0);
        adminFeeReceiverChangeReadyAt = 0;
        emit AdminFeeReceiverChanged(previous, adminFeeReceiver);
    }
}
