// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title CurveYield Ethereum Lending Adapter V1
 * @notice Vault V2-compatible, market-specific ERC4626 supply adapter.
 * @dev Protocol 3 (CurveLend V2) is the primary supported market family.
 *      Protocol 1 = CurveLend V1, 2 = Fraxlend, 3 = CurveLend V2,
 *      4 = Euler EVK (factory-registered eVault proxies).
 *      Every deployment is bound to an immutable parent Vault V2 and market.
 *      Deployment does NOT authorize allocation: curator, risk caps and
 *      allocation role remain exclusively controlled by Vault V2.
 */
interface ICYVaultV2 {
    function asset() external view returns (address);
    function allocation(bytes32 id) external view returns (uint256);
}
interface ICYVaultV2Factory {
    function isVaultV2(address vault) external view returns (bool);
}
interface ICY4626 {
    function asset() external view returns (address);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function previewRedeem(uint256 shares) external view returns (uint256 assets);
}
interface ICYCurveV1Factory {
    function market_count() external view returns (uint256);
    function vaults(uint256 i) external view returns (address);
}
interface ICYCurveV2Factory {
    struct Market {
        address vault;
        address controller;
        address amm;
        address collateralToken;
        address borrowedToken;
        address oracle;
        address monetaryPolicy;
    }
    function market_count() external view returns (uint256);
    function markets(uint256 i) external view returns (Market memory);
}
interface ICYFraxlendRegistry {
    function deployedPairsLength() external view returns (uint256);
    function deployedPairsArray(uint256 i) external view returns (address);
}
interface ICYEulerFactory {
    function isProxy(address proxy) external view returns (bool);
}

contract CurveYieldEthereumLendingAdapterV1 {
    address public immutable factory;
    address public immutable parentVault;
    address public immutable market;
    address public immutable asset;
    uint8 public immutable protocolId;
    bytes32 public immutable adapterId;
    uint256 public ownedShares;
    bool private inOperation;

    error Unauthorized();
    error UnexpectedData();
    error AssetMismatch();
    error Reentrancy();
    error InvalidShareMovement();
    error ApprovalFailed();
    error AmountOverflow();

    constructor(address vault, address market_, uint8 protocol_) {
        factory = msg.sender;
        parentVault = vault;
        market = market_;
        protocolId = protocol_;
        asset = ICYVaultV2(vault).asset();
        if (asset != ICY4626(market_).asset()) revert AssetMismatch();
        adapterId = keccak256(abi.encode("this", address(this)));
        _approve(asset, vault);
        _approve(asset, market_);
    }
    modifier fromVault() {
        if (msg.sender != parentVault) revert Unauthorized();
        if (inOperation) revert Reentrancy();
        inOperation = true;
        _;
        inOperation = false;
    }
    function _approve(address token, address spender) private {
        (bool success, bytes memory ret) = token.call(
            abi.encodeWithSelector(bytes4(0x095ea7b3), spender, type(uint256).max)
        );
        if (!success || (ret.length != 0 && (ret.length != 32 || !abi.decode(ret, (bool)))))
            revert ApprovalFailed();
    }
    function ids() external view returns (bytes32[] memory idList) {
        idList = new bytes32[](1);
        idList[0] = adapterId;
    }
    function realAssets() external view returns (uint256) {
        if (ICYVaultV2(parentVault).allocation(adapterId) == 0) return 0;
        return ICY4626(market).previewRedeem(ownedShares);
    }
    function allocate(bytes memory data, uint256 assets, bytes4, address)
        external fromVault returns (bytes32[] memory ids_, int256 change)
    {
        if (data.length != 0) revert UnexpectedData();
        uint256 recorded = ICYVaultV2(parentVault).allocation(adapterId);
        if (assets > 0) {
            uint256 newShares = ICY4626(market).deposit(assets, address(this));
            if (newShares == 0) revert InvalidShareMovement();
            ownedShares += newShares;
        }
        return _result(recorded);
    }
    function deallocate(bytes memory data, uint256 assets, bytes4, address)
        external fromVault returns (bytes32[] memory ids_, int256 change)
    {
        if (data.length != 0) revert UnexpectedData();
        uint256 recorded = ICYVaultV2(parentVault).allocation(adapterId);
        if (assets > 0) {
            uint256 sharesBurned = ICY4626(market).withdraw(assets, address(this), address(this));
            if (sharesBurned == 0 || sharesBurned > ownedShares) revert InvalidShareMovement();
            ownedShares -= sharesBurned;
        }
        return _result(recorded);
    }
    function _result(uint256 recorded)
        private view returns (bytes32[] memory ids_, int256 change)
    {
        uint256 actual = ICY4626(market).previewRedeem(ownedShares);
        if (recorded > uint256(type(int256).max) || actual > uint256(type(int256).max))
            revert AmountOverflow();
        ids_ = new bytes32[](1);
        ids_[0] = adapterId;
        change = int256(actual) - int256(recorded);
    }
}

contract CurveYieldEthereumLendingAdapterFactoryV1 {
    address public immutable vaultFactory;
    address public immutable curveLendV2Factory;
    address public immutable curveLendV1Factory;
    address public immutable fraxlendRegistry;
    address public immutable eulerFactory;
    mapping(address vault => mapping(address market => address adapter)) public adapter;
    mapping(address adapter => bool registered) public isCurveYieldEthereumAdapter;

    uint8 public constant CURVELEND_V1 = 1;
    uint8 public constant FRAXLEND = 2;
    uint8 public constant CURVELEND_V2 = 3;
    uint8 public constant EULER = 4;

    error InvalidFactory();
    error NotOfficialVault();
    error MarketNotRegistered();
    error ExistingAdapter();
    error BadProtocol();
    event LendingAdapterCreated(address indexed vault, address indexed market, uint8 indexed protocol, address adapter);

    constructor(
        address vaultFactory_,
        address curveV2_,
        address curveV1_,
        address fraxlend_,
        address euler_
    ) {
        if (vaultFactory_.code.length == 0 || curveV2_.code.length == 0 ||
            curveV1_.code.length == 0 || fraxlend_.code.length == 0 ||
            euler_.code.length == 0) revert InvalidFactory();
        vaultFactory = vaultFactory_;
        curveLendV2Factory = curveV2_;
        curveLendV1Factory = curveV1_;
        fraxlendRegistry = fraxlend_;
        eulerFactory = euler_;
    }
    /// @dev Uses explicit registry membership; avoids trusting user-supplied market labels.
    function isRegisteredMarket(address market, uint8 protocol) public view returns (bool) {
        if (market.code.length == 0) return false;
        if (protocol == CURVELEND_V2) {
            uint256 n = ICYCurveV2Factory(curveLendV2Factory).market_count();
            if (n > 512) return false;
            for (uint256 i; i < n; ++i)
                if (ICYCurveV2Factory(curveLendV2Factory).markets(i).vault == market) return true;
            return false;
        }
        if (protocol == CURVELEND_V1) {
            uint256 n = ICYCurveV1Factory(curveLendV1Factory).market_count();
            if (n > 512) return false;
            for (uint256 i; i < n; ++i)
                if (ICYCurveV1Factory(curveLendV1Factory).vaults(i) == market) return true;
            return false;
        }
        if (protocol == FRAXLEND) {
            uint256 n = ICYFraxlendRegistry(fraxlendRegistry).deployedPairsLength();
            if (n > 512) return false;
            for (uint256 i; i < n; ++i)
                if (ICYFraxlendRegistry(fraxlendRegistry).deployedPairsArray(i) == market) return true;
            return false;
        }
        if (protocol == EULER)
            return ICYEulerFactory(eulerFactory).isProxy(market);
        return false;
    }
    /// @notice Anyone can create a unique adapter, but cannot enable it or move vault funds.
    function createAdapter(address vault, address market, uint8 protocol) external returns (address deployed) {
        if (protocol < CURVELEND_V1 || protocol > EULER) revert BadProtocol();
        if (!ICYVaultV2Factory(vaultFactory).isVaultV2(vault)) revert NotOfficialVault();
        if (adapter[vault][market] != address(0)) revert ExistingAdapter();
        if (!isRegisteredMarket(market, protocol)) revert MarketNotRegistered();
        deployed = address(new CurveYieldEthereumLendingAdapterV1{salt: bytes32(0)}(vault, market, protocol));
        adapter[vault][market] = deployed;
        isCurveYieldEthereumAdapter[deployed] = true;
        emit LendingAdapterCreated(vault, market, protocol, deployed);
    }
}
