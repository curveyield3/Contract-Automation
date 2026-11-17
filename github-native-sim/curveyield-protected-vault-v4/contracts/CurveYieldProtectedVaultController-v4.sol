// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title CurveYield Protected Morpho Vault V2 Controller v4
/// @notice Standalone, immutable per-vault controller with CurveYield fees capped on-chain.
/// @dev Operator administers strategies within an allowlist. CurveYield governance can
///      ONLY schedule fee-rate changes (90-day delay), rotate protocol recipient and
///      rotate its fee-only governance key. Governance cannot move vault assets, replace
///      the controller, change the curator, or transfer Morpho ownership.
interface IVaultV2FactoryCY {
    function createVaultV2(address owner, address asset, bytes32 salt) external returns (address);
    function isVaultV2(address vault) external view returns (bool);
}

interface IVaultV2CY {
    function owner() external view returns (address);
    function curator() external view returns (address);
    function asset() external view returns (address);
    function performanceFee() external view returns (uint96);
    function performanceFeeRecipient() external view returns (address);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function timelock(bytes4 selector) external view returns (uint256);
    function abdicated(bytes4 selector) external view returns (bool);

    function setOwner(address newOwner) external;
    function setCurator(address newCurator) external;
    function setIsSentinel(address account, bool enabled) external;
    function setName(string calldata newName) external;
    function setSymbol(string calldata newSymbol) external;
    function submit(bytes calldata data) external;
    function revoke(bytes calldata data) external;
    function abdicate(bytes4 selector) external;
    function setPerformanceFee(uint256 newPerformanceFee) external;
    function setPerformanceFeeRecipient(address recipient) external;
    function accrueInterest() external;
    function transfer(address recipient, uint256 shares) external returns (bool);
}

/// @notice Owns/curates one Morpho V2 vault, receives fee shares and distributes them.
/// @dev No splitter, no proxy, no general-purpose governance call and no vault migration.
contract CurveYieldProtectedVaultController {
    uint256 public constant DEFAULT_FLAT_FEE_WAD = 2e15; // 0.20% of yield.
    uint256 public constant MAX_FLAT_FEE_WAD = 5e15; // 0.50% of yield.
    uint256 public constant DEFAULT_OPERATOR_SURCHARGE_BPS = 200; // 2% of operator performance fee.
    uint256 public constant MAX_OPERATOR_SURCHARGE_BPS = 500; // 5% of operator performance fee.
    uint256 public constant BPS = 10_000;
    uint256 public constant FEE_CHANGE_DELAY = 90 days;
    uint256 public constant MORPHO_MAX_PERFORMANCE_FEE_WAD = 5e17;

    address public constant MORPHO_VAULT_V2_FACTORY_FRAXTAL =
        0x711bCE12269a3a496eFaABB8B9AD5A4485E08A24;
    address public governance;
    address public operator;
    address public pendingOperator;
    address public protocolRecipient;
    address public operatorRecipient;
    IVaultV2CY public vault;
    uint256 public operatorFeeWad;
    uint256 public flatProtocolFeeWad = DEFAULT_FLAT_FEE_WAD;
    uint256 public operatorSurchargeBps = DEFAULT_OPERATOR_SURCHARGE_BPS;
    uint256 public feeRemainder;
    bool public initialized;
    uint256 private entered;

    struct PendingFeeRates {
        uint256 flatFeeWad;
        uint256 surchargeBps;
        uint256 executableAt;
    }
    PendingFeeRates public pendingFeeRates;

    event ProtectedVaultCreated(address indexed vault, address indexed operator,
        address indexed protocolRecipient, address asset, uint256 operatorFeeWad);
    event Distributed(uint256 protocolShares, uint256 operatorShares);
    event OperatorFeeUpdated(uint256 oldOperatorFeeWad, uint256 newOperatorFeeWad, uint256 newTotalFeeWad);
    event FeeRatesScheduled(uint256 flatFeeWad, uint256 surchargeBps, uint256 executableAt);
    event FeeRatesCancelled();
    event FeeRatesUpdated(uint256 oldFlatFeeWad, uint256 oldSurchargeBps,
        uint256 newFlatFeeWad, uint256 newSurchargeBps);
    event GovernanceTransferred(address indexed previousGovernance, address indexed newGovernance);
    event ProtocolFeeRecipientChanged(address indexed previousRecipient, address indexed newRecipient);
    event OperatorFeeRecipientChanged(address indexed previousRecipient, address indexed newRecipient);
    event OperatorProposed(address indexed newOperator);
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event CuratorActionSubmitted(bytes data);
    event CuratorActionExecuted(bytes data);
    event CuratorActionRevoked(bytes data);

    error Unauthorized();
    error InvalidAddress();
    error InvalidFee();
    error InvalidOperation();
    error NotInitialized();
    error AlreadyInitialized();
    error UnsafeVault();
    error Reentrancy();
    error TransferFailed();
    error VaultOperationFailed(bytes returnData);
    error WrongChain();
    error DeploymentFailed();
    error FeeChangePending();
    error FeeChangeNotReady();

    modifier onlyOperator() {
        if (msg.sender != operator) revert Unauthorized();
        _;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert Unauthorized();
        _;
    }

    modifier ready() {
        if (!initialized) revert NotInitialized();
        _;
    }

    modifier nonReentrant() {
        if (entered != 0) revert Reentrancy();
        entered = 1;
        _;
        entered = 0;
    }

    /// @param _operator Vault operator wallet/Safe.
    /// @param _protocolTreasury CurveYield's initial fee-only governance AND fee recipient.
    constructor(address _operator, address _protocolTreasury) {
        if (block.chainid != 252) revert WrongChain();
        if (_operator == address(0) || _protocolTreasury == address(0)) revert InvalidAddress();
        operator = _operator;
        governance = _protocolTreasury;
        protocolRecipient = _protocolTreasury;
    }

    function _totalFeeFor(uint256 opFee, uint256 flatRate, uint256 surchargeBps)
        internal pure returns (uint256)
    {
        if (flatRate > MAX_FLAT_FEE_WAD || surchargeBps > MAX_OPERATOR_SURCHARGE_BPS ||
            opFee > MORPHO_MAX_PERFORMANCE_FEE_WAD) revert InvalidFee();
        uint256 total = flatRate + opFee + (opFee * surchargeBps) / BPS;
        if (total > MORPHO_MAX_PERFORMANCE_FEE_WAD) revert InvalidFee();
        return total;
    }

    function totalFeeFor(uint256 opFee) public view returns (uint256) {
        return _totalFeeFor(opFee, flatProtocolFeeWad, operatorSurchargeBps);
    }

    function protocolFeeWad() public view returns (uint256) {
        return flatProtocolFeeWad + (operatorFeeWad * operatorSurchargeBps) / BPS;
    }

    function totalPerformanceFeeWad() external view returns (uint256) {
        return totalFeeFor(operatorFeeWad);
    }

    /// @notice Create the only vault that this controller can manage.
    /// @dev Creates the official Morpho V2 vault and configures this controller as both
    ///      owner+curator and performance fee recipient, atomically.
    function createVault(
        address asset,
        address _operatorRecipient,
        uint256 initialOperatorFeeWad,
        string calldata name,
        string calldata symbol,
        bytes32 salt
    ) external onlyOperator nonReentrant returns (address vaultAddress) {
        if (initialized) revert AlreadyInitialized();
        if (asset == address(0) || _operatorRecipient == address(0)) revert InvalidAddress();
        if (bytes(name).length == 0 || bytes(symbol).length == 0) revert InvalidOperation();

        uint256 total = totalFeeFor(initialOperatorFeeWad);
        IVaultV2FactoryCY morphoFactory = IVaultV2FactoryCY(MORPHO_VAULT_V2_FACTORY_FRAXTAL);
        vaultAddress = morphoFactory.createVaultV2(address(this), asset, salt);
        if (!morphoFactory.isVaultV2(vaultAddress)) revert DeploymentFailed();
        IVaultV2CY v = IVaultV2CY(vaultAddress);
        if (v.owner() != address(this) || v.asset() != asset || v.curator() != address(0) ||
            v.totalSupply() != 0 || v.performanceFee() != 0 ||
            v.performanceFeeRecipient() != address(0) ||
            v.timelock(IVaultV2CY.setPerformanceFee.selector) != 0 ||
            v.timelock(IVaultV2CY.setPerformanceFeeRecipient.selector) != 0 ||
            v.abdicated(IVaultV2CY.setPerformanceFee.selector) ||
            v.abdicated(IVaultV2CY.setPerformanceFeeRecipient.selector)) revert UnsafeVault();

        vault = v;
        operatorFeeWad = initialOperatorFeeWad;
        operatorRecipient = _operatorRecipient;
        v.setName(name);
        v.setSymbol(symbol);
        v.setCurator(address(this));

        bytes memory recipientData = abi.encodeCall(
            IVaultV2CY.setPerformanceFeeRecipient, (address(this))
        );
        v.submit(recipientData);
        v.setPerformanceFeeRecipient(address(this));
        bytes memory feeData = abi.encodeCall(IVaultV2CY.setPerformanceFee, (total));
        v.submit(feeData);
        v.setPerformanceFee(total);

        // Ownership/curatorship remain at this immutable controller.
        // Do not abdicate fee-setting: governance and operator need bounded fee adjustments.
        if (v.performanceFeeRecipient() != address(this) ||
            v.performanceFee() != total || v.curator() != address(this) ||
            v.owner() != address(this)) revert UnsafeVault();

        initialized = true;
        emit ProtectedVaultCreated(vaultAddress, operator, protocolRecipient, asset, initialOperatorFeeWad);
    }

    /// @notice Distribute accrued Morpho fee shares, under the CURRENT recorded fee split.
    /// @dev External transfers of vault shares to this contract are treated as fee shares.
    function distribute() external ready nonReentrant returns (uint256 protocolShares, uint256 operatorShares) {
        return _distribute();
    }

    function _distribute() internal returns (uint256 protocolShares, uint256 operatorShares) {
        vault.accrueInterest();
        uint256 shares = vault.balanceOf(address(this));
        if (shares == 0) return (0, 0);

        uint256 total = totalFeeFor(operatorFeeWad);
        uint256 protocolPortion = protocolFeeWad();
        if (total == 0) {
            // No fees are enabled. Any externally transferred shares belong to the operator.
            operatorShares = shares;
        } else {
            // Quotient/remainder avoids overflow on large share balances.
            uint256 numerator = (shares % total) * protocolPortion + feeRemainder;
            protocolShares = (shares / total) * protocolPortion + numerator / total;
            feeRemainder = numerator % total;
            operatorShares = shares - protocolShares;
        }

        if (protocolShares != 0 && !vault.transfer(protocolRecipient, protocolShares)) revert TransferFailed();
        if (operatorShares != 0 && !vault.transfer(operatorRecipient, operatorShares)) revert TransferFailed();
        emit Distributed(protocolShares, operatorShares);
    }

    function _setVaultPerformanceFee(uint256 newTotal) internal {
        if (vault.timelock(IVaultV2CY.setPerformanceFee.selector) != 0 ||
            vault.abdicated(IVaultV2CY.setPerformanceFee.selector)) revert UnsafeVault();
        bytes memory action = abi.encodeCall(IVaultV2CY.setPerformanceFee, (newTotal));
        vault.submit(action);
        vault.setPerformanceFee(newTotal);
        if (vault.performanceFee() != newTotal) revert UnsafeVault();
    }

    function _rebaseFeeRemainder(uint256 oldTotal, uint256 newTotal) internal {
        feeRemainder = oldTotal == 0 ? 0 : (feeRemainder * newTotal) / oldTotal;
    }

    /// @notice Governance-only proposal: both rate components are subject to a full
    ///         90-day delay, irrespective of whether rates increase or decrease.
    function scheduleProtocolFeeRates(uint256 newFlatFeeWad, uint256 newSurchargeBps)
        external onlyGovernance ready
    {
        if (pendingFeeRates.executableAt != 0) revert FeeChangePending();
        _totalFeeFor(0, newFlatFeeWad, newSurchargeBps); // Validate both immutable caps.
        pendingFeeRates = PendingFeeRates({
            flatFeeWad: newFlatFeeWad,
            surchargeBps: newSurchargeBps,
            executableAt: block.timestamp + FEE_CHANGE_DELAY
        });
        emit FeeRatesScheduled(newFlatFeeWad, newSurchargeBps, pendingFeeRates.executableAt);
    }

    /// @notice Governance may cancel pending or matured fee changes.
    function cancelProtocolFeeRates() external onlyGovernance {
        if (pendingFeeRates.executableAt == 0) revert InvalidOperation();
        delete pendingFeeRates;
        emit FeeRatesCancelled();
    }

    /// @notice Permissionless execution of the scheduled fee change after >=90 days.
    /// @dev Accrue/distribute under prior rates, then update Morpho rate and stored split
    ///      atomically. A failed execution leaves the proposal available for retry.
    function executeProtocolFeeRates() external ready nonReentrant {
        PendingFeeRates memory next = pendingFeeRates;
        if (next.executableAt == 0 || block.timestamp < next.executableAt) revert FeeChangeNotReady();
        uint256 newTotal = _totalFeeFor(operatorFeeWad, next.flatFeeWad, next.surchargeBps);
        uint256 oldTotal = totalFeeFor(operatorFeeWad);
        _distribute();
        _setVaultPerformanceFee(newTotal);
        _rebaseFeeRemainder(oldTotal, newTotal);
        uint256 oldFlat = flatProtocolFeeWad;
        uint256 oldSurcharge = operatorSurchargeBps;
        flatProtocolFeeWad = next.flatFeeWad;
        operatorSurchargeBps = next.surchargeBps;
        delete pendingFeeRates;
        emit FeeRatesUpdated(oldFlat, oldSurcharge, next.flatFeeWad, next.surchargeBps);
    }

    /// @notice Operator controls its own portion of the vault performance fee.
    function setOperatorPerformanceFee(uint256 newOperatorFeeWad)
        external onlyOperator ready nonReentrant
    {
        uint256 total = totalFeeFor(newOperatorFeeWad);
        uint256 old = operatorFeeWad;
        if (old == newOperatorFeeWad) return;
        uint256 oldTotal = totalFeeFor(old);
        _distribute();
        _setVaultPerformanceFee(total);
        _rebaseFeeRemainder(oldTotal, total);
        operatorFeeWad = newOperatorFeeWad;
        emit OperatorFeeUpdated(old, newOperatorFeeWad, total);
    }

    /// @notice Treasury rotation for fee collection only: never gains vault powers.
    function setProtocolFeeRecipient(address nextRecipient)
        external onlyGovernance ready nonReentrant
    {
        if (nextRecipient == address(0)) revert InvalidAddress();
        _distribute();
        address previous = protocolRecipient;
        protocolRecipient = nextRecipient;
        emit ProtocolFeeRecipientChanged(previous, nextRecipient);
    }

    /// @notice Change the CurveYield fee-only governance key without upgrading code.
    function transferGovernance(address nextGovernance) external onlyGovernance {
        if (nextGovernance == address(0)) revert InvalidAddress();
        address previous = governance;
        governance = nextGovernance;
        emit GovernanceTransferred(previous, nextGovernance);
    }

    function setOperatorFeeRecipient(address nextRecipient)
        external onlyOperator ready nonReentrant
    {
        if (nextRecipient == address(0)) revert InvalidAddress();
        _distribute();
        address previous = operatorRecipient;
        operatorRecipient = nextRecipient;
        emit OperatorFeeRecipientChanged(previous, nextRecipient);
    }

    /// @notice Two-step rotation of OPERATOR access only. Morpho ownership and
    ///         curatorship remain permanently assigned to this controller.
    function proposeOperator(address nextOperator) external onlyOperator {
        if (nextOperator == address(0)) revert InvalidAddress();
        pendingOperator = nextOperator;
        emit OperatorProposed(nextOperator);
    }

    function acceptOperator() external {
        if (msg.sender != pendingOperator) revert Unauthorized();
        address old = operator;
        operator = msg.sender;
        pendingOperator = address(0);
        emit OperatorUpdated(old, msg.sender);
    }

    function setVaultName(string calldata newName) external onlyOperator ready { vault.setName(newName); }
    function setVaultSymbol(string calldata newSymbol) external onlyOperator ready { vault.setSymbol(newSymbol); }
    function setSentinel(address account, bool allowed) external onlyOperator ready {
        vault.setIsSentinel(account, allowed);
    }

    /// @notice Stage an explicitly allowlisted Morpho curator operation.
    /// @dev Morpho's own timelock remains authoritative. After it expires, any caller
    ///      can execute the action either on the vault or via executeCuratorAction().
    ///      No arbitrary gate changes, fee changes, curator replacements, multicalls,
    ///      or ownership transfers can be submitted through this controller.
    function submitCuratorAction(bytes calldata action) external onlyOperator ready {
        _validateCuratorAction(action);
        vault.submit(action);
        emit CuratorActionSubmitted(action);
    }

    function executeCuratorAction(bytes calldata action) external ready {
        _validateCuratorAction(action);
        _callVault(action);
        emit CuratorActionExecuted(action);
    }

    /// @notice Direct, risk-reducing emergency cap decreases permitted to the curator.
    function decreaseCap(bytes calldata action) external onlyOperator ready {
        if (action.length < 4) revert InvalidOperation();
        bytes4 selector = bytes4(action);
        if (selector != bytes4(keccak256("decreaseAbsoluteCap(bytes,uint256)")) &&
            selector != bytes4(keccak256("decreaseRelativeCap(bytes,uint256)"))) revert InvalidOperation();
        _callVault(action);
    }

    function revokeCuratorAction(bytes calldata action) external onlyOperator ready {
        vault.revoke(action);
        emit CuratorActionRevoked(action);
    }

    function _validateCuratorAction(bytes calldata action) internal pure {
        if (action.length < 4) revert InvalidOperation();
        bytes4 selector = bytes4(action);
        if (selector == bytes4(keccak256("setIsAllocator(address,bool)")) ||
            selector == bytes4(keccak256("setAdapterRegistry(address)")) ||
            selector == bytes4(keccak256("addAdapter(address)")) ||
            selector == bytes4(keccak256("removeAdapter(address)")) ||
            selector == bytes4(keccak256("increaseAbsoluteCap(bytes,uint256)")) ||
            selector == bytes4(keccak256("increaseRelativeCap(bytes,uint256)")) ||
            selector == bytes4(keccak256("setForceDeallocatePenalty(address,uint256)")) ||
            selector == bytes4(keccak256("setManagementFee(uint256)")) ||
            selector == bytes4(keccak256("setManagementFeeRecipient(address)"))) return;

        if (selector == bytes4(keccak256("increaseTimelock(bytes4,uint256)")) ||
            selector == bytes4(keccak256("decreaseTimelock(bytes4,uint256)"))) {
            (bytes4 target,) = abi.decode(action[4:], (bytes4, uint256));
            // Never allow time-lock changes for protocol-fee configuration or permanent
            // abdication (and never expose share/asset gates).
            if (target == IVaultV2CY.setPerformanceFee.selector ||
                target == IVaultV2CY.setPerformanceFeeRecipient.selector ||
                target == IVaultV2CY.abdicate.selector ||
                target == bytes4(keccak256("setReceiveSharesGate(address)")) ||
                target == bytes4(keccak256("setSendSharesGate(address)")) ||
                target == bytes4(keccak256("setReceiveAssetsGate(address)")) ||
                target == bytes4(keccak256("setSendAssetsGate(address)"))) revert InvalidOperation();
            return;
        }
        revert InvalidOperation();
    }

    function _callVault(bytes calldata data) internal {
        (bool ok, bytes memory result) = address(vault).call(data);
        if (!ok) revert VaultOperationFailed(result);
    }
}
