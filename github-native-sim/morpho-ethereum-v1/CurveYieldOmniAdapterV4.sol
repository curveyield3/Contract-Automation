// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title CurveYieldOmniAdapterV4
 * @notice A thin, multi-market adapter for the EXISTING Morpho Vault V2.
 *
 * No custom factory, ownership, curator, allocators, timelocks, risk caps,
 * admin registrations, deposit shares, fee distribution, or vault management.
 * Morpho Vault V2 already implements all of those. Deploy this contract with
 * the parent Vault V2 address, then use VaultV2.addAdapter(address), its normal
 * submit/execute timelocks, its cap ID system, and its allocate/deallocate.
 *
 * One adapter handles unlimited *types* of markets, subject to a bounded active
 * position list (MAX_MARKETS) to make realAssets() practical. Each operation:
 *
 *   VaultV2.allocate(address(this), abi.encode(mode,target,marketId,aux,min), assets)
 *   VaultV2.deallocate(address(this), abi.encode(mode,target,marketId,aux,min), assets)
 *
 * A per-market idData() configures the native Vault V2 absolute/relative caps.
 * No address allowlist is needed here: without the matching native Vault caps
 * the allocator's allocate() reverts atomically.
 *
 * Modes: 1 ERC4626 (Yearn, IPOR, Fluid fTokens, CurveLend V1/V2,
 *                  Euler, Maple and compatible yield vaults);
 *        2 Beefy V7 (BoostHub vaults);
 *        3 Aave V3 / Spark;
 *        4 Compound III Comet;
 *        5 Morpho Blue / compatible core fork;
 *        6 Aave V4 spoke (marketId = reserve ID);
 *        7 Dolomite normal market deposits, account number zero.
 *
 * Liquity V2 stability pools, asynchronous Maple withdrawals and non-4626
 * Cap mint/redeem require different reward/settlement integration and are NOT
 * implicitly supported by ERC4626 compatibility.
 *
 * A market must accept the Vault V2 deposit asset. No swaps or conversions.
 * Compilation is not integration testing or an audit.
 */

interface ICYV4Parent {
    function asset() external view returns (address);
    function allocation(bytes32 id) external view returns (uint256);
}
interface ICYV4Token {
    function balanceOf(address account) external view returns (uint256);
}
interface ICYV4ERC4626 {
    function asset() external view returns (address);
    function deposit(uint256 assets, address receiver) external returns (uint256);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256);
    function previewRedeem(uint256 shares) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}
interface ICYV4Beefy {
    function want() external view returns (address);
    function deposit(uint256 amount) external;
    function withdraw(uint256 shares) external;
    function balanceOf(address) external view returns (uint256);
    function getPricePerFullShare() external view returns (uint256);
}
interface ICYV4AaveV3 {
    struct ReserveConfigurationMap {uint256 data;}
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
    function getReserveData(address asset_) external view returns (ReserveData memory);
    function supply(address asset_,uint256 amount,address onBehalfOf,uint16 referralCode) external;
    function withdraw(address asset_,uint256 amount,address to) external returns (uint256);
}
interface ICYV4AToken {
    function POOL() external view returns (address);
    function UNDERLYING_ASSET_ADDRESS() external view returns (address);
    function balanceOf(address) external view returns (uint256);
}
interface ICYV4Comet {
    function baseToken() external view returns (address);
    function supply(address asset_,uint256 amount) external;
    function withdraw(address asset_,uint256 amount) external;
    function balanceOf(address) external view returns (uint256);
}
interface ICYV4Morpho {
    struct MarketParams {address loanToken;address collateralToken;address oracle;address irm;uint256 lltv;}
    struct Market {uint128 totalSupplyAssets;uint128 totalSupplyShares;uint128 totalBorrowAssets;uint128 totalBorrowShares;uint128 lastUpdate;uint128 fee;}
    struct Position {uint256 supplyShares;uint128 borrowShares;uint128 collateral;}
    function market(bytes32 id) external view returns (Market memory);
    function position(bytes32 id,address account) external view returns (Position memory);
    function supply(MarketParams memory params,uint256 assets,uint256 shares,address behalf,bytes memory data) external returns (uint256,uint256);
    function withdraw(MarketParams memory params,uint256 assets,uint256 shares,address behalf,address receiver) external returns (uint256,uint256);
}
interface ICYV4AaveSpoke {
    struct Reserve {address underlying;address hub;uint16 assetId;uint8 decimals;uint24 collateralRisk;uint8 flags;uint32 dynamicConfigKey;}
    function getReserve(uint256 reserveId) external view returns (Reserve memory);
    function getUserSuppliedAssets(uint256 reserveId,address user) external view returns (uint256);
    function supply(uint256 reserveId,uint256 assets,address behalf) external returns (uint256,uint256);
    function withdraw(uint256 reserveId,uint256 assets,address behalf) external returns (uint256,uint256);
}
interface ICYV4Dolomite {
    struct Account {address owner;uint256 number;}
    struct SignedWei {bool sign;uint256 value;}
    function getMarketTokenAddress(uint256 marketId) external view returns (address);
    function getAccountWei(Account calldata account,uint256 marketId) external view returns (SignedWei memory);
}
interface ICYV4DolomiteRouter {
    function DOLOMITE_MARGIN() external view returns (address);
    function depositWei(uint256 isolationModeMarketId,uint256 accountNumber,uint256 marketId,uint256 assets,uint8 eventFlag) external;
    function withdrawWei(uint256 isolationModeMarketId,uint256 accountNumber,uint256 marketId,uint256 assets,uint8 balanceCheckFlag) external;
}
library CYV4Math {
    function mulDiv(uint256 x,uint256 y,uint256 denominator) internal pure returns(uint256 result) {
        unchecked {
            uint256 p0;uint256 p1;
            assembly {
                let mm := mulmod(x,y,not(0))
                p0 := mul(x,y)
                p1 := sub(sub(mm,p0),lt(mm,p0))
            }
            if(p1==0)return p0/denominator;
            require(denominator>p1,"mulDiv");
            uint256 rem;
            assembly {rem := mulmod(x,y,denominator)}
            assembly {p1 := sub(p1,gt(rem,p0)) p0 := sub(p0,rem)}
            uint256 twos=denominator & (0-denominator);
            assembly {
                denominator := div(denominator,twos)
                p0 := div(p0,twos)
                twos := add(div(sub(0,twos),twos),1)
            }
            p0|=p1*twos;
            uint256 inv=(3*denominator)^2;
            inv*=2-denominator*inv;
            inv*=2-denominator*inv;
            inv*=2-denominator*inv;
            inv*=2-denominator*inv;
            inv*=2-denominator*inv;
            inv*=2-denominator*inv;
            result=p0*inv;
        }
    }
}
contract CurveYieldOmniAdapterV4 {
    uint8 private constant ERC4626=1;
    uint8 private constant BEEFY_V7=2;
    uint8 private constant AAVE_V3=3;
    uint8 private constant COMPOUND=4;
    uint8 private constant MORPHO=5;
    uint8 private constant AAVE_V4=6;
    uint8 private constant DOLOMITE=7;
    uint256 private constant SCALE=1e18;
    uint256 public constant MAX_MARKETS=128;

    address public immutable parentVault;
    address public immutable asset;

    // Only data that cannot be recovered from external markets is retained.
    struct MarketRef {
        address target;   // Supply contract, Aave pool/spoke, Morpho core, or Dolomite router
        address auxiliary;// Aave V3 aToken or Dolomite margin; zero otherwise
        bytes32 marketId; // Morpho market ID, Aave V4 reserve ID or Dolomite market ID
        uint8 mode;
        uint256 credit;   // Surplus underlying from an exact withdrawal; market-attributed
    }
    mapping(bytes32 key=>MarketRef) public markets;
    bytes32[] private active;
    mapping(bytes32 key=>uint256) private indexPlusOne;
    bool private entered;

    error OnlyVault();
    error UnsupportedMode();
    error InvalidMarket();
    error AssetMismatch();
    error InvalidInput();
    error InsufficientAssets();
    error TooManyMarkets();
    error Reentered();
    error ApprovalFailed();
    error ValuationOverflow();

    event EnteredMarket(bytes32 indexed key,address indexed target,uint8 indexed mode);
    event ExitedMarket(bytes32 indexed key);

    constructor(address vault) {
        if(vault.code.length==0)revert InvalidMarket();
        parentVault=vault;
        asset=ICYV4Parent(vault).asset();
        if(asset.code.length==0)revert AssetMismatch();
        _approve(vault,type(uint256).max);
    }
    modifier onlyVault() {
        if(msg.sender!=parentVault)revert OnlyVault();
        if(entered)revert Reentered();
        entered=true;_;entered=false;
    }
    function keyOf(uint8 mode,address target,bytes32 marketId,address auxiliary) public view returns(bytes32) {
        return keccak256(abi.encode("curveyield/omni-v4",address(this),mode,target,marketId,auxiliary));
    }
    function idData(uint8 mode,address target,bytes32 marketId,address auxiliary) external view returns(bytes memory) {
        return abi.encode("curveyield/omni-v4",address(this),mode,target,marketId,auxiliary);
    }
    function marketCount() external view returns(uint256){return active.length;}
    function marketAt(uint256 index) external view returns(bytes32 key,MarketRef memory market) {
        key=active[index];market=markets[key];
    }
    // Native Morpho Vault V2 cap ID: use keccak256(idData(...)).
    function _capId(bytes32 key) private pure returns(bytes32){return key;}
    function _approve(address spender,uint256 amount) private {
        (bool success,bytes memory ret)=asset.call(
            abi.encodeWithSelector(bytes4(0x095ea7b3),spender,amount)
        );
        if(!success||(ret.length!=0&&(ret.length!=32||!abi.decode(ret,(bool)))))
            revert ApprovalFailed();
    }

    function _validate(uint8 mode,address target,bytes32 marketId,address auxiliary,bytes memory extra) private view returns(address cachedAux) {
        if(target.code.length==0)revert InvalidMarket();
        cachedAux=auxiliary;
        if(mode==ERC4626) {
            if(marketId!=0||auxiliary!=address(0)||extra.length!=0||ICYV4ERC4626(target).asset()!=asset)revert AssetMismatch();
        } else if(mode==BEEFY_V7) {
            if(marketId!=0||auxiliary!=address(0)||extra.length!=0||ICYV4Beefy(target).want()!=asset)revert AssetMismatch();
        } else if(mode==AAVE_V3) {
            if(marketId!=0||auxiliary!=address(0)||extra.length!=0)revert InvalidInput();
            cachedAux=ICYV4AaveV3(target).getReserveData(asset).aTokenAddress;
            if(cachedAux.code.length==0||ICYV4AToken(cachedAux).POOL()!=target
               ||ICYV4AToken(cachedAux).UNDERLYING_ASSET_ADDRESS()!=asset)revert InvalidMarket();
        } else if(mode==COMPOUND) {
            if(marketId!=0||auxiliary!=address(0)||extra.length!=0||ICYV4Comet(target).baseToken()!=asset)revert AssetMismatch();
        } else if(mode==MORPHO) {
            if(auxiliary!=address(0)||extra.length!=160)revert InvalidInput();
            ICYV4Morpho.MarketParams memory p=abi.decode(extra,(ICYV4Morpho.MarketParams));
            if(p.loanToken!=asset||keccak256(abi.encode(p))!=marketId)revert AssetMismatch();
            if(ICYV4Morpho(target).market(marketId).lastUpdate==0)revert InvalidMarket();
        } else if(mode==AAVE_V4) {
            if(auxiliary!=address(0)||extra.length!=0||ICYV4AaveSpoke(target).getReserve(uint256(marketId)).underlying!=asset)
                revert AssetMismatch();
        } else if(mode==DOLOMITE) {
            if(extra.length!=0||auxiliary.code.length==0||ICYV4DolomiteRouter(target).DOLOMITE_MARGIN()!=auxiliary||
                ICYV4Dolomite(auxiliary).getMarketTokenAddress(uint256(marketId))!=asset)revert AssetMismatch();
        } else revert UnsupportedMode();
    }

    function _value(bytes32 key) private view returns(uint256 amount) {
        MarketRef storage m=markets[key];
        if(m.target==address(0))return 0;
        amount=m.credit;
        if(m.mode==ERC4626) {
            return amount+ICYV4ERC4626(m.target).previewRedeem(ICYV4ERC4626(m.target).balanceOf(address(this)));
        }
        if(m.mode==BEEFY_V7) {
            uint256 shares=ICYV4Beefy(m.target).balanceOf(address(this));
            return amount+CYV4Math.mulDiv(shares,ICYV4Beefy(m.target).getPricePerFullShare(),SCALE);
        }
        if(m.mode==AAVE_V3)return amount+ICYV4AToken(m.auxiliary).balanceOf(address(this));
        if(m.mode==COMPOUND)return amount+ICYV4Comet(m.target).balanceOf(address(this));
        if(m.mode==AAVE_V4)return amount+ICYV4AaveSpoke(m.target).getUserSuppliedAssets(uint256(m.marketId),address(this));
        if(m.mode==MORPHO) {
            ICYV4Morpho.Position memory p=ICYV4Morpho(m.target).position(m.marketId,address(this));
            ICYV4Morpho.Market memory market=ICYV4Morpho(m.target).market(m.marketId);
            return amount+CYV4Math.mulDiv(p.supplyShares,uint256(market.totalSupplyAssets)+1,uint256(market.totalSupplyShares)+1e6);
        }
        if(m.mode==DOLOMITE) {
            ICYV4Dolomite.SignedWei memory w=ICYV4Dolomite(m.auxiliary).getAccountWei(
                ICYV4Dolomite.Account(address(this),0),uint256(m.marketId));
            if(!w.sign&&w.value!=0)revert InvalidMarket();
            return amount+w.value;
        }
        revert UnsupportedMode();
    }
    function realAssets() external view returns(uint256 total) {
        for(uint256 i;i<active.length;++i)total+=_value(active[i]);
    }
    function positionAssets(uint8 mode,address target,bytes32 marketId,address auxiliary) external view returns(uint256) {
        return _value(keyOf(mode,target,marketId,auxiliary));
    }

    function _deposit(MarketRef storage m,uint256 amount,bytes memory extra) private returns(uint256 minted) {
        if(m.mode==ERC4626||m.mode==BEEFY_V7) {
            uint256 beforeShares=ICYV4Token(m.target).balanceOf(address(this));
            if(m.mode==ERC4626)ICYV4ERC4626(m.target).deposit(amount,address(this));
            else ICYV4Beefy(m.target).deposit(amount);
            uint256 afterShares=ICYV4Token(m.target).balanceOf(address(this));
            if(afterShares<=beforeShares)revert InsufficientAssets();
            minted=afterShares-beforeShares;
        } else if(m.mode==AAVE_V3)ICYV4AaveV3(m.target).supply(asset,amount,address(this),0);
        else if(m.mode==COMPOUND)ICYV4Comet(m.target).supply(asset,amount);
        else if(m.mode==AAVE_V4)(minted,)=ICYV4AaveSpoke(m.target).supply(uint256(m.marketId),amount,address(this));
        else if(m.mode==MORPHO) {
            ICYV4Morpho.MarketParams memory p=abi.decode(extra,(ICYV4Morpho.MarketParams));
            (,minted)=ICYV4Morpho(m.target).supply(p,amount,0,address(this),"");
        } else if(m.mode==DOLOMITE)ICYV4DolomiteRouter(m.target).depositWei(0,0,uint256(m.marketId),amount,0);
        else revert UnsupportedMode();
    }
    function _withdraw(MarketRef storage m,uint256 amount,bytes memory extra) private {
        if(m.mode==ERC4626)ICYV4ERC4626(m.target).withdraw(amount,address(this),address(this));
        else if(m.mode==BEEFY_V7) {
            uint256 pps=ICYV4Beefy(m.target).getPricePerFullShare();
            if(pps==0)revert InsufficientAssets();
            uint256 shares=CYV4Math.mulDiv(amount,SCALE,pps);
            if(CYV4Math.mulDiv(shares,pps,SCALE)<amount)++shares;
            ICYV4Beefy(m.target).withdraw(shares);
        } else if(m.mode==AAVE_V3)ICYV4AaveV3(m.target).withdraw(asset,amount,address(this));
        else if(m.mode==COMPOUND)ICYV4Comet(m.target).withdraw(asset,amount);
        else if(m.mode==AAVE_V4)ICYV4AaveSpoke(m.target).withdraw(uint256(m.marketId),amount,address(this));
        else if(m.mode==MORPHO) {
            ICYV4Morpho.MarketParams memory p=abi.decode(extra,(ICYV4Morpho.MarketParams));
            ICYV4Morpho(m.target).withdraw(p,amount,0,address(this),address(this));
        } else if(m.mode==DOLOMITE)ICYV4DolomiteRouter(m.target).withdrawWei(0,0,uint256(m.marketId),amount,1);
        else revert UnsupportedMode();
    }

    function _response(bytes32 key,uint256 previous) private view returns(bytes32[] memory ids,int256 change) {
        uint256 current=_value(key);
        if(current>uint256(type(int256).max)||previous>uint256(type(int256).max))revert ValuationOverflow();
        ids=new bytes32[](1);
        ids[0]=_capId(key);
        change=int256(current)-int256(previous);
    }

    // data = abi.encode(uint8 mode, address target, bytes32 marketId,
    //                   address auxiliary, uint256 minShares, bytes extra).
    // Morpho Blue extra = abi.encode(MarketParams), other modes require empty.
    function allocate(bytes memory data,uint256 assets,bytes4,address)
        external onlyVault returns(bytes32[] memory ids,int256 change)
    {
        (uint8 mode,address target,bytes32 marketId,address aux,uint256 minShares,bytes memory extra)=
            abi.decode(data,(uint8,address,bytes32,address,uint256,bytes));
        bytes32 key=keyOf(mode,target,marketId,aux);
        MarketRef storage m=markets[key];
        if(m.target==address(0)){
            address validatedAux=_validate(mode,target,marketId,aux,extra);
            if(active.length>=MAX_MARKETS)revert TooManyMarkets();
            m.target=target;m.auxiliary=validatedAux;m.marketId=marketId;m.mode=mode;
            indexPlusOne[key]=active.length+1;active.push(key);
            emit EnteredMarket(key,target,mode);
        }else {
            if(m.mode!=mode||m.target!=target|| (mode==DOLOMITE&&m.auxiliary!=aux))revert InvalidMarket();
            if(mode==MORPHO) _validate(mode,target,marketId,aux,extra);
            else if(extra.length!=0)revert InvalidInput();
        }
        uint256 previous=ICYV4Parent(parentVault).allocation(_capId(key));
        uint256 amount=assets+m.credit;
        if(amount!=0){
            m.credit=0;
            _approve(target,amount);
            uint256 minted=_deposit(m,amount,extra);
            _approve(target,0);
            if(minted<minShares)revert InsufficientAssets();
        }else if(minShares!=0)revert InvalidInput();
        (ids,change)=_response(key,previous);
    }

    // data uses identical tuple, but minShares is interpreted as minAssets
    // actually received. Vault V2 pulls the exact requested assets afterwards.
    function deallocate(bytes memory data,uint256 assets,bytes4,address)
        external onlyVault returns(bytes32[] memory ids,int256 change)
    {
        (uint8 mode,address target,bytes32 marketId,address aux,uint256 minAssets,bytes memory extra)=
            abi.decode(data,(uint8,address,bytes32,address,uint256,bytes));
        bytes32 key=keyOf(mode,target,marketId,aux);
        MarketRef storage m=markets[key];
        if(m.target!=target||m.target==address(0)||m.mode!=mode)revert InvalidMarket();
        if(mode==MORPHO)_validate(mode,target,marketId,aux,extra);
        else if(extra.length!=0)revert InvalidInput();
        if(assets<minAssets)revert InsufficientAssets();
        uint256 previous=ICYV4Parent(parentVault).allocation(_capId(key));
        if(assets>m.credit){
            uint256 needed=assets-m.credit;
            uint256 beforeAssets=ICYV4Token(asset).balanceOf(address(this));
            _withdraw(m,needed,extra);
            uint256 received=ICYV4Token(asset).balanceOf(address(this))-beforeAssets;
            if(received<needed)revert InsufficientAssets();
            m.credit=m.credit+received-assets;
        }else m.credit-=assets;
        (ids,change)=_response(key,previous);
        // Remove completely exited positions; cap/ownership rights stay in Vault V2.
        if(_value(key)==0){
            uint256 index=indexPlusOne[key]-1,last=active.length-1;
            if(index!=last){
                bytes32 swapKey=active[last];active[index]=swapKey;
                indexPlusOne[swapKey]=index+1;
            }
            active.pop();delete indexPlusOne[key];delete markets[key];
            emit ExitedMarket(key);
        }
    }
}
