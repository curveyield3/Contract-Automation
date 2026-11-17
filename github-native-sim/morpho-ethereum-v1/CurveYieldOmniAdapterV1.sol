// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title CurveYieldOmniAdapterV1
 * @notice One Morpho Vault V2 adapter per parent vault with independently capped
 *         positions across ERC4626 yield vaults and legacy Beefy v7 vaults.
 * @dev All protocol integrations are opt-in. ERC4626 supports compatible
 *      Yearn, IPOR Fusion, CurveLend, Fraxlend, Euler and other vaults after
 *      case-by-case curator review. BeefyV7 has its own share accounting.
 *      Morpho Blue, Aave, Compound and Liquity require additional verified
 *      execution modes and are NOT silently enabled by the ERC4626 mode.
 *
 *      No market is authorized by merely deploying the adapter. The parent
 *      Vault V2 curator registers each destination and schedules its cap
 *      configuration. The allocator independently chooses each position.
 *      No public function can transfer the parent vault's funds.
 */
interface ICYOmniParent {
    function asset() external view returns (address);
    function owner() external view returns (address);
    function curator() external view returns (address);
    function allocation(bytes32 id) external view returns (uint256);
}
interface ICYOmniVaultFactory {
    function isVaultV2(address vault) external view returns (bool);
}
interface ICYOmniToken {
    function balanceOf(address owner) external view returns (uint256);
}
interface ICYOmniERC4626 {
    function asset() external view returns (address);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function previewRedeem(uint256 shares) external view returns (uint256 assets);
    function balanceOf(address account) external view returns (uint256 shares);
}
interface ICYOmniBeefyV7 {
    function want() external view returns (address);
    function deposit(uint256 amount) external;
    function withdraw(uint256 shares) external;
    function getPricePerFullShare() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256 shares);
}

contract CurveYieldOmniAdapterV1 {
    uint8 public constant ERC4626_MODE = 1;
    uint8 public constant BEEFY_V7_MODE = 2;
    uint8 public constant SUPPORTED_MODES = ERC4626_MODE | BEEFY_V7_MODE;
    uint256 public constant MAX_POSITIONS = 32;
    uint256 private constant SHARE_PRICE_SCALE = 1e18;

    address public immutable factory;
    address public immutable parentVault;
    address public immutable asset;
    uint8 public enabledModes;

    struct Position {
        uint8 mode;
        uint256 shares;
        uint256 idleCredit;
        bool registered;
    }
    mapping(address market => Position) public position;
    address[] public markets;
    bool private entered;

    error Unauthorized();
    error InvalidMode();
    error PositionAlreadyRegistered();
    error UnknownPosition();
    error InvalidAsset();
    error InvalidBytes();
    error Reentered();
    error InvalidAmount();
    error InsufficientShares();
    error Slippage();
    error TransferOrApprovalFailed();
    error AccountingOverflow();
    error TooManyPositions();

    event ModeMaskChanged(uint8 oldMask, uint8 newMask);
    event PositionRegistered(address indexed market, uint8 indexed mode, bytes32 indexed id);
    event PositionAllocated(address indexed market, uint256 assets, uint256 mintedShares);
    event PositionDeallocated(address indexed market, uint256 assets, uint256 burnedShares);

    constructor(address vault, uint8 selectedModes) {
        if (vault.code.length == 0 || selectedModes == 0 || (selectedModes & ~SUPPORTED_MODES) != 0) revert InvalidMode();
        factory = msg.sender;
        parentVault = vault;
        asset = ICYOmniParent(vault).asset();
        if (asset.code.length == 0) revert InvalidAsset();
        enabledModes = selectedModes;
        _approve(asset, vault);
    }

    modifier onlyVault() {
        if (msg.sender != parentVault) revert Unauthorized();
        if (entered) revert Reentered();
        entered = true;
        _;
        entered = false;
    }

    function _approve(address token, address spender) private {
        (bool ok, bytes memory result) = token.call(
            abi.encodeWithSelector(bytes4(0x095ea7b3), spender, type(uint256).max)
        );
        if (!ok || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool)))))
            revert TransferOrApprovalFailed();
    }

    /// @notice Owner can disable deposit modes at any time. Existing positions
    ///         can still deallocate while their mode is disabled.
    function setEnabledModes(uint8 newModes) external {
        if (msg.sender != ICYOmniParent(parentVault).owner()) revert Unauthorized();
        if ((newModes & ~SUPPORTED_MODES) != 0) revert InvalidMode();
        uint8 previous = enabledModes;
        enabledModes = newModes;
        emit ModeMaskChanged(previous, newModes);
    }

    /// @notice Curator must explicitly register every underlying vault.
    /// @dev A registry-registered omniadapter does not automatically trust
    ///      arbitrary ERC4626/Beefy implementations. Curator owns this choice.
    function registerPosition(address market, uint8 mode) external {
        if (msg.sender != ICYOmniParent(parentVault).curator()) revert Unauthorized();
        if (market.code.length == 0 || position[market].registered) revert PositionAlreadyRegistered();
        if (markets.length >= MAX_POSITIONS) revert TooManyPositions();
        if (mode != ERC4626_MODE && mode != BEEFY_V7_MODE) revert InvalidMode();
        if ((mode & enabledModes) == 0) revert InvalidMode();

        address underlying = mode == ERC4626_MODE
            ? ICYOmniERC4626(market).asset()
            : ICYOmniBeefyV7(market).want();
        if (underlying != asset) revert InvalidAsset();

        position[market].mode = mode;
        position[market].registered = true;
        markets.push(market);
        _approve(asset, market);
        emit PositionRegistered(market, mode, id(market));
    }

    /// @notice Exact cap identifier used by parent Vault V2.
    /// @dev UI passes idData(market) to increaseAbsoluteCap and increaseRelativeCap.
    function idData(address market) public view returns (bytes memory) {
        return abi.encode("curveyield-omni-v1", address(this), market);
    }
    function id(address market) public view returns (bytes32) {
        return keccak256(idData(market));
    }
    function ids() external view returns (bytes32[] memory out) {
        out = new bytes32[](markets.length);
        for (uint256 i; i < markets.length; ++i) out[i] = id(markets[i]);
    }
    function marketCount() external view returns (uint256) { return markets.length; }

    /// @notice Only supported market variants can be registered. Some ERC4626
    ///         targets may restrict deposits or impose withdrawal delays/fees.
    function positionAssets(address market) public view returns (uint256) {
        Position storage p = position[market];
        if (!p.registered) revert UnknownPosition();
        if (p.shares == 0) return p.idleCredit;
        if (p.mode == ERC4626_MODE)
            return ICYOmniERC4626(market).previewRedeem(p.shares) + p.idleCredit;
        return p.shares * ICYOmniBeefyV7(market).getPricePerFullShare() / SHARE_PRICE_SCALE + p.idleCredit;
    }

    /// @dev Counts all active positions, each in parent vault asset denomination.
    function realAssets() external view returns (uint256 sum) {
        for (uint256 i; i < markets.length; ++i) {
            address market = markets[i];
            if (position[market].shares != 0 || position[market].idleCredit != 0)
                sum += positionAssets(market);
        }
    }

    /// @param data abi.encode(address market, uint256 minimumMintedShares).
    function allocate(bytes memory data, uint256 assets, bytes4, address)
        external onlyVault returns (bytes32[] memory ids_, int256 change)
    {
        if (data.length != 64) revert InvalidBytes();
        (address market, uint256 minShares) = abi.decode(data, (address, uint256));
        Position storage p = position[market];
        if (!p.registered) revert UnknownPosition();
        if ((p.mode & enabledModes) == 0) revert InvalidMode();
        uint256 recorded = ICYOmniParent(parentVault).allocation(id(market));
        uint256 newShares;

        if (assets != 0 || p.idleCredit != 0) {
            uint256 amount = assets + p.idleCredit;
            p.idleCredit = 0;
            uint256 beforeShares = _shares(market, p.mode);
            if (p.mode == ERC4626_MODE) {
                ICYOmniERC4626(market).deposit(amount, address(this));
            } else {
                ICYOmniBeefyV7(market).deposit(amount);
            }
            uint256 afterShares = _shares(market, p.mode);
            if (afterShares <= beforeShares) revert InsufficientShares();
            newShares = afterShares - beforeShares;
            if (newShares < minShares) revert Slippage();
            p.shares += newShares;
        } else if (minShares != 0) revert InvalidAmount();

        (ids_, change) = _change(market, recorded);
        emit PositionAllocated(market, assets, newShares);
    }

    /// @param data abi.encode(address market, uint256 minimumReceivedAssets).
    /// @dev ERC4626 withdraw() requests exact assets. Legacy Beefy withdraw()
    ///      burns shares and can return too little due to strategy losses/fees;
    ///      the full parent Vault V2 operation reverts in that case.
    function deallocate(bytes memory data, uint256 assets, bytes4, address)
        external onlyVault returns (bytes32[] memory ids_, int256 change)
    {
        if (data.length != 64) revert InvalidBytes();
        (address market, uint256 minReceived) = abi.decode(data, (address, uint256));
        Position storage p = position[market];
        if (!p.registered) revert UnknownPosition();
        uint256 recorded = ICYOmniParent(parentVault).allocation(id(market));
        uint256 burned;

        if (assets != 0) {
            uint256 idleAvailable = p.idleCredit;
            if (assets <= idleAvailable) {
                p.idleCredit = idleAvailable - assets;
            } else {
                uint256 needed = assets - idleAvailable;
                uint256 balanceBefore = ICYOmniToken(asset).balanceOf(address(this));
                if (p.mode == ERC4626_MODE) {
                    burned = ICYOmniERC4626(market).withdraw(needed, address(this), address(this));
                } else {
                    uint256 ppfs = ICYOmniBeefyV7(market).getPricePerFullShare();
                    if (ppfs == 0) revert InvalidAmount();
                    uint256 shares = needed * SHARE_PRICE_SCALE / ppfs;
                    if (shares * ppfs / SHARE_PRICE_SCALE < needed) ++shares;
                    if (shares == 0) revert InvalidAmount();
                    ICYOmniBeefyV7(market).withdraw(shares);
                    burned = shares;
                }
                if (burned == 0 || burned > p.shares) revert InsufficientShares();
                p.shares -= burned;
                uint256 received = ICYOmniToken(asset).balanceOf(address(this)) - balanceBefore;
                if (received < needed) revert Slippage();
                p.idleCredit = idleAvailable + received - assets;
            }
            if (assets < minReceived) revert Slippage();
        } else if (minReceived != 0) revert InvalidAmount();

        (ids_, change) = _change(market, recorded);
        emit PositionDeallocated(market, assets, burned);
    }

    function _shares(address market, uint8 mode) private view returns (uint256) {
        return mode == ERC4626_MODE
            ? ICYOmniERC4626(market).balanceOf(address(this))
            : ICYOmniBeefyV7(market).balanceOf(address(this));
    }

    function _change(address market, uint256 recorded)
        private view returns (bytes32[] memory list, int256 change)
    {
        uint256 current = positionAssets(market);
        if (recorded > uint256(type(int256).max) || current > uint256(type(int256).max))
            revert AccountingOverflow();
        list = new bytes32[](1);
        list[0] = id(market);
        change = int256(current) - int256(recorded);
    }
}

contract CurveYieldOmniAdapterFactoryV1 {
    address public immutable vaultFactory;
    mapping(address vault => address adapter) public adapterOf;

    error InvalidVaultFactory();
    error InvalidParentVault();
    error AdapterAlreadyExists();
    event OmniAdapterCreated(address indexed vault, address indexed adapter, uint8 enabledModes);

    constructor(address vaultFactory_) {
        if (vaultFactory_.code.length == 0) revert InvalidVaultFactory();
        vaultFactory = vaultFactory_;
    }
    /// @notice Creates one adapter per vault with selectable execution modes.
    ///         Does not authorize it, configure market caps or move assets.
    function createAdapter(address vault, uint8 modes) external returns (address deployed) {
        if (!ICYOmniVaultFactory(vaultFactory).isVaultV2(vault)) revert InvalidParentVault();
        if (adapterOf[vault] != address(0)) revert AdapterAlreadyExists();
        deployed = address(new CurveYieldOmniAdapterV1(vault, modes));
        adapterOf[vault] = deployed;
        emit OmniAdapterCreated(vault, deployed, modes);
    }
}
