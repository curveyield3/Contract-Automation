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

/**
 * @title CurveYieldOmniAdapterV6
 * @notice A thin, multi-market adapter for the EXISTING Morpho Vault V2.
 *
 * This file also includes an optional minimal native-fee deployer.
 * The deployer charges only at adapter creation and does not implement
 * any vault, fund-management, allocation, or protocol-adapter logic.
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
 * In particular, Morpho projected assets read borrowRateView() and may revert
 * if an integrated IRM is incompatible or reverts, blocking vault-wide reads.
 */

interface ICYV6Factory { function isVaultV2(address vault) external view returns (bool); }
interface ICYV6Parent {
    function asset() external view returns (address);
    function allocation(bytes32 id) external view returns (uint256);
}
interface ICYV6Token {
    function balanceOf(address account) external view returns (uint256);
}
interface ICYV6ERC4626 {
    function asset() external view returns (address);
    function deposit(uint256 assets, address receiver) external returns (uint256);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256);
    function previewRedeem(uint256 shares) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}
interface ICYV6Beefy {
    function want() external view returns (address);
    function deposit(uint256 amount) external;
    function withdraw(uint256 shares) external;
    function balanceOf(address) external view returns (uint256);
    function getPricePerFullShare() external view returns (uint256);
}
interface ICYV6AaveV3 {
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
interface ICYV6AToken {
    function POOL() external view returns (address);
    function UNDERLYING_ASSET_ADDRESS() external view returns (address);
    function balanceOf(address) external view returns (uint256);
}
interface ICYV6Comet {
    function baseToken() external view returns (address);
    function supply(address asset_,uint256 amount) external;
    function withdraw(address asset_,uint256 amount) external;
    function balanceOf(address) external view returns (uint256);
}
interface ICYV6Morpho {
    struct MarketParams {address loanToken;address collateralToken;address oracle;address irm;uint256 lltv;}
    struct Market {uint128 totalSupplyAssets;uint128 totalSupplyShares;uint128 totalBorrowAssets;uint128 totalBorrowShares;uint128 lastUpdate;uint128 fee;}
    struct Position {uint256 supplyShares;uint128 borrowShares;uint128 collateral;}
    function market(bytes32 id) external view returns (Market memory);
    function position(bytes32 id,address account) external view returns (Position memory);
    function idToMarketParams(bytes32 id) external view returns (MarketParams memory);
    function supply(MarketParams memory params,uint256 assets,uint256 shares,address behalf,bytes memory data) external returns (uint256,uint256);
    function withdraw(MarketParams memory params,uint256 assets,uint256 shares,address behalf,address receiver) external returns (uint256,uint256);
}
interface ICYV6Irm {
    function borrowRateView(ICYV6Morpho.MarketParams memory params,ICYV6Morpho.Market memory market) external view returns(uint256);
}
interface ICYV6AaveSpoke {
    struct Reserve {address underlying;address hub;uint16 assetId;uint8 decimals;uint24 collateralRisk;uint8 flags;uint32 dynamicConfigKey;}
    function getReserve(uint256 reserveId) external view returns (Reserve memory);
    function getUserSuppliedAssets(uint256 reserveId,address user) external view returns (uint256);
    function supply(uint256 reserveId,uint256 assets,address behalf) external returns (uint256,uint256);
    function withdraw(uint256 reserveId,uint256 assets,address behalf) external returns (uint256,uint256);
}
interface ICYV6Dolomite {
    struct Account {address owner;uint256 number;}
    struct SignedWei {bool sign;uint256 value;}
    function getMarketTokenAddress(uint256 marketId) external view returns (address);
    function getAccountWei(Account calldata account,uint256 marketId) external view returns (SignedWei memory);
}
interface ICYV6DolomiteRouter {
    function DOLOMITE_MARGIN() external view returns (address);
    function depositWei(uint256 isolationModeMarketId,uint256 accountNumber,uint256 marketId,uint256 assets,uint8 eventFlag) external;
    function withdrawWei(uint256 isolationModeMarketId,uint256 accountNumber,uint256 marketId,uint256 assets,uint8 balanceCheckFlag) external;
}
library CYV6Math {
    // Match Morpho Blue MathLib's three-term WAD compounded interest projection.
    function wTaylorCompounded(uint256 rate,uint256 elapsed) internal pure returns(uint256) {
        uint256 first=rate*elapsed;
        uint256 second=mulDiv(first,first,2e18);
        uint256 third=mulDiv(second,first,3e18);
        return first+second+third;
    }
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
contract CurveYieldOmniAdapterV6 {
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
        uint256 trackedShares; // Prevent third-party donated shares from distorting vault accounting
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
        asset=ICYV6Parent(vault).asset();
        if(asset.code.length==0)revert AssetMismatch();
        _approve(vault,type(uint256).max);
    }
    modifier onlyVault() {
        if(msg.sender!=parentVault)revert OnlyVault();
        if(entered)revert Reentered();
        entered=true;_;entered=false;
    }
    function keyOf(uint8 mode,address target,bytes32 marketId,address auxiliary) public view returns(bytes32) {
        return keccak256(abi.encode("curveyield/omni-v6",address(this),mode,target,marketId,auxiliary));
    }
    function idData(uint8 mode,address target,bytes32 marketId,address auxiliary) external view returns(bytes memory) {
        return abi.encode("curveyield/omni-v6",address(this),mode,target,marketId,auxiliary);
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
            if(marketId!=0||auxiliary!=address(0)||extra.length!=0||ICYV6ERC4626(target).asset()!=asset)revert AssetMismatch();
        } else if(mode==BEEFY_V7) {
            if(marketId!=0||auxiliary!=address(0)||extra.length!=0||ICYV6Beefy(target).want()!=asset)revert AssetMismatch();
        } else if(mode==AAVE_V3) {
            if(marketId!=0||auxiliary!=address(0)||extra.length!=0)revert InvalidInput();
            cachedAux=ICYV6AaveV3(target).getReserveData(asset).aTokenAddress;
            if(cachedAux.code.length==0||ICYV6AToken(cachedAux).POOL()!=target
               ||ICYV6AToken(cachedAux).UNDERLYING_ASSET_ADDRESS()!=asset)revert InvalidMarket();
        } else if(mode==COMPOUND) {
            if(marketId!=0||auxiliary!=address(0)||extra.length!=0||ICYV6Comet(target).baseToken()!=asset)revert AssetMismatch();
        } else if(mode==MORPHO) {
            if(auxiliary!=address(0)||extra.length!=160)revert InvalidInput();
            ICYV6Morpho.MarketParams memory p=abi.decode(extra,(ICYV6Morpho.MarketParams));
            if(p.loanToken!=asset||keccak256(abi.encode(p))!=marketId)revert AssetMismatch();
            if(ICYV6Morpho(target).market(marketId).lastUpdate==0)revert InvalidMarket();
        } else if(mode==AAVE_V4) {
            if(auxiliary!=address(0)||extra.length!=0||ICYV6AaveSpoke(target).getReserve(uint256(marketId)).underlying!=asset)
                revert AssetMismatch();
        } else if(mode==DOLOMITE) {
            if(extra.length!=0||auxiliary.code.length==0||ICYV6DolomiteRouter(target).DOLOMITE_MARGIN()!=auxiliary||
                ICYV6Dolomite(auxiliary).getMarketTokenAddress(uint256(marketId))!=asset)revert AssetMismatch();
        } else revert UnsupportedMode();
    }

    function _value(bytes32 key) private view returns(uint256 amount) {
        MarketRef storage m=markets[key];
        if(m.target==address(0))return 0;
        amount=m.credit;
        if(m.mode==ERC4626) {
            return amount+ICYV6ERC4626(m.target).previewRedeem(m.trackedShares);
        }
        if(m.mode==BEEFY_V7) {
            uint256 shares=m.trackedShares;
            return amount+CYV6Math.mulDiv(shares,ICYV6Beefy(m.target).getPricePerFullShare(),SCALE);
        }
        if(m.mode==AAVE_V3)return amount+ICYV6AToken(m.auxiliary).balanceOf(address(this));
        if(m.mode==COMPOUND)return amount+ICYV6Comet(m.target).balanceOf(address(this));
        if(m.mode==AAVE_V4)return amount+ICYV6AaveSpoke(m.target).getUserSuppliedAssets(uint256(m.marketId),address(this));
        if(m.mode==MORPHO) {
            if(m.trackedShares==0)return amount;
            ICYV6Morpho.Market memory market=ICYV6Morpho(m.target).market(m.marketId);
            uint256 supplied=uint256(market.totalSupplyAssets);
            uint256 shares=uint256(market.totalSupplyShares);
            uint256 elapsed=block.timestamp-uint256(market.lastUpdate);
            // Morpho's raw market() excludes unaccrued lending interest and fee shares.
            if(elapsed!=0&&market.totalBorrowAssets!=0) {
                ICYV6Morpho.MarketParams memory params=ICYV6Morpho(m.target).idToMarketParams(m.marketId);
                if(params.irm!=address(0)){
                    uint256 rate=ICYV6Irm(params.irm).borrowRateView(params,market);
                    uint256 interest=CYV6Math.mulDiv(uint256(market.totalBorrowAssets),
                        CYV6Math.wTaylorCompounded(rate,elapsed),SCALE);
                    supplied+=interest;
                    if(market.fee!=0) {
                        uint256 feeAmount=CYV6Math.mulDiv(interest,uint256(market.fee),SCALE);
                        shares+=CYV6Math.mulDiv(feeAmount,shares+1e6,supplied-feeAmount+1);
                    }
                }
            }
            return amount+CYV6Math.mulDiv(m.trackedShares,supplied+1,shares+1e6);
        }
        if(m.mode==DOLOMITE) {
            ICYV6Dolomite.SignedWei memory w=ICYV6Dolomite(m.auxiliary).getAccountWei(
                ICYV6Dolomite.Account(address(this),0),uint256(m.marketId));
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
            uint256 beforeShares=ICYV6Token(m.target).balanceOf(address(this));
            if(m.mode==ERC4626)ICYV6ERC4626(m.target).deposit(amount,address(this));
            else ICYV6Beefy(m.target).deposit(amount);
            uint256 afterShares=ICYV6Token(m.target).balanceOf(address(this));
            if(afterShares<=beforeShares)revert InsufficientAssets();
            minted=afterShares-beforeShares;
            m.trackedShares+=minted;
        } else if(m.mode==AAVE_V3)ICYV6AaveV3(m.target).supply(asset,amount,address(this),0);
        else if(m.mode==COMPOUND)ICYV6Comet(m.target).supply(asset,amount);
        else if(m.mode==AAVE_V4)(minted,)=ICYV6AaveSpoke(m.target).supply(uint256(m.marketId),amount,address(this));
        else if(m.mode==MORPHO) {
            ICYV6Morpho.MarketParams memory p=abi.decode(extra,(ICYV6Morpho.MarketParams));
            (,minted)=ICYV6Morpho(m.target).supply(p,amount,0,address(this),"");
            m.trackedShares+=minted;
        } else if(m.mode==DOLOMITE)ICYV6DolomiteRouter(m.target).depositWei(0,0,uint256(m.marketId),amount,0);
        else revert UnsupportedMode();
    }
    function _withdraw(MarketRef storage m,uint256 amount,bytes memory extra) private {
        if(m.mode==ERC4626||m.mode==BEEFY_V7) {
            uint256 beforeShares=ICYV6Token(m.target).balanceOf(address(this));
            if(m.mode==ERC4626) {
                ICYV6ERC4626(m.target).withdraw(amount,address(this),address(this));
            }else{
                uint256 pps=ICYV6Beefy(m.target).getPricePerFullShare();
                if(pps==0)revert InsufficientAssets();
                uint256 shares=CYV6Math.mulDiv(amount,SCALE,pps);
                if(CYV6Math.mulDiv(shares,pps,SCALE)<amount)++shares;
                ICYV6Beefy(m.target).withdraw(shares);
            }
            uint256 afterShares=ICYV6Token(m.target).balanceOf(address(this));
            if(afterShares>=beforeShares||beforeShares-afterShares>m.trackedShares)revert InsufficientAssets();
            m.trackedShares-=beforeShares-afterShares;
        } else if(m.mode==AAVE_V3)ICYV6AaveV3(m.target).withdraw(asset,amount,address(this));
        else if(m.mode==COMPOUND)ICYV6Comet(m.target).withdraw(asset,amount);
        else if(m.mode==AAVE_V4)ICYV6AaveSpoke(m.target).withdraw(uint256(m.marketId),amount,address(this));
        else if(m.mode==MORPHO) {
            ICYV6Morpho.MarketParams memory p=abi.decode(extra,(ICYV6Morpho.MarketParams));
            (,uint256 burned)=ICYV6Morpho(m.target).withdraw(p,amount,0,address(this),address(this));
            if(burned>m.trackedShares)revert InsufficientAssets();
            m.trackedShares-=burned;
        } else if(m.mode==DOLOMITE)ICYV6DolomiteRouter(m.target).withdrawWei(0,0,uint256(m.marketId),amount,1);
        else revert UnsupportedMode();
    }

    function _release(MarketRef storage m,uint256 assets,bytes memory extra) private {
        if(assets<=m.credit) {
            m.credit-=assets;
            return;
        }
        uint256 needed=assets-m.credit;
        uint256 beforeAssets=ICYV6Token(asset).balanceOf(address(this));
        _withdraw(m,needed,extra);
        uint256 received=ICYV6Token(asset).balanceOf(address(this))-beforeAssets;
        if(received<needed)revert InsufficientAssets();
        m.credit=m.credit+received-assets;
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
        uint256 previous=ICYV6Parent(parentVault).allocation(_capId(key));
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
        uint256 previous=ICYV6Parent(parentVault).allocation(_capId(key));
        _release(m,assets,extra);
        (ids,change)=_response(key,previous);
        // Remove completely exited positions; cap/ownership rights stay in Vault V2.
        if(m.trackedShares==0&&m.credit==0&&_value(key)==0){
            uint256 index=indexPlusOne[key]-1;
            uint256 last=active.length-1;
            if(index!=last){
                bytes32 swapKey=active[last];active[index]=swapKey;
                indexPlusOne[swapKey]=index+1;
            }
            active.pop();delete indexPlusOne[key];delete markets[key];
            emit ExitedMarket(key);
        }
    }
}

// @notice Optional minimal paid deployment entrypoint. Not a vault.
contract CurveYieldOmniAdapterDeployerV6 {
    address private constant INITIAL_CURVEYIELD_SAFE = 0x47623C62f281807D615eeb4A2CEee9d97F9D3C49;

    address public immutable vaultFactory;
    uint256 public immutable maximumCreationFee;
    address public owner;
    address payable public feeRecipient;
    uint256 public creationFee;
    mapping(address vault => address adapter) public adapterOf;

    error NotOwner();
    error InvalidAddress();
    error InvalidVault();
    error AlreadyCreated();
    error FeeTooHigh();
    error IncorrectFee(uint256 supplied, uint256 required);
    error NativeFeeTransferFailed();

    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event OmniAdapterCreated(address indexed parentVault, address indexed adapter, uint256 nativeFee, address indexed feeReceiver);

    /// @param vaultFactory_ Existing native Morpho Vault V2 factory on the target chain.
    /// @param maximumCreationFeeWei_ Absolute fee ceiling, in native gas-token wei.
    ///        Fraxtal deployment parameter: 1 ether (1 native FRAX, 10**18 wei).
    /// @dev Initial owner & fee recipient = CurveYield Safe. Fee starts at 0.
    ///      The owner can set the fee to any amount <= immutable maximum.
    constructor(address vaultFactory_, uint256 maximumCreationFeeWei_) {
        if(vaultFactory_.code.length == 0) revert InvalidAddress();
        vaultFactory = vaultFactory_;
        maximumCreationFee = maximumCreationFeeWei_;
        owner = INITIAL_CURVEYIELD_SAFE;
        feeRecipient = payable(INITIAL_CURVEYIELD_SAFE);
    }

    modifier onlyOwner() {
        if(msg.sender != owner) revert NotOwner();
        _;
    }

    function setCreationFee(uint256 newFee) external onlyOwner {
        if(newFee > maximumCreationFee) revert FeeTooHigh();
        emit FeeUpdated(creationFee, newFee);
        creationFee = newFee;
    }

    function setFeeRecipient(address payable newRecipient) external onlyOwner {
        if(newRecipient == address(0)) revert InvalidAddress();
        emit FeeRecipientUpdated(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    /// @dev Ownership administration ONLY for fee/deployer settings.
    ///      It does not confer any privileges over Vault V2 or deployed adapters.
    function transferOwnership(address nextOwner) external onlyOwner {
        if(nextOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, nextOwner);
        owner = nextOwner;
    }

    /// @notice Deploy one adapter for an existing official Vault V2.
    /// @dev Native fee is transferred immediately to the configured recipient.
    ///      This contract does not custody Vault V2 assets or approve markets.
    function createAdapter(address vault) external payable returns (address deployed) {
        uint256 fee = creationFee;
        if(msg.value != fee) revert IncorrectFee(msg.value, fee);
        if(adapterOf[vault] != address(0)) revert AlreadyCreated();
        if(!ICYV6Factory(vaultFactory).isVaultV2(vault)) revert InvalidVault();
        deployed = address(new CurveYieldOmniAdapterV6(vault));
        adapterOf[vault] = deployed;
        if(fee != 0) {
            (bool sent,) = feeRecipient.call{value: fee}("");
            if(!sent) revert NativeFeeTransferFailed();
        }
        emit OmniAdapterCreated(vault, deployed, fee, feeRecipient);
    }
}
