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
 * Documentation: https://docs.curveyield.com
 * dApp: https://curveyield.online
 * GitHub: https://github.com/curveyield
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
// v2: Send 100% of the fee from the final share withdrawal to adminFeeReceiver.
import "@openzeppelin-4/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin-4/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin-4/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin-4/contracts/access/Ownable.sol";
import "./interfaces/IStrategyBoostHubV1.sol";

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

    // Daily history retains a meaningful 15-day baseline even with frequent activity.
    // Five recent observations provide the minimum short-window fallback, 4h apart.
    struct APRSample { uint40 timestamp; uint216 pps; }
    APRSample[16] private aprHistory;
    APRSample[5] private recentAPRHistory;
    uint40 public lastAPRCheckpoint;
    uint40 public lastDailyAPRCheckpoint;
    uint8 private aprNext;
    uint8 private aprCount;
    uint8 private recentAPRNext;
    uint8 private recentAPRCount;
    uint256 public lastValidAPR;
    bool private hasValidAPR;
    uint256 public constant APR_WINDOW = 15 days;
    uint256 public constant APR_MAX_WINDOW = 30 days;
    uint256 private constant APR_SNAPSHOT_INTERVAL = 4 hours;
    uint256 private constant APR_DAILY_INTERVAL = 1 days;
    uint256 private constant APR_HOOK_GAS = 200_000;
    uint256 private constant APR_PPS_READ_GAS = 180_000;

    event DepositFeeChanged(uint256 oldFeeBps, uint256 newFeeBps);
    event AdminFeeReceiverProposed(address indexed previousReceiver, address indexed proposedReceiver, uint256 readyAt);
    event AdminFeeReceiverChanged(address indexed previousReceiver, address indexed newReceiver);
    event WithdrawalFeeCharged(address indexed account, uint256 grossUnderlying, uint256 shareholderRetention, uint256 administratorPayment);

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


    /// @notice Permissionless PPS observation, no more than once every 4 hours.
    /// @dev Keeps daily history for the 15-day target and the last five 4-hour readings.
    function checkpointAPR() external {
        _checkpointAPR();
    }

    // APR observations are optional; insufficient gas or a failing PPS source may
    // never become a reason to revert a deposit or withdrawal.
    function _tryCheckpointAPR() private {
        if (block.timestamp < uint256(lastAPRCheckpoint) + APR_SNAPSHOT_INTERVAL) return;
        if (gasleft() > APR_HOOK_GAS + 300_000) {
            try this.checkpointAPR{gas: APR_HOOK_GAS}() {} catch {}
        }
    }

    function _checkpointAPR() private {
        if (totalSupply() == 0 || block.timestamp < uint256(lastAPRCheckpoint) + APR_SNAPSHOT_INTERVAL) return;
        uint256 pps = getPricePerFullShare();
        if (pps == 0 || pps > type(uint216).max) return;

        APRSample memory sample = APRSample(uint40(block.timestamp), uint216(pps));
        recentAPRHistory[recentAPRNext] = sample;
        recentAPRNext = (recentAPRNext + 1) % 5;
        if (recentAPRCount < 5) ++recentAPRCount;
        lastAPRCheckpoint = uint40(block.timestamp);

        // Keep long-window samples separately: the 4h ring must not overwrite
        // the 15-day reference after only a few days of active deposits.
        if (block.timestamp >= uint256(lastDailyAPRCheckpoint) + APR_DAILY_INTERVAL) {
            aprHistory[aprNext] = sample;
            aprNext = (aprNext + 1) % 16;
            if (aprCount < 16) ++aprCount;
            lastDailyAPRCheckpoint = uint40(block.timestamp);
        }

        // Persist the last computable APR. No keeper/checkpoint gap can make
        // Morpho's subsequent view suddenly return zero for missing history.
        (bool ready, uint256 apr) = _aprFromPps(pps);
        if (ready && (!hasValidAPR || apr != lastValidAPR)) {
            lastValidAPR = apr;
            hasValidAPR = true;
        }
    }

    /// @notice Historical PPS appreciation, annualized to 1e18 precision.
    /// @dev Targets 15 days, never calculates from observations older than 30 days.
    ///      If observations are missing, preserves the last computable APR.
    function getAPR() external view returns (uint256) {
        (, uint256 apr) = _apr15d();
        return apr;
    }

    function aprReady() external view returns (bool) {
        (bool ready,) = _apr15d();
        return ready;
    }

    /// @notice Collateral yield rate per second, WAD precision.
    function rate() external view returns (uint256) {
        (, uint256 apr) = _apr15d();
        return apr / 365 days;
    }

    function _apr15d() private view returns (bool, uint256) {
        // The lending market must not revert if the strategy temporarily fails
        // to provide a PPS. Checkpoint history remains usable during that time.
        try this.getPricePerFullShare{gas: APR_PPS_READ_GAS}() returns (uint256 pps) {
            if (pps != 0) return _aprFromPps(pps);
        } catch {}
        return (hasValidAPR, lastValidAPR);
    }

    function _aprFromPps(uint256 ppsNow) private view returns (bool, uint256) {
        uint256 target = block.timestamp > APR_WINDOW ? block.timestamp - APR_WINDOW : 0;
        uint256 closest = type(uint256).max;
        uint256 baselineTime;
        uint256 baselinePps;

        // Prefer a daily checkpoint near the 15-day target (up to 30 days old).
        for (uint256 i; i < aprCount; ++i) {
            APRSample memory sample = aprHistory[i];
            uint256 t = uint256(sample.timestamp);
            if (t == 0 || t >= block.timestamp || sample.pps == 0) continue;
            if (block.timestamp - t > APR_MAX_WINDOW) continue;
            uint256 distance = t > target ? t - target : target - t;
            if (distance < closest) {
                closest = distance;
                baselineTime = t;
                baselinePps = uint256(sample.pps);
            }
        }

        // When there is no usable long-window observation, use the oldest of
        // the last five readings, providing a minimum five-observation fallback.
        // During first initialization, use available readings until five exist.
        if (baselinePps == 0) {
            uint256 validRecent;
            for (uint256 i; i < recentAPRCount; ++i) {
                APRSample memory sample = recentAPRHistory[i];
                uint256 t = uint256(sample.timestamp);
                if (t == 0 || t >= block.timestamp || sample.pps == 0) continue;
                if (block.timestamp - t > APR_MAX_WINDOW) continue;
                ++validRecent;
                if (baselineTime == 0 || t < baselineTime) {
                    baselineTime = t;
                    baselinePps = uint256(sample.pps);
                }
            }
            // An established market must not switch to a noisy one- or
            // two-observation rate after a long checkpoint outage.
            if (hasValidAPR && validRecent < 5) return (true, lastValidAPR);
        }
        if (baselinePps == 0) return (hasValidAPR, lastValidAPR);
        if (ppsNow <= baselinePps) return (true, 0);
        uint256 delta = ppsNow - baselinePps;
        if (delta > type(uint256).max / 1e18) return (hasValidAPR, lastValidAPR);
        uint256 returnWad = delta * 1e18 / baselinePps;
        if (returnWad > type(uint256).max / (365 days)) return (hasValidAPR, lastValidAPR);
        return (true, returnWad * (365 days) / (block.timestamp - baselineTime));
    }

    function depositAll() external {
        deposit(want().balanceOf(msg.sender));
    }

    function deposit(uint256 _amount) public nonReentrant {
        require(_amount != 0, "Zero deposit");
        uint256 wantBefore = underlying.balanceOf(address(this));
        uint256 _pool = wantBefore + strategy.balanceOf();
        underlying.safeTransferFrom(msg.sender, address(this), _amount);
        _amount = underlying.balanceOf(address(this)) - wantBefore;
        uint256 fee = _amount * depositFeeBps / FEE_DENOMINATOR;
        if (fee != 0) {
            underlying.safeTransfer(adminFeeReceiver, fee);
            _amount = underlying.balanceOf(address(this)) - wantBefore;
        }
        // Fixed strategy stakes exact principal; only the net receipt buys shares.
        earn();
        require(_amount != 0, "Zero received");
        uint256 shares = totalSupply() == 0 ? _amount : (_amount * totalSupply()) / _pool;
        require(shares != 0, "Zero shares");
        _mint(msg.sender, shares);
        // Best-effort observation only after all deposit accounting; never required for minting.
        _tryCheckpointAPR();
    }

    function earn() public {
        uint256 _bal = available();
        if (_bal != 0) {
            want().safeTransfer(address(strategy), _bal);
            strategy.deposit();
        }
    }

    function withdrawAll() external {
        withdraw(balanceOf(msg.sender));
    }

    function withdraw(uint256 _shares) public nonReentrant {
        require(_shares > 0, "Zero shares");
        uint256 r = (balance() * _shares) / totalSupply();
        _burn(msg.sender, _shares);

        uint256 b = want().balanceOf(address(this));
        if (b < r) {
            uint256 _withdraw = r - b;
            strategy.withdraw(_withdraw);
            uint256 _after = want().balanceOf(address(this));
            uint256 _diff = _after - b;
            if (_diff < _withdraw) r = b + _diff;
        }

        // Retain the original 30/70 fee split; lock retained profit in the existing strategy unlock.
        uint256 fee = r * withdrawalFeeBps / FEE_DENOMINATOR;
        uint256 adminPayment = fee * ADMIN_FEE_SHARE_BPS / FEE_DENOMINATOR;
        uint256 retainedForShares = fee - adminPayment;
        if (adminPayment != 0) want().safeTransfer(adminFeeReceiver, adminPayment);
        want().safeTransfer(msg.sender, r - fee);
        if (retainedForShares != 0) {
            want().safeTransfer(address(strategy), retainedForShares);
            strategy.lockVaultProfit(retainedForShares);
        }
        emit WithdrawalFeeCharged(msg.sender, r, retainedForShares, adminPayment);
        _tryCheckpointAPR(); // optional, after all withdrawal accounting and transfers
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
