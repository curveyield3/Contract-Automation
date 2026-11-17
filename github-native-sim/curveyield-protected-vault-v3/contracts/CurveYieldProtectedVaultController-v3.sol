// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title CurveYield Protected Morpho Vault V2 Controller (v3, transferrable governance)
/// @notice Fraxtal-only creation through the standard Morpho V2 factory with an operator,
///         replaceable Safe/governance authority, and governance-replaceable fee splitter.
/// @dev This controller creates a single Morpho vault. Governance can later rotate its
///      own privileges, replace recipients and the splitter, or transfer Morpho owner+curator
///      authority to a different governance contract. Morpho source remains unmodified.

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

    /// @notice Direct treasury rotation by authorized CurveYield governance via controller.
    /// @dev Old fee shares go to the old treasury before the recipient changes.
    function setProtocolRecipientByController(address newRecipient) external onlyController {
        if (newRecipient == address(0)) revert InvalidAddress();
        distribute();
        address old = protocolRecipient;
        protocolRecipient = newRecipient;
        pendingProtocolRecipient = address(0);
        emit ProtocolRecipientUpdated(old, newRecipient);
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

/// @notice New Morpho V2 vault deployer and initial owner+curator.
/// @dev Operator powers are restricted; authorized governance can replace its address,
///      change the vault fee splitter, or transfer Morpho owner+curator to new governance.
contract CurveYieldProtectedVaultController is ICurveYieldOperatorFee {
    uint256 public constant BASE_PROTOCOL_FEE_WAD = 2e15; // 0.2% of yield
    uint256 public constant OPERATOR_SURCHARGE_BPS = 200; // 2% of operator fee
    uint256 public constant BPS = 10_000;
    uint256 public constant MORPHO_MAX_PERFORMANCE_FEE_WAD = 5e17;

    address public constant MORPHO_VAULT_V2_FACTORY_FRAXTAL =
        0x711bCE12269a3a496eFaABB8B9AD5A4485E08A24;
    address public immutable protocolTreasury;
    /// @notice Initially the CurveYield treasury/Safe; transferable instantly by governance.
    address public governance;
    bool public migrated;
    address public operator;
    address public pendingOperator;
    IVaultV2CY public vault;
    CurveYieldProtectedFeeSplitter public splitter;
    uint256 public override operatorFeeWad;
    bool public initialized;
    uint256 private entered;

    event ProtectedVaultCreated(address indexed vault, address indexed splitter,
        address indexed operator, address asset, uint256 operatorFeeWad);
    event OperatorFeeUpdated(uint256 oldOperatorFeeWad, uint256 newOperatorFeeWad, uint256 totalFeeWad);
    event GovernanceTransferred(address indexed previousGovernance, address indexed newGovernance);
    event FeeSplitterReplaced(address indexed previousSplitter, address indexed newSplitter);
    event GovernanceVaultMigrated(address indexed newOwnerAndCurator, address indexed newSplitter);
    event ProtocolFeeRecipientChanged(address indexed newRecipient);
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
    error WrongChain();
    error DeploymentFailed();

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
        if (migrated) revert InvalidOperation();
        _;
    }

    modifier nonReentrant() {
        if (entered != 0) revert Reentrancy();
        entered = 1;
        _;
        entered = 0;
    }

    /// @param _operator Operator wallet or Safe; it alone can create and manage this vault.
    /// @param _protocolTreasury CurveYield treasury, fixed when this controller is deployed.
    constructor(address _operator, address _protocolTreasury) {
        if (block.chainid != 252) revert WrongChain();
        if (_operator == address(0) || _protocolTreasury == address(0)) revert InvalidAddress();
        operator = _operator;
        protocolTreasury = _protocolTreasury;
        governance = _protocolTreasury;
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

    /// @notice Create the only Morpho Vault V2 governed by this controller.
    /// @dev Two user transactions: deploy this controller, then call createVault as operator.
    ///      All Morpho factory creation, splitter deployment, and fee protection are atomic
    ///      in THIS creation transaction. A revert rolls back the entire operation.
    /// @param asset ERC-20 vault deposit token on Fraxtal.
    /// @param operatorRecipient Account receiving the operator's performance-fee shares.
    /// @param initialOperatorFeeWad Operator's fee on recognized vault yield (1e18 = 100%).
    /// @param name Morpho vault share name.
    /// @param symbol Morpho vault share symbol.
    /// @param salt Fresh random bytes32 for the existing Morpho factory.
    function createVault(
        address asset,
        address operatorRecipient,
        uint256 initialOperatorFeeWad,
        string calldata name,
        string calldata symbol,
        bytes32 salt
    ) external onlyOperator nonReentrant returns (address vaultAddress, address splitterAddress) {
        if (initialized) revert AlreadyInitialized();
        if (asset == address(0) || operatorRecipient == address(0)) revert InvalidAddress();
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
            v.abdicated(IVaultV2CY.setPerformanceFeeRecipient.selector)) revert UnsafeVault();

        CurveYieldProtectedFeeSplitter feeSplitter = new CurveYieldProtectedFeeSplitter(
            vaultAddress, address(this), operatorRecipient, protocolTreasury
        );
        splitterAddress = address(feeSplitter);
        vault = v;
        splitter = feeSplitter;
        operatorFeeWad = initialOperatorFeeWad;

        v.setName(name);
        v.setSymbol(symbol);
        v.setCurator(address(this));

        // All selector timelocks begin at zero. No other account ever controls
        // this vault's owner or curator role, even temporarily.
        bytes memory recipientData = abi.encodeCall(IVaultV2CY.setPerformanceFeeRecipient, (splitterAddress));
        v.submit(recipientData);
        v.setPerformanceFeeRecipient(splitterAddress);

        bytes memory feeData = abi.encodeCall(IVaultV2CY.setPerformanceFee, (total));
        v.submit(feeData);
        v.setPerformanceFee(total);

        // v3: DO NOT abdicate setPerformanceFeeRecipient. Authorized governance
        // must be able to replace the splitter or move to new governance later.
        // Vault operators still cannot call this selector through the controller.
        if (v.performanceFeeRecipient() != splitterAddress ||
            v.abdicated(IVaultV2CY.setPerformanceFeeRecipient.selector) ||
            v.performanceFee() != total || v.curator() != address(this) ||
            v.owner() != address(this)) revert UnsafeVault();

        initialized = true;
        emit ProtectedVaultCreated(vaultAddress, splitterAddress, operator, asset, initialOperatorFeeWad);
    }

    /// @notice Reassign Safe/governance administrative privileges immediately.
    /// @dev Does not move Morpho ownership: the controller remains owner+curator.
    ///      Independent of the operator's role; no timelock or proposal stage.
    function transferGovernance(address newGovernance) external onlyGovernance {
        if (newGovernance == address(0)) revert InvalidAddress();
        address previous = governance;
        governance = newGovernance;
        emit GovernanceTransferred(previous, newGovernance);
    }

    /// @notice Change CurveYield's treasury recipient directly (no timelock).
    /// @dev Settles all already-minted fee shares to the old recipient first.
    function setProtocolFeeRecipient(address newRecipient)
        external onlyGovernance ready nonReentrant
    {
        splitter.setProtocolRecipientByController(newRecipient);
        emit ProtocolFeeRecipientChanged(newRecipient);
    }

    /// @notice Governance-controlled replacement of Morpho's fee-share splitter.
    /// @dev The replacement must implement the existing splitter interface and
    ///      identify this controller and vault. Operators cannot call this.
    function replaceFeeSplitter(address newSplitter)
        external onlyGovernance ready nonReentrant
    {
        _checkSplitter(newSplitter, address(this));
        if (newSplitter == address(splitter)) revert InvalidOperation();
        splitter.distribute(); // Distribute all previously accrued shares first.
        address previous = address(splitter);
        _changeVaultFeeRecipient(newSplitter);
        splitter = CurveYieldProtectedFeeSplitter(newSplitter);
        emit FeeSplitterReplaced(previous, newSplitter);
    }

    /// @notice Transfer Morpho owner AND curator to a replacement governance contract
    ///         while simultaneously switching the fee-share receiver.
    /// @dev Immediate (no added timelock), atomic and authorized ONLY by governance.
    ///      The new controller must implement the splitter-compatible fee accounting.
    ///      Following migration, this controller's vault-management functions stop.
    function migrateVaultGovernance(address newController, address newSplitter)
        external onlyGovernance ready nonReentrant
    {
        if (newController == address(0) || newController == address(this) ||
            newController.code.length == 0) revert InvalidAddress();
        _checkSplitter(newSplitter, newController);
        splitter.distribute();
        _changeVaultFeeRecipient(newSplitter);
        vault.setCurator(newController);
        vault.setOwner(newController);
        if (vault.owner() != newController || vault.curator() != newController ||
            vault.performanceFeeRecipient() != newSplitter) revert UnsafeVault();
        migrated = true;
        emit GovernanceVaultMigrated(newController, newSplitter);
    }

    function _changeVaultFeeRecipient(address recipient) internal {
        bytes4 selector = IVaultV2CY.setPerformanceFeeRecipient.selector;
        if (vault.timelock(selector) != 0 || vault.abdicated(selector) ||
            vault.owner() != address(this) || vault.curator() != address(this)) revert UnsafeVault();
        bytes memory action = abi.encodeCall(IVaultV2CY.setPerformanceFeeRecipient, (recipient));
        vault.submit(action);
        vault.setPerformanceFeeRecipient(recipient);
        if (vault.performanceFeeRecipient() != recipient) revert UnsafeVault();
    }

    function _checkSplitter(address feeSplitter, address expectedController) internal view {
        if (feeSplitter == address(0) || feeSplitter.code.length == 0) revert InvalidAddress();
        CurveYieldProtectedFeeSplitter candidate = CurveYieldProtectedFeeSplitter(feeSplitter);
        if (address(candidate.vault()) != address(vault) ||
            candidate.controller() != expectedController ||
            candidate.protocolRecipient() == address(0) ||
            candidate.operatorRecipient() == address(0)) revert UnsafeVault();
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
