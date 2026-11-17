// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title CurveYieldOmniAdapterV3
 * @notice Vault V2-bound, multi-market yield adapter with one reusable factory.
 * @dev One independent Vault V2 allocation ID and cap per position, including
 *      Morpho market ID and Aave V4 spoke reserve ID. Owner selects integration
 *      modes; curator explicitly registers each destination; allocator controls
 *      deposits and withdrawals through parent Vault V2 only.
 *
 * MODES:
 * 1  ERC4626: Yearn, IPOR Fusion, Fluid fTokens, Euler, CurveLend, Fraxlend,
 *            Maple, Cap stcUSD and compatible yield vaults. Market access,
 *            cooldown/withdrawal queue and performance fees MUST be reviewed.
 * 2  BEEFY_V7: BoostHub CurveYieldVaultV7 and Beefy V7-style vaults (want(),
 *            deposit(uint256), withdraw(shares), getPricePerFullShare()).
 * 4  AAVE_V3: Aave V3 and SparkLend Aave-compatible pools.
 * 8  COMPOUND_V3: Compound III Comet base-token supply.
 * 16 MORPHO_BLUE: Morpho Blue and ABI-compatible core forks, keyed by market ID.
 * 32 AAVE_V4: Aave V4 spoke reserve supply/withdraw, keyed by reserve ID.
 * 64 DOLOMITE: Dolomite normal (non-isolation) market deposits, account #0,
 *              including market ID 0; router/margin pairing verified on-chain.
 *
 * Not automatically supported: asynchronous/permissioned Maple withdrawals,
 * Aave V4 hub-direct deposits, Cap cUSD mint/redeem basket, Liquity stability
 * pools or nonstandard Dolomite isolation vaults. No generic arbitrary call.
 *
 * SECURITY: This source is a compilation candidate, NOT a deployment audit.
 * No token conversion; every listed market MUST accept parent vault asset.
 */
interface ICYOParent {
    function asset() external view returns (address);
    function owner() external view returns (address);
    function curator() external view returns (address);
    function allocation(bytes32 id) external view returns (uint256);
}
interface ICYOVaultFactory { function isVaultV2(address vault) external view returns (bool); }
interface ICYOToken { function balanceOf(address account) external view returns (uint256); }
interface ICYOERC4626 {
    function asset() external view returns (address);
    function deposit(uint256 assets,address receiver) external returns (uint256 shares);
    function withdraw(uint256 assets,address receiver,address owner) external returns (uint256 shares);
    function previewRedeem(uint256 shares) external view returns (uint256 assets);
    function balanceOf(address owner) external view returns (uint256 shares);
}
interface ICYOBeefyV7 {
    function want() external view returns (address);
    function deposit(uint256 assets) external;
    function withdraw(uint256 shares) external;
    function getPricePerFullShare() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256 shares);
}
interface ICYOAaveV3 {
    struct ReserveConfigurationMap { uint256 data; }
    struct ReserveData {
        ReserveConfigurationMap configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }
    function getReserveData(address token) external view returns (ReserveData memory);
    function supply(address token,uint256 amount,address onBehalfOf,uint16 referralCode) external;
    function withdraw(address token,uint256 amount,address to) external returns (uint256);
}
interface ICYOAaveToken {
    function POOL() external view returns (address);
    function UNDERLYING_ASSET_ADDRESS() external view returns (address);
    function balanceOf(address owner) external view returns (uint256);
}
interface ICYOComet {
    function baseToken() external view returns (address);
    function supply(address token,uint256 amount) external;
    function withdraw(address token,uint256 amount) external;
    function balanceOf(address owner) external view returns (uint256);
}
interface ICYOMorpho {
    struct MarketParams {address loanToken;address collateralToken;address oracle;address irm;uint256 lltv;}
    struct Market {
        uint128 totalSupplyAssets;
        uint128 totalSupplyShares;
        uint128 totalBorrowAssets;
        uint128 totalBorrowShares;
        uint128 lastUpdate;
        uint128 fee;
    }
    struct Position {uint256 supplyShares;uint128 borrowShares;uint128 collateral;}
    function market(bytes32 id) external view returns (Market memory);
    function position(bytes32 id,address account) external view returns (Position memory);
    function supply(MarketParams memory,uint256 assets,uint256 shares,address onBehalf,bytes memory data)
        external returns(uint256,uint256);
    function withdraw(MarketParams memory,uint256 assets,uint256 shares,address onBehalf,address receiver)
        external returns(uint256,uint256);
}
interface ICYOAaveV4Spoke {
    struct Reserve {
        address underlying;
        address hub;
        uint16 assetId;
        uint8 decimals;
        uint24 collateralRisk;
        uint8 flags;
        uint32 dynamicConfigKey;
    }
    function getReserve(uint256 reserveId) external view returns (Reserve memory);
    function getUserSuppliedAssets(uint256 reserveId,address user) external view returns (uint256);
    function supply(uint256 reserveId,uint256 assets,address onBehalf) external returns (uint256,uint256);
    function withdraw(uint256 reserveId,uint256 assets,address onBehalf) external returns (uint256,uint256);
}
interface ICYODolomiteMargin {
    struct Account {address owner;uint256 number;}
    struct SignedWei {bool sign;uint256 value;}
    function getMarketTokenAddress(uint256 marketId) external view returns (address);
    function getAccountWei(Account calldata account,uint256 marketId) external view returns (SignedWei memory);
}
interface ICYODolomiteRouter {
    function DOLOMITE_MARGIN() external view returns (address);
    function depositWei(uint256 isolationModeMarketId,uint256 accountNumber,uint256 marketId,uint256 assets,uint8 eventFlag) external;
    function withdrawWei(uint256 isolationModeMarketId,uint256 accountNumber,uint256 marketId,uint256 assets,uint8 balanceCheckFlag) external;
}
library CYOMulDiv {
    /// @dev 512-bit full-precision floor(x*y/denominator), reverting on overflow.
    function mulDiv(uint256 x,uint256 y,uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0;uint256 prod1;
            assembly {
                let mm := mulmod(x, y, not(0))
                prod0 := mul(x,y)
                prod1 := sub(sub(mm,prod0),lt(mm,prod0))
            }
            if(prod1==0) return prod0/denominator;
            require(denominator>prod1,"MulDivOverflow");
            uint256 remainder;
            assembly { remainder := mulmod(x,y,denominator) }
            assembly { prod1 := sub(prod1,gt(remainder,prod0)) prod0 := sub(prod0,remainder) }
            uint256 twos=denominator & (0-denominator);
            assembly { denominator := div(denominator,twos) prod0 := div(prod0,twos) twos := add(div(sub(0,twos),twos),1) }
            prod0 |= prod1*twos;
            uint256 inverse=(3*denominator)^2;
            inverse*=2-denominator*inverse;
            inverse*=2-denominator*inverse;
            inverse*=2-denominator*inverse;
            inverse*=2-denominator*inverse;
            inverse*=2-denominator*inverse;
            inverse*=2-denominator*inverse;
            result=prod0*inverse;
        }
    }
}
contract CurveYieldOmniAdapterV3 {
    uint16 public constant ERC4626=1;
    uint16 public constant BEEFY_V7=2;
    uint16 public constant AAVE_V3=4;
    uint16 public constant COMPOUND_V3=8;
    uint16 public constant MORPHO_BLUE=16;
    uint16 public constant AAVE_V4=32;
    uint16 public constant DOLOMITE=64;
    uint16 public constant ALL_MODES=127;
    uint256 public constant MAX_POSITIONS=32;
    uint256 private constant SCALE=1e18;

    address public immutable factory;
    address public immutable parentVault;
    address public immutable asset;
    uint16 public enabledModes;

    struct Position {
        address target;
        address auxiliary; // Aave V3 aToken or Dolomite Margin
        bytes32 marketId;  // Morpho Blue market ID, Aave V4 reserve ID, Dolomite market ID
        uint16 mode;
        bool registered;
        uint256 shares;    // only for ERC4626 and Beefy V7
        uint256 idleCredit;// surplus assets returned from withdrawals, reserved to position
    }
    mapping(bytes32 key=>Position) public position;
    mapping(bytes32 key=>ICYOMorpho.MarketParams) public morphoParams;
    bytes32[] public keys;
    bool private busy;

    error NotAuthorized();
    error InvalidMode();
    error AlreadyRegistered();
    error UnrecognizedPosition();
    error AssetMismatch();
    error InvalidMarket();
    error InvalidData();
    error TransferFailed();
    error Slippage();
    error Reentered();
    error TooManyPositions();
    error InvalidShares();
    error AccountingOverflow();

    event IntegrationModesSet(uint16 previous,uint16 current);
    event PositionRegistered(bytes32 indexed key,bytes32 indexed id,address indexed target,uint16 mode,bytes32 marketId);
    event PositionAllocated(bytes32 indexed key,uint256 assets,uint256 shares);
    event PositionDeallocated(bytes32 indexed key,uint256 assets,uint256 shares);

    constructor(address vault,uint16 modes) {
        if(vault.code.length==0||modes==0||(modes & ~ALL_MODES)!=0)revert InvalidMode();
        factory=msg.sender;
        parentVault=vault;
        asset=ICYOParent(vault).asset();
        if(asset.code.length==0)revert AssetMismatch();
        enabledModes=modes;
        _approve(asset,vault);
    }
    modifier onlyVault() {
        if(msg.sender!=parentVault)revert NotAuthorized();
        if(busy)revert Reentered();
        busy=true;_;busy=false;
    }
    function setEnabledModes(uint16 modes) external {
        if(msg.sender!=ICYOParent(parentVault).owner())revert NotAuthorized();
        if((modes & ~ALL_MODES)!=0)revert InvalidMode();
        emit IntegrationModesSet(enabledModes,modes);
        enabledModes=modes;
    }
    function _approve(address token,address spender) private {
        (bool ok,bytes memory r)=token.call(abi.encodeWithSelector(bytes4(0x095ea7b3),spender,type(uint256).max));
        if(!ok||(r.length!=0&&(r.length!=32||!abi.decode(r,(bool)))))revert TransferFailed();
    }
    function keyOf(address target,uint16 mode,bytes32 marketId) public pure returns (bytes32) {
        return keccak256(abi.encode(target,mode,marketId));
    }
    function idData(bytes32 key) public view returns (bytes memory) {
        return abi.encode("curveyield-omni-v3",address(this),key);
    }
    function id(bytes32 key) public view returns (bytes32) {return keccak256(idData(key));}
    function ids() external view returns (bytes32[] memory result){
        result=new bytes32[](keys.length);
        for(uint256 i;i<keys.length;++i)result[i]=id(keys[i]);
    }
    function positionCount() external view returns(uint256){return keys.length;}

    /// @param auxiliary DolomiteMargin for mode 64; otherwise zero.
    /// @param marketData abi.encode(MarketParams) for Morpho, empty otherwise.
    /// @dev Only curator registers destinations; no mode uses arbitrary external calldata.
    function registerPosition(address target,uint16 mode,bytes32 marketId,address auxiliary,bytes calldata marketData)
        external returns (bytes32 key)
    {
        if(msg.sender!=ICYOParent(parentVault).curator())revert NotAuthorized();
        if(target.code.length==0||keys.length>=MAX_POSITIONS)revert TooManyPositions();
        if(mode==0||(mode&(mode-1))!=0||(mode&enabledModes)==0)revert InvalidMode();
        key=keyOf(target,mode,marketId);
        if(position[key].registered)revert AlreadyRegistered();
        if(mode!=MORPHO_BLUE&&marketData.length!=0)revert InvalidData();
        if(mode==ERC4626){
            if(marketId!=bytes32(0)||auxiliary!=address(0)||ICY0Asset(target)!=asset)revert AssetMismatch();
        } else if(mode==BEEFY_V7){
            if(marketId!=bytes32(0)||auxiliary!=address(0)||ICYOBeefyV7(target).want()!=asset)revert AssetMismatch();
        } else if(mode==AAVE_V3){
            if(marketId!=bytes32(0)||auxiliary!=address(0))revert InvalidMarket();
            address a=ICYOAaveV3(target).getReserveData(asset).aTokenAddress;
            if(a.code.length==0||ICYOAaveToken(a).POOL()!=target||ICYOAaveToken(a).UNDERLYING_ASSET_ADDRESS()!=asset)
                revert InvalidMarket();
            auxiliary=a;
        } else if(mode==COMPOUND_V3){
            if(marketId!=bytes32(0)||auxiliary!=address(0)||ICYOComet(target).baseToken()!=asset)revert AssetMismatch();
        } else if(mode==MORPHO_BLUE){
            if(auxiliary!=address(0)||marketData.length!=160)revert InvalidMarket();
            ICYOMorpho.MarketParams memory p=abi.decode(marketData,(ICYOMorpho.MarketParams));
            if(p.loanToken!=asset||keccak256(abi.encode(p))!=marketId)revert AssetMismatch();
            if(ICYOMorpho(target).market(marketId).lastUpdate==0)revert InvalidMarket();
            morphoParams[key]=p;
        } else if(mode==AAVE_V4){
            if(auxiliary!=address(0)||ICY0AaveV4Asset(target,uint256(marketId))!=asset)revert AssetMismatch();
        } else if(mode==DOLOMITE){
            if(auxiliary.code.length==0||ICYODolomiteRouter(target).DOLOMITE_MARGIN()!=auxiliary||
                ICYODolomiteMargin(auxiliary).getMarketTokenAddress(uint256(marketId))!=asset)
                revert AssetMismatch();
        } else revert InvalidMode();
        position[key]=Position(target,auxiliary,marketId,mode,true,0,0);
        keys.push(key);
        _approve(asset,target);
        emit PositionRegistered(key,id(key),target,mode,marketId);
    }
    function ICY0Asset(address target) private view returns(address){return ICYOERC4626(target).asset();}
    function ICY0AaveV4Asset(address target,uint256 reserveId) private view returns(address){
        return ICYOAaveV4Spoke(target).getReserve(reserveId).underlying;
    }
    function _value(bytes32 key) private view returns(uint256){
        Position storage p=position[key];
        if(!p.registered)revert UnrecognizedPosition();
        if(p.mode==ERC4626)return ICYOERC4626(p.target).previewRedeem(p.shares)+p.idleCredit;
        if(p.mode==BEEFY_V7)return CYOMulDiv.mulDiv(p.shares,ICYOBeefyV7(p.target).getPricePerFullShare(),SCALE)+p.idleCredit;
        if(p.mode==AAVE_V3)return ICYOAaveToken(p.auxiliary).balanceOf(address(this))+p.idleCredit;
        if(p.mode==COMPOUND_V3)return ICYOComet(p.target).balanceOf(address(this))+p.idleCredit;
        if(p.mode==AAVE_V4)return ICYOAaveV4Spoke(p.target).getUserSuppliedAssets(uint256(p.marketId),address(this))+p.idleCredit;
        if(p.mode==MORPHO_BLUE){
            ICYOMorpho.Position memory held=ICYOMorpho(p.target).position(p.marketId,address(this));
            ICYOMorpho.Market memory m=ICYOMorpho(p.target).market(p.marketId);
            return CYOMulDiv.mulDiv(held.supplyShares,uint256(m.totalSupplyAssets)+1,uint256(m.totalSupplyShares)+1e6)+p.idleCredit;
        }
        if(p.mode==DOLOMITE){
            ICYODolomiteMargin.Account memory account=ICYODolomiteMargin.Account(address(this),0);
            ICYODolomiteMargin.SignedWei memory w=ICYODolomiteMargin(p.auxiliary).getAccountWei(account,uint256(p.marketId));
            if(!w.sign&&w.value!=0)revert InvalidMarket();
            return w.value+p.idleCredit;
        }
        revert InvalidMode();
    }
    function positionAssets(bytes32 key) external view returns(uint256){return _value(key);}
    function realAssets() external view returns(uint256 sum){
        for(uint256 i;i<keys.length;++i)sum+=_value(keys[i]);
    }
    function _shareBalance(Position storage p) private view returns(uint256){
        return ICYOToken(p.target).balanceOf(address(this));
    }
    function _deposit(Position storage p,bytes32 key,uint256 amount) private returns(uint256 minted){
        if(p.mode==ERC4626||p.mode==BEEFY_V7){
            uint256 beforeShares=_shareBalance(p);
            if(p.mode==ERC4626)ICYOERC4626(p.target).deposit(amount,address(this));
            else ICYOBeefyV7(p.target).deposit(amount);
            uint256 afterShares=_shareBalance(p);
            if(afterShares<=beforeShares)revert InvalidShares();
            minted=afterShares-beforeShares;
            p.shares+=minted;
        }else if(p.mode==AAVE_V3)ICYOAaveV3(p.target).supply(asset,amount,address(this),0);
        else if(p.mode==COMPOUND_V3)ICYOComet(p.target).supply(asset,amount);
        else if(p.mode==MORPHO_BLUE){
            (,minted)=ICYOMorpho(p.target).supply(morphoParams[key],amount,0,address(this),"");
        }else if(p.mode==AAVE_V4){
            (minted,)=ICYOAaveV4Spoke(p.target).supply(uint256(p.marketId),amount,address(this));
        }else if(p.mode==DOLOMITE){
            ICYODolomiteRouter(p.target).depositWei(0,0,uint256(p.marketId),amount,0);
        }else revert InvalidMode();
    }
    function _withdraw(Position storage p,bytes32 key,uint256 amount) private returns(uint256 burned){
        if(p.mode==ERC4626||p.mode==BEEFY_V7){
            uint256 beforeShares=_shareBalance(p);
            if(p.mode==ERC4626)ICYOERC4626(p.target).withdraw(amount,address(this),address(this));
            else {
                uint256 ppfs=ICYOBeefyV7(p.target).getPricePerFullShare();
                if(ppfs==0)revert InvalidShares();
                uint256 shares=CYOMulDiv.mulDiv(amount,SCALE,ppfs);
                if(CYOMulDiv.mulDiv(shares,ppfs,SCALE)<amount)++shares;
                ICYOBeefyV7(p.target).withdraw(shares);
            }
            uint256 afterShares=_shareBalance(p);
            if(afterShares>=beforeShares)revert InvalidShares();
            burned=beforeShares-afterShares;
            if(burned>p.shares)revert InvalidShares();
            p.shares-=burned;
        }else if(p.mode==AAVE_V3)ICYOAaveV3(p.target).withdraw(asset,amount,address(this));
        else if(p.mode==COMPOUND_V3)ICYOComet(p.target).withdraw(asset,amount);
        else if(p.mode==MORPHO_BLUE){
            (,burned)=ICYOMorpho(p.target).withdraw(morphoParams[key],amount,0,address(this),address(this));
        }else if(p.mode==AAVE_V4){
            (burned,)=ICYOAaveV4Spoke(p.target).withdraw(uint256(p.marketId),amount,address(this));
        }else if(p.mode==DOLOMITE)ICYODolomiteRouter(p.target).withdrawWei(0,0,uint256(p.marketId),amount,1);
        else revert InvalidMode();
    }
    function _answer(bytes32 key,uint256 recorded) private view returns(bytes32[] memory result,int256 change){
        uint256 actual=_value(key);
        if(actual>uint256(type(int256).max)||recorded>uint256(type(int256).max))revert AccountingOverflow();
        result=new bytes32[](1);
        result[0]=id(key);
        change=int256(actual)-int256(recorded);
    }
    /// @param data abi.encode(bytes32 positionKey,uint256 minimumMintedShares).
    /// @dev Vault V2 sends amount of loan asset to this contract BEFORE calling allocate.
    function allocate(bytes memory data,uint256 assets,bytes4,address)
        external onlyVault returns(bytes32[] memory result,int256 change)
    {
        if(data.length!=64)revert InvalidData();
        (bytes32 key,uint256 minimumShares)=abi.decode(data,(bytes32,uint256));
        Position storage p=position[key];
        if(!p.registered)revert UnrecognizedPosition();
        if((p.mode&enabledModes)==0)revert InvalidMode();
        uint256 recorded=ICYOParent(parentVault).allocation(id(key));
        uint256 minted;
        if(assets+p.idleCredit!=0){
            uint256 amount=assets+p.idleCredit;
            p.idleCredit=0;
            minted=_deposit(p,key,amount);
            if(minted<minimumShares)revert Slippage();
        }else if(minimumShares!=0)revert Slippage();
        (result,change)=_answer(key,recorded);
        emit PositionAllocated(key,assets,minted);
    }
    /// @param data abi.encode(bytes32 positionKey,uint256 minimumReceivedAssets).
    /// @dev Only parent Vault V2 may call. It pulls exactly assets afterwards.
    ///      Beefy fees/shortfalls revert, rather than silently socialize losses.
    function deallocate(bytes memory data,uint256 assets,bytes4,address)
        external onlyVault returns(bytes32[] memory result,int256 change)
    {
        if(data.length!=64)revert InvalidData();
        (bytes32 key,uint256 minimumReceived)=abi.decode(data,(bytes32,uint256));
        Position storage p=position[key];
        if(!p.registered)revert UnrecognizedPosition();
        uint256 recorded=ICYOParent(parentVault).allocation(id(key));
        uint256 burned;
        if(assets!=0){
            if(assets>p.idleCredit){
                uint256 needed=assets-p.idleCredit;
                uint256 beforeBalance=ICYOToken(asset).balanceOf(address(this));
                burned=_withdraw(p,key,needed);
                uint256 received=ICYOToken(asset).balanceOf(address(this))-beforeBalance;
                if(received<needed)revert Slippage();
                p.idleCredit=p.idleCredit+received-assets;
            }else p.idleCredit-=assets;
            if(assets<minimumReceived)revert Slippage();
        }else if(minimumReceived!=0)revert Slippage();
        (result,change)=_answer(key,recorded);
        emit PositionDeallocated(key,assets,burned);
    }
}
contract CurveYieldOmniAdapterFactoryV3 {
    address public immutable vaultFactory;
    mapping(address vault=>address adapter) public adapterOf;

    error InvalidVault();
    error AdapterExists();
    event OmniAdapterCreated(address indexed vault,address indexed adapter,uint16 enabledModes);

    constructor(address factory_) {
        if(factory_.code.length==0)revert InvalidVault();
        vaultFactory=factory_;
    }
    /// @dev Permissionless creation; does not enable risk caps or move funds.
    function createAdapter(address vault,uint16 selectedModes) external returns(address adapter){
        if(!ICYOVaultFactory(vaultFactory).isVaultV2(vault))revert InvalidVault();
        if(adapterOf[vault]!=address(0))revert AdapterExists();
        adapter=address(new CurveYieldOmniAdapterV3(vault,selectedModes));
        adapterOf[vault]=adapter;
        emit OmniAdapterCreated(vault,adapter,selectedModes);
    }
}
