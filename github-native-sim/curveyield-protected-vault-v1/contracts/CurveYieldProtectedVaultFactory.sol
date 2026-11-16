// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title CurveYield Protected Morpho Vault V2 Deployment
/// @notice Fraxtal-only, atomic creation of a standard Morpho Vault V2 with non-bypassable
///         performance-fee settings and a vault-share fee splitter.
/// @dev New vaults ONLY. Never attach this controller to an existing vault with unknown
///      pending timelock operations. Morpho Vault V2 itself is not forked or altered.

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

interface ICurveYieldOperatorFee {
    function operatorFeeWad() external view returns (uint256);
}

/// @notice Receives ALL Morpho performance-fee shares and pays the contractually protected split.
/// @dev The operator cannot change the protocol recipient, the split formula, or the vault recipient.
contract CurveYieldProtectedFeeSplitter {
    uint256 public constant BASE_PROTOCOL_FEE_WAD = 2e15; // 0.2% of recognized positive vault yield.
    uint256 public constant OPERATOR_SURCHARGE_BPS = 200; // 2% of the operator performance fee.
    uint256 public constant BPS = 10_000;

    IVaultV2CY public immutable vault;
    address public immutable controller;
    address public operatorRecipient;
    address public protocolRecipient;
    address public pendingProtocolRecipient;

    // Sub-share dust carried across distributions to prevent rounding exploitation.
    // This is a fraction of a share expressed with the current total fee denominator.
    uint256 public feeRemainder;
    uint256 private entered;

    event Distributed(uint256 protocolShares, uint256 operatorShares);
    event OperatorRecipientUpdated(address indexed recipient);
    event ProtocolRecipientProposed(address indexed nextRecipient);
    event ProtocolRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);

    error Unauthorized();
    error InvalidAddress();
    error Reentrancy();
    error TransferFailed();

    modifier nonReentrant() {
        if (entered != 0) revert Reentrancy();
        entered = 1;
        _;
        entered = 0;
    }

    modifier onlyController() {
        if (msg.sender != controller) revert Unauthorized();
        _;
    }

    constructor(address _vault, address _controller, address _operatorRecipient, address _protocolRecipient) {
        if (_vault == address(0) || _controller == address(0) ||
            _operatorRecipient == address(0) || _protocolRecipient == address(0)) revert InvalidAddress();
        vault = IVaultV2CY(_vault);
        controller = _controller;
        operatorRecipient = _operatorRecipient;
        protocolRecipient = _protocolRecipient;
    }

    function protocolFeeWad() public view returns (uint256) {
        return BASE_PROTOCOL_FEE_WAD +
            (ICurveYieldOperatorFee(controller).operatorFeeWad() * OPERATOR_SURCHARGE_BPS) / BPS;
    }

    function totalPerformanceFeeWad() external view returns (uint256) {
        return ICurveYieldOperatorFee(controller).operatorFeeWad() + protocolFeeWad();
    }

    /// @notice Permissionless harvest of newly accrued fee SHARES (not underlying assets).
    /// @dev The vault mints the fee shares to this contract on accrueInterest().
    function distribute() public nonReentrant returns (uint256 protocolShares, uint256 operatorShares) {
        vault.accrueInterest();
        uint256 shares = vault.balanceOf(address(this));
        if (shares == 0) return (0, 0);

        uint256 protocolFee = protocolFeeWad();
        uint256 totalFee = ICurveYieldOperatorFee(controller).operatorFeeWad() + protocolFee;
        // Split into quotient/remainder to avoid overflowing shares * protocolFee.
        uint256 fractionNumerator = (shares % totalFee) * protocolFee + feeRemainder;
        protocolShares = (shares / totalFee) * protocolFee + fractionNumerator / totalFee;
        feeRemainder = fractionNumerator % totalFee;
        operatorShares = shares - protocolShares;

        if (protocolShares != 0 && !vault.transfer(protocolRecipient, protocolShares)) revert TransferFailed();
        if (operatorShares != 0 && !vault.transfer(operatorRecipient, operatorShares)) revert TransferFailed();
        emit Distributed(protocolShares, operatorShares);
    }

    /// @dev Invoked ONLY by the fee controller after distributing old-rate fees.
    function rebaseRemainder(uint256 oldTotalFeeWad, uint256 newTotalFeeWad) external onlyController {
        feeRemainder = (feeRemainder * newTotalFeeWad) / oldTotalFeeWad;
    }

    /// @dev The controller settles old fees first, before changing the recipient.
    function setOperatorRecipient(address newRecipient) external onlyController {
        if (newRecipient == address(0)) revert InvalidAddress();
        operatorRecipient = newRecipient;
        emit OperatorRecipientUpdated(newRecipient);
    }

    /// @notice Only the existing CurveYield treasury can propose a replacement treasury.
    function proposeProtocolRecipient(address newRecipient) external {
        if (msg.sender != protocolRecipient) revert Unauthorized();
        if (newRecipient == address(0)) revert InvalidAddress();
        pendingProtocolRecipient = newRecipient;
        emit ProtocolRecipientProposed(newRecipient);
    }

    /// @notice The proposed treasury must explicitly accept the transfer.
    function acceptProtocolRecipient() external {
        if (msg.sender != pendingProtocolRecipient) revert Unauthorized();
        distribute(); // Old shares go to the OLD treasury.
        address old = protocolRecipient;
        protocolRecipient = msg.sender;
        pendingProtocolRecipient = address(0);
        emit ProtocolRecipientUpdated(old, msg.sender);
    }
}

/// @notice Permanent owner+curator of one freshly created Morpho Vault V2.
/// @dev No arbitrary target call, delegatecall, vault ownership transfer, curator replacement,
///      gate setters, or fee-recipient setter is exposed to the operator.
contract CurveYieldProtectedVaultController is ICurveYieldOperatorFee {
    uint256 public constant BASE_PROTOCOL_FEE_WAD = 2e15; // 0.2% of yield
    uint256 public constant OPERATOR_SURCHARGE_BPS = 200; // 2% of operator fee
    uint256 public constant BPS = 10_000;
    uint256 public constant MORPHO_MAX_PERFORMANCE_FEE_WAD = 5e17;

    address public immutable factory;
    address public operator;
    address public pendingOperator;
    IVaultV2CY public vault;
    CurveYieldProtectedFeeSplitter public splitter;
    uint256 public override operatorFeeWad;
    bool public initialized;
    uint256 private entered;

    event Initialized(address indexed vault, address indexed splitter, uint256 operatorFeeWad);
    event OperatorFeeUpdated(uint256 oldOperatorFeeWad, uint256 newOperatorFeeWad, uint256 totalFeeWad);
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
    error VaultOperationFailed(bytes returnData);

    modifier onlyOperator() {
        if (msg.sender != operator) revert Unauthorized();
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

    constructor(address _operator) {
        if (_operator == address(0)) revert InvalidAddress();
        factory = msg.sender;
        operator = _operator;
    }

    function totalFeeFor(uint256 opFeeWad) public pure returns (uint256) {
        if (opFeeWad > MORPHO_MAX_PERFORMANCE_FEE_WAD) revert InvalidFee();
        uint256 surcharge = (opFeeWad * OPERATOR_SURCHARGE_BPS) / BPS;
        uint256 total = BASE_PROTOCOL_FEE_WAD + opFeeWad + surcharge;
        if (total > MORPHO_MAX_PERFORMANCE_FEE_WAD) revert InvalidFee();
        return total;
    }

    function protocolFeeWad() external view returns (uint256) {
        return BASE_PROTOCOL_FEE_WAD + (operatorFeeWad * OPERATOR_SURCHARGE_BPS) / BPS;
    }

    /// @dev Only callable by the atomically deploying CurveYield factory. The vault was
    ///      created moments earlier with this contract as its first owner and no curator.
    function initialize(address _vault, address _splitter, uint256 initialOperatorFeeWad,
                        string calldata name, string calldata symbol) external {
        if (msg.sender != factory) revert Unauthorized();
        if (initialized) revert AlreadyInitialized();
        if (_vault == address(0) || _splitter == address(0)) revert InvalidAddress();
        uint256 total = totalFeeFor(initialOperatorFeeWad);
        IVaultV2CY v = IVaultV2CY(_vault);
        if (v.owner() != address(this) || v.curator() != address(0) ||
            v.totalSupply() != 0 || v.performanceFee() != 0 ||
            v.performanceFeeRecipient() != address(0) ||
            v.timelock(IVaultV2CY.setPerformanceFee.selector) != 0 ||
            v.timelock(IVaultV2CY.setPerformanceFeeRecipient.selector) != 0 ||
            v.timelock(IVaultV2CY.abdicate.selector) != 0) revert UnsafeVault();
        if (CurveYieldProtectedFeeSplitter(_splitter).controller() != address(this) ||
            address(CurveYieldProtectedFeeSplitter(_splitter).vault()) != _vault) revert UnsafeVault();

        initialized = true;
        vault = v;
        splitter = CurveYieldProtectedFeeSplitter(_splitter);
        operatorFeeWad = initialOperatorFeeWad;

        v.setName(name);
        v.setSymbol(symbol);
        v.setCurator(address(this));

        // At creation all selector timelocks are zero, so these submissions and their
        // executions can be done in the SAME transaction without an interleaving window.
        bytes memory recipientData = abi.encodeCall(IVaultV2CY.setPerformanceFeeRecipient, (_splitter));
        v.submit(recipientData);
        v.setPerformanceFeeRecipient(_splitter);

        bytes memory feeData = abi.encodeCall(IVaultV2CY.setPerformanceFee, (total));
        v.submit(feeData);
        v.setPerformanceFee(total);

        // Irreversible: nobody (including the operator) can redirect fee shares.
        bytes4 selector = IVaultV2CY.setPerformanceFeeRecipient.selector;
        v.submit(abi.encodeCall(IVaultV2CY.abdicate, (selector)));
        v.abdicate(selector);
        if (v.performanceFeeRecipient() != _splitter || !v.abdicated(selector) ||
            v.performanceFee() != total || v.curator() != address(this)) revert UnsafeVault();
        emit Initialized(_vault, _splitter, initialOperatorFeeWad);
    }

    /// @notice Operator fee is a fraction of recognized positive vault yield, scaled by 1e18.
    /// @dev Accrue and distribute under OLD fee BEFORE setting the new rate.
    function setOperatorPerformanceFee(uint256 newOperatorFeeWad)
        external onlyOperator ready nonReentrant {
        uint256 total = totalFeeFor(newOperatorFeeWad);
        uint256 old = operatorFeeWad;
        if (newOperatorFeeWad == old) return;
        uint256 oldTotal = totalFeeFor(old);

        splitter.distribute(); // Accrues fee shares under old rate, then settles them.
        if (vault.timelock(IVaultV2CY.setPerformanceFee.selector) != 0 ||
            vault.abdicated(IVaultV2CY.setPerformanceFee.selector)) revert UnsafeVault();
        bytes memory action = abi.encodeCall(IVaultV2CY.setPerformanceFee, (total));
        vault.submit(action);
        vault.setPerformanceFee(total); // Same transaction; no public pending fee update.
        splitter.rebaseRemainder(oldTotal, total);
        operatorFeeWad = newOperatorFeeWad;
        emit OperatorFeeUpdated(old, newOperatorFeeWad, total);
    }

    function setOperatorFeeRecipient(address newRecipient) external onlyOperator ready nonReentrant {
        if (newRecipient == address(0)) revert InvalidAddress();
        splitter.distribute();
        splitter.setOperatorRecipient(newRecipient);
    }

    /// @notice Two-step rotation of OPERATOR access only. The Morpho vault owner and
    ///         curator remain this controller forever, preserving the fee protection.
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

/// @notice Atomic deployment guarantees no operator-controlled setup window.
contract CurveYieldProtectedVaultFactory {
    address public constant MORPHO_VAULT_V2_FACTORY_FRAXTAL =
        0x711bCE12269a3a496eFaABB8B9AD5A4485E08A24;

    address public immutable protocolTreasury;
    event ProtectedVaultCreated(address indexed vault, address indexed controller,
        address indexed splitter, address operator, address asset, uint256 operatorFeeWad);

    error InvalidAddress();
    error WrongChain();
    error DeploymentFailed();

    constructor(address _protocolTreasury) {
        if (block.chainid != 252) revert WrongChain();
        if (_protocolTreasury == address(0)) revert InvalidAddress();
        protocolTreasury = _protocolTreasury;
    }

    /// @param asset ERC-20 vault deposit token.
    /// @param operator Address that can configure the vault; may be a Safe.
    /// @param operatorRecipient Address that receives the operator's fee shares.
    /// @param operatorFeeWad Operator's percent of recognized vault yield, scaled by 1e18.
    /// @param salt Unique deployment salt (use a fresh random salt).
    function createVault(address asset, address operator, address operatorRecipient,
        uint256 operatorFeeWad, string calldata name, string calldata symbol, bytes32 salt)
        external returns (address vault, address controller, address splitter)
    {
        if (asset == address(0) || operator == address(0) || operatorRecipient == address(0))
            revert InvalidAddress();
        if (bytes(name).length == 0 || bytes(symbol).length == 0) revert DeploymentFailed();
        CurveYieldProtectedVaultController c = new CurveYieldProtectedVaultController{salt: keccak256(
            abi.encode(msg.sender, asset, operator, salt)
        )}(operator);
        controller = address(c);
        vault = IVaultV2FactoryCY(MORPHO_VAULT_V2_FACTORY_FRAXTAL)
            .createVaultV2(controller, asset, salt);
        if (!IVaultV2FactoryCY(MORPHO_VAULT_V2_FACTORY_FRAXTAL).isVaultV2(vault))
            revert DeploymentFailed();
        CurveYieldProtectedFeeSplitter f = new CurveYieldProtectedFeeSplitter(
            vault, controller, operatorRecipient, protocolTreasury
        );
        splitter = address(f);
        c.initialize(vault, splitter, operatorFeeWad, name, symbol);
        emit ProtectedVaultCreated(vault, controller, splitter, operator, asset, operatorFeeWad);
    }
}