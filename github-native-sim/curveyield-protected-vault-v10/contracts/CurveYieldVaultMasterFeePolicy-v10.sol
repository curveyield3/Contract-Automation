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
pragma solidity 0.8.28;

/// @title CurveYield Vault Master Fee Policy v10
/// @notice Single read-only fee policy source for immutable, independent per-vault controllers.
/// @dev Can set rates only through a 90-day notice; has NO vault/asset/curator operations.
contract CurveYieldVaultMasterFeePolicy {
    uint256 public constant FEE_CHANGE_DELAY = 90 days;
    uint256 public constant MAX_FLAT_PERFORMANCE_FEE_WAD = 2e16; // 2.00% of yield.
    uint256 public constant MAX_PERFORMANCE_SURCHARGE_BPS = 1000; // 10% of operator fees.
    uint256 public constant MAX_FLAT_MANAGEMENT_ANNUAL_WAD = 25e14; // 0.25% TVL annual.
    uint256 public constant MAX_MANAGEMENT_SURCHARGE_BPS = 1000; // 10% of operator fees.
    uint256 public constant DEFAULT_FLAT_PERFORMANCE_FEE_WAD = 2e15; // 0.20% yield.
    uint256 public constant DEFAULT_PERFORMANCE_SURCHARGE_BPS = 200; // 2% of operator.
    uint256 public constant DEFAULT_FLAT_MANAGEMENT_ANNUAL_WAD = 5e14; // 0.05% TVL.
    uint256 public constant DEFAULT_MANAGEMENT_SURCHARGE_BPS = 200; // 2% of operator.

    address public governance;
    address public pendingGovernance;
    uint256 public flatPerformanceFeeWad = DEFAULT_FLAT_PERFORMANCE_FEE_WAD;
    uint256 public performanceSurchargeBps = DEFAULT_PERFORMANCE_SURCHARGE_BPS;
    uint256 public flatManagementAnnualWad = DEFAULT_FLAT_MANAGEMENT_ANNUAL_WAD;
    uint256 public managementSurchargeBps = DEFAULT_MANAGEMENT_SURCHARGE_BPS;
    uint256 public policyVersion = 1;

    struct PendingRates {
        uint256 flatPerformanceFeeWad;
        uint256 performanceSurchargeBps;
        uint256 flatManagementAnnualWad;
        uint256 managementSurchargeBps;
        uint256 executableAt;
    }
    PendingRates public pendingRates;
    event RatesScheduled(uint256 flatPerformanceFeeWad, uint256 performanceSurchargeBps,
        uint256 flatManagementAnnualWad, uint256 managementSurchargeBps, uint256 executableAt);
    event RatesChanged(uint256 indexed version, uint256 flatPerformanceFeeWad,
        uint256 performanceSurchargeBps, uint256 flatManagementAnnualWad,
        uint256 managementSurchargeBps);
    event RatesCancelled();
    event GovernanceProposed(address indexed nextGovernance);
    event GovernanceTransferred(address indexed oldGovernance, address indexed newGovernance);
    error Unauthorized();
    error InvalidAddress();
    error InvalidRate();
    error AlreadyScheduled();
    error NotReady();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert Unauthorized();
        _;
    }

    constructor(address _governance) {
        if (block.chainid != 252) revert InvalidAddress();
        if (_governance == address(0)) revert InvalidAddress();
        governance = _governance;
    }

    function currentRates() external view returns (
        uint256, uint256, uint256, uint256, uint256
    ) {
        return (flatPerformanceFeeWad, performanceSurchargeBps,
            flatManagementAnnualWad, managementSurchargeBps, policyVersion);
    }

    function scheduleRates(uint256 flatPerfWad, uint256 perfSurchargeBps,
        uint256 flatMgmtAnnualWad, uint256 mgmtSurchargeBps)
        external onlyGovernance
    {
        if (pendingRates.executableAt != 0) revert AlreadyScheduled();
        if (flatPerfWad > MAX_FLAT_PERFORMANCE_FEE_WAD ||
            perfSurchargeBps > MAX_PERFORMANCE_SURCHARGE_BPS ||
            flatMgmtAnnualWad > MAX_FLAT_MANAGEMENT_ANNUAL_WAD ||
            mgmtSurchargeBps > MAX_MANAGEMENT_SURCHARGE_BPS) revert InvalidRate();
        uint256 at = block.timestamp + FEE_CHANGE_DELAY;
        pendingRates = PendingRates(flatPerfWad, perfSurchargeBps,
            flatMgmtAnnualWad, mgmtSurchargeBps, at);
        emit RatesScheduled(flatPerfWad, perfSurchargeBps,
            flatMgmtAnnualWad, mgmtSurchargeBps, at);
    }

    function cancelRates() external onlyGovernance {
        if (pendingRates.executableAt == 0) revert NotReady();
        delete pendingRates;
        emit RatesCancelled();
    }

    /// @notice Permissionless acceptance after 90 days. Changes affect only future accrual
    ///         once each vault's permissionless synchronization applies the settings.
    function executeRates() external {
        PendingRates memory p = pendingRates;
        if (p.executableAt == 0 || block.timestamp < p.executableAt) revert NotReady();
        flatPerformanceFeeWad = p.flatPerformanceFeeWad;
        performanceSurchargeBps = p.performanceSurchargeBps;
        flatManagementAnnualWad = p.flatManagementAnnualWad;
        managementSurchargeBps = p.managementSurchargeBps;
        policyVersion++;
        delete pendingRates;
        emit RatesChanged(policyVersion, p.flatPerformanceFeeWad,
            p.performanceSurchargeBps, p.flatManagementAnnualWad, p.managementSurchargeBps);
    }

    function proposeGovernance(address nextGovernance) external onlyGovernance {
        if (nextGovernance == address(0)) revert InvalidAddress();
        pendingGovernance = nextGovernance;
        emit GovernanceProposed(nextGovernance);
    }

    function acceptGovernance() external {
        if (msg.sender != pendingGovernance) revert Unauthorized();
        address old = governance;
        governance = msg.sender;
        pendingGovernance = address(0);
        emit GovernanceTransferred(old, msg.sender);
    }
}
