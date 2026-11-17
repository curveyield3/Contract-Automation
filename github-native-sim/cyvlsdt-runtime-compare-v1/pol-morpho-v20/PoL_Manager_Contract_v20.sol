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

pragma solidity ^0.8.28;

/// @notice Single-custody PoL manager (v20). Morpho V1 replaces Euler; OmniRouter protects swaps.
/// @dev One-time post-deployment configuration for the Curve pool and Uniswap v3 NFT; five ERC4626 positions.
///      Curve/Uniswap liquidity bounds are read from a separately deployed oracle contract.
interface IPoL20 {
    function balanceOf(address) external view returns (uint256);
    function decimals() external view returns (uint8);
    function transfer(address,uint256) external returns (bool);
    function approve(address,uint256) external returns (bool);
}
interface IPoL4626 is IPoL20 {
    function asset() external view returns (address);
    function deposit(uint256,address) external returns (uint256);
    function redeem(uint256,address,address) external returns (uint256);
    function convertToAssets(uint256) external view returns (uint256);
    function convertToShares(uint256) external view returns (uint256);
    function maxRedeem(address) external view returns (uint256);
}
interface IPoLYearn is IPoL4626 {
    function redeem(uint256,address,address,uint256) external returns (uint256);
    function maxRedeem(address,uint256) external view returns (uint256);
}
interface IPoLRouter {
    function swap(address,address,uint256) external returns (uint256);
    function price_oracle(address,address) external view returns (uint256);
}
interface IPoLGauge {
    function deposit(uint256) external;
    function withdraw(uint256) external;
    function claim_rewards() external;
}
interface IPoLCurve {
    function coins(uint256) external view returns (address);
    function price_oracle(uint256) external view returns (uint256);
    function remove_liquidity_one_coin(uint256,int128,uint256) external returns(uint256);
}
interface IPoLCurveNG {
    function add_liquidity(uint256[] calldata,uint256) external returns (uint256);
}
/// @notice Read-only bounds from CurvePairOracleBoundsV6 (a separate, owner-configured deployment).
interface IPoLLiquidityBounds {
    function quoteDeposit(address pool,uint8 coinIndex,uint256 amount,uint16 slippageBps)
        external view returns(uint256 estimate,uint256 minOut);
    function quoteWithdraw(address pool,uint8 coinIndex,uint256 lpAmount,uint16 slippageBps)
        external view returns(uint256 estimate,uint256 minOut);
    function quoteUniV3Deposit(address positionManager,uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired)
        external view returns(uint128 estimatedLiquidity,uint128 minLiquidity,uint256 amount0Used,uint256 amount1Used,uint256 minAmount0Used,uint256 minAmount1Used);
    function quoteUniV3Withdraw(address positionManager,uint256 tokenId,uint16 percentBps)
        external view returns(uint128 liquidityToBurn,uint256 amount0,uint256 amount1,uint256 minAmount0,uint256 minAmount1);
}
interface IPoLNft {
    struct Position {
        uint96 nonce;address operator;address token0;address token1;uint24 fee;
        int24 tickLower;int24 tickUpper;uint128 liquidity;
        uint256 feeGrowthInside0LastX128;uint256 feeGrowthInside1LastX128;
        uint128 tokensOwed0;uint128 tokensOwed1;
    }
    struct Increase {uint256 tokenId;uint256 amount0Desired;uint256 amount1Desired;uint256 amount0Min;uint256 amount1Min;uint256 deadline;}
    struct Decrease {uint256 tokenId;uint128 liquidity;uint256 amount0Min;uint256 amount1Min;uint256 deadline;}
    struct Collect {uint256 tokenId;address recipient;uint128 amount0Max;uint128 amount1Max;}
    function positions(uint256) external view returns (Position memory);
    function ownerOf(uint256) external view returns (address);
    function increaseLiquidity(Increase calldata) external payable returns (uint128,uint256,uint256);
    function decreaseLiquidity(Decrease calldata) external payable returns (uint256,uint256);
    function collect(Collect calldata) external payable returns (uint256,uint256);
    function safeTransferFrom(address,address,uint256) external;
}

contract PoLManager {
    uint256 private constant BPS=10_000;
    uint256 private constant WAD=1e18;
    uint256 private entered=1;

    struct DeployConfig {
        address owner;
        address[3] yearnVaults;
        uint8 sdtYearnIndex;
        address[2] eulerVaults;
        uint8 sdtEulerIndex;
        address crv;
        address cyvlSDT;
        address sdt;
        address usdc;
        address omniRouter;
    }
    // Source/destination: 0 Curve LP/gauge, 1 fixed Uniswap NFT, 2-4 Yearn, 5-6 Morpho V1.
    // source amount is Curve LP, ERC4626 shares, or NFT liquidity basis points (1..10000).
    struct Migration {
        uint8 source;uint8 destination;uint256 amount;
        uint256 minDestinationShares;
    }
    /// @notice Configurable buy levels, with cumulative *absolute* SDT spend limits.
    /// @dev Prices are SDT per cyvlSDT (1e18); no level has a default value.
    struct BuyLevel { uint256 maxPriceWad; uint256 cumulativeSDT; }

    address public owner;
    address public pendingOwner;
    address public guardian;
    bool public paused;
    mapping(address=>bool) public operators;
    // Token/spender approvals are set once during deployment or reward configuration.
    // Fixed protocol operations do not check or update allowances.
    mapping(address=>mapping(address=>bool)) private allowanceInitialized;

    // Each position's first nonzero configuration is permanent.
    address public curvePool;
    address public curveLp;
    address public curveGauge;
    address private immutable crv;

    address public uniNftManager;
    uint256 public uniTokenId;
    address private uniToken0;
    address private uniToken1;
    // Amounts owed to the pre-transfer owner at NFT receipt are not new managed profits.
    uint256 private initialOwed0;
    uint256 private initialOwed1;
    uint256 public pendingUniCompound0;
    uint256 public pendingUniCompound1;

    address[5] public vaults;
    address[5] private assets;
    uint256[5] private shareUnits;
    uint256[5] private highWatermarkPPS;
    uint256[5] private accruedFeeShares;
    uint8 public immutable sdtYearnIndex;
    uint8 public immutable sdtEulerIndex;
    address private immutable cyvlSDT;
    uint256 private immutable sdtUnit;
    uint256 private immutable cyvlUnit;
    address public immutable sdt;
    address private immutable usdc;
    address public immutable omniRouter;
    address public liquidityBounds;
    uint16 public curveSlippageBps=200;
    uint16 public profitFeeBps;
    address public profitRecipient;
    uint16 private maxYearnLossBps=100;
    uint16 private maxEulerLossBps=100;
    uint16[7] public allocations;
    uint8 public allocationEnabledMask;
    uint8 public harvestEnabledMask;
    BuyLevel[5] public buyLevels;
    uint256 public buySpentSDT;
    uint8 public activeBuyTier;

    event ProfitPaid(address recipient,uint256 amountSDT);
    event AllocationSet(uint16[7] allocations);
    event ModuleEnabled(uint8 indexed position,bool allocation,bool harvesting);
    event VaultConfigured(uint8 indexed slot,address vault,address asset);
    event Migrated(uint8 source,uint8 destination,uint256 input,uint256 output);
    event CyvlSDTBought(uint8 indexed tier,uint256 priceWad,uint256 yearnShares,uint256 eulerShares,uint256 received);
    event BuyLevelsUpdated();
    event LiquidityBoundsConfigured(address indexed oracle);
    event CurvePoolConfigured(address indexed pool,address indexed lp);
    event CurveGaugeConfigured(address indexed gauge);
    event UniswapPositionConfigured(address indexed manager,uint256 indexed tokenId);
    event CurveSlippageConfigured(uint16 bps);
    event UniLiquidity(uint8 action,uint256 amount0,uint256 amount1,uint128 liquidity);
    error Unauthorized();error Invalid();error State();error Slippage();
    modifier onlyOwner(){if(msg.sender!=owner)revert Unauthorized();_;}
    modifier onlyOperator(){if(msg.sender!=owner&&!operators[msg.sender])revert Unauthorized();_;}
    modifier active(){if(paused)revert State();_;}
    modifier guard(){if(entered!=1)revert State();entered=2;_;entered=1;}

    constructor(DeployConfig memory c) {
        if(c.owner==address(0)||c.sdt.code.length==0||c.usdc.code.length==0||
           c.usdc==c.sdt||c.omniRouter.code.length==0||c.cyvlSDT.code.length==0||
           c.crv.code.length==0||c.sdtYearnIndex>2||c.sdtEulerIndex>1)revert Invalid();
        owner=c.owner;profitRecipient=c.owner;
        sdt=c.sdt;usdc=c.usdc;omniRouter=c.omniRouter;cyvlSDT=c.cyvlSDT;crv=c.crv;
        uint8 d0=IPoL20(c.sdt).decimals();uint8 d1=IPoL20(c.cyvlSDT).decimals();
        if(d0>30||d1>30)revert Invalid();
        sdtUnit=10**uint256(d0);cyvlUnit=10**uint256(d1);
        sdtYearnIndex=c.sdtYearnIndex;sdtEulerIndex=c.sdtEulerIndex;
        // Optional Yearn/Morpho V1 vaults can still be configured on deployment or through setVault.
        for(uint8 i;i<5;++i){
            address v=i<3?c.yearnVaults[i]:c.eulerVaults[i-3];
            if(v!=address(0))_configureVault(i,v);
        }
        _approveOnce(c.sdt,c.omniRouter);
        _approveOnce(c.usdc,c.omniRouter);
        _approveOnce(c.crv,c.omniRouter);
    }

    /// @notice Bind Curve's SDT/cyvlSDT three-coin pool and LP token once, after deployment.
    function configureCurvePool(address pool,address lp) external onlyOwner guard {
        if(curvePool!=address(0)||pool.code.length==0||lp.code.length==0)revert Invalid();
        // The manager's liquidity functions use SDT at index 0 and cyvlSDT at index 1.
        if(IPoLCurve(pool).coins(0)!=sdt||IPoLCurve(pool).coins(1)!=cyvlSDT)revert Invalid();
        address thirdCoin=IPoLCurve(pool).coins(2);
        if(thirdCoin==address(0)||thirdCoin==sdt||thirdCoin==cyvlSDT)revert Invalid();
        curvePool=pool;curveLp=lp;
        _approveOnce(sdt,pool);
        _approveOnce(lp,pool);
        allocationEnabledMask|=1;
        harvestEnabledMask|=1;
        emit CurvePoolConfigured(pool,lp);
    }

    /// @notice Optional gauge is separately bound once; the pool need not wait for gauge deployment.
    function configureCurveGauge(address gauge) external onlyOwner guard {
        if(curvePool==address(0)||curveGauge!=address(0)||gauge.code.length==0)revert Invalid();
        curveGauge=gauge;
        _approveOnce(curveLp,gauge);
        emit CurveGaugeConfigured(gauge);
    }

    /// @notice Bind the one existing Uniswap v3 position once, before its NFT is transferred here.
    function configureUniswapPosition(address manager,uint256 tokenId) external onlyOwner guard {
        if(uniNftManager!=address(0)||manager.code.length==0||tokenId==0)revert Invalid();
        IPoLNft.Position memory pos=IPoLNft(manager).positions(tokenId);
        if(pos.token0.code.length==0||pos.token1.code.length==0||pos.tickLower>=pos.tickUpper)revert Invalid();
        if(!((pos.token0==sdt&&pos.token1==cyvlSDT)||
             (pos.token1==sdt&&pos.token0==cyvlSDT)))revert Invalid();
        uniNftManager=manager;uniTokenId=tokenId;
        uniToken0=pos.token0;uniToken1=pos.token1;
        // Preserve the original v18 allowances for NFT-derived swap/fee conversions.
        _approveOnce(pos.token0,omniRouter);
        _approveOnce(pos.token1,omniRouter);
        _approveOnce(pos.token0,manager);
        _approveOnce(pos.token1,manager);
        emit UniswapPositionConfigured(manager,tokenId);
    }

    function proposeOwner(address next) external onlyOwner {if(next==address(0))revert Invalid();pendingOwner=next;}
    function acceptOwner() external {if(msg.sender!=pendingOwner)revert Unauthorized();owner=msg.sender;pendingOwner=address(0);}
    function setOperator(address who,bool on) external onlyOwner {operators[who]=on;}
    function setGuardian(address who) external onlyOwner {guardian=who;}
    function setPaused(bool on) external {if(msg.sender!=owner&&!(on&&msg.sender==guardian))revert Unauthorized();paused=on;}
    function setSafetyLimits(uint16 yearn,uint16 euler) external onlyOwner {
        if(yearn>1000||euler>1000)revert Invalid();
        maxYearnLossBps=yearn;maxEulerLossBps=euler;
    }
    function setProfitFee(uint16 bps) external onlyOwner {
        if(bps>5000)revert Invalid();
        // Capture fees at the old rate before a change, so fee-rate changes are not retroactive.
        for(uint8 i;i<5;++i)if(vaults[i]!=address(0))_accrue(i);
        profitFeeBps=bps;
    }
    function setProfitRecipient(address to) external onlyOwner {if(to==address(0))revert Invalid();profitRecipient=to;}
    /// @notice Set after the external bounds contract has been deployed; zero pauses guarded liquidity operations.
    function setLiquidityBounds(address oracle) external onlyOwner {
        if(oracle!=address(0)&&oracle.code.length==0)revert Invalid();
        liquidityBounds=oracle;
        emit LiquidityBoundsConfigured(oracle);
    }
    /// @notice Curve quote haircut; Uniswap v3 has its own fixed 2% tolerance in Bounds v6.
    function setCurveSlippageBps(uint16 bps) external onlyOwner {
        if(bps>2000)revert Invalid();
        curveSlippageBps=bps;
        emit CurveSlippageConfigured(bps);
    }
    function _bounds() private view returns(IPoLLiquidityBounds){
        address oracle=liquidityBounds;
        if(oracle==address(0))revert State();
        return IPoLLiquidityBounds(oracle);
    }
    function setAllocations(uint16[7] calldata bps) external onlyOwner {
        uint256 total;for(uint8 i;i<7;++i)total+=bps[i];
        if(total!=BPS||bps[1]!=0)revert Invalid();allocations=bps;emit AllocationSet(bps);
    }
    /// @notice Independent allocation and scheduled-harvest permissions for each position.
    /// @dev Disabling a position never blocks withdrawals, migration-out, or mandatory fee booking.
    function setModuleEnabled(uint8 position,bool allocation,bool harvesting) external onlyOwner {
        if(position>=7||(position==1&&allocation)||((allocation||harvesting)&&!_configured(position)))revert Invalid();
        uint8 bit=uint8(1)<<position;
        if(allocation)allocationEnabledMask|=bit;
        else allocationEnabledMask&=~bit;
        if(harvesting)harvestEnabledMask|=bit;
        else harvestEnabledMask&=~bit;
        emit ModuleEnabled(position,allocation,harvesting);
    }
    function _configured(uint8 position) private view returns(bool){
        if(position==0)return curvePool!=address(0);
        if(position==1)return uniNftManager!=address(0);
        return position<7&&vaults[position-2]!=address(0);
    }
    /// @notice Add, remove, or replace an empty Yearn (0-2) or Morpho V1 (3-4) vault.
    /// @dev Existing vault assets/fee shares must be fully withdrawn/harvested first.
    function setVault(uint8 slot,address v) external onlyOwner guard {_configureVault(slot,v);}
    function _configureVault(uint8 slot,address v) private {
        if(slot>=5)revert Invalid();
        address prior=vaults[slot];
        if(prior==v)return;
        if(prior!=address(0)){
            if(_balance(prior)!=0||accruedFeeShares[slot]!=0)revert State();
            _call(assets[slot],abi.encodeWithSelector(IPoL20.approve.selector,prior,0));
            allowanceInitialized[assets[slot]][prior]=false;
        }
        uint8 bit=uint8(1)<<(slot+2);
        if(v==address(0)){
            delete vaults[slot];delete assets[slot];
            delete shareUnits[slot];delete highWatermarkPPS[slot];
            allocationEnabledMask&=~bit;harvestEnabledMask&=~bit;
        }else{
            if(v.code.length==0)revert Invalid();
            for(uint8 j;j<5;++j)if(j!=slot&&vaults[j]==v)revert Invalid();
            address asset=IPoL4626(v).asset();
            if(asset.code.length==0)revert Invalid();
            uint8 dec=IPoL20(v).decimals();if(dec>30)revert Invalid();
            uint256 unit=10**uint256(dec);
            uint256 p=IPoL4626(v).convertToAssets(unit);if(p==0)revert Invalid();
            vaults[slot]=v;assets[slot]=asset;shareUnits[slot]=unit;highWatermarkPPS[slot]=p;
            _approveOnce(asset,omniRouter);
            _approveOnce(asset,v);
            allocationEnabledMask|=bit;harvestEnabledMask|=bit;
        }
        emit VaultConfigured(slot,v,assets[slot]);
    }

    function _call(address token,bytes memory data) private {
        (bool ok,bytes memory r)=token.call(data);
        if(!ok||(r.length!=0&&(r.length!=32||!abi.decode(r,(bool)))))revert Invalid();
    }
    function _approveOnce(address token,address spender) private {
        if(allowanceInitialized[token][spender])return;
        allowanceInitialized[token][spender]=true;
        _call(token,abi.encodeWithSelector(IPoL20.approve.selector,spender,type(uint256).max));
    }
    function _send(address token,address to,uint256 amount) private {
        _call(token,abi.encodeWithSelector(IPoL20.transfer.selector,to,amount));
    }
    function _balance(address token) private view returns(uint256){return IPoL20(token).balanceOf(address(this));}
    function _min(uint256 a,uint256 b) private pure returns(uint256){return a<b?a:b;}
    function _swap(address from,address to,uint256 amount) private returns(uint256 received){
        if(amount==0||from==to)revert Invalid();
        received=IPoLRouter(omniRouter).swap(from,to,amount);
        if(received==0)revert Slippage();
    }
    function _convert(address from,address to,uint256 amount) private returns(uint256){
        return amount==0?0:from==to?amount:_swap(from,to,amount);
    }
    function _free(address token) private view returns(uint256 amount){
        amount=_balance(token);
        if(token==uniToken0)amount-=pendingUniCompound0;
        if(token==uniToken1)amount-=pendingUniCompound1;
    }
    // All Curve liquidity operations use SDT at index 0 and the separately configured
    // historical-price bounds provider. No local Curve spot quote or oracle math.
    function _curveDeposit(uint256 amount) private returns(uint256 lp){
        if(amount==0||curvePool==address(0))revert Invalid();
        (,uint256 floor)=_bounds().quoteDeposit(curvePool,0,amount,curveSlippageBps);
        if(floor==0)revert Slippage();
        uint256[] memory amounts=new uint256[](3);
        amounts[0]=amount;
        lp=IPoLCurveNG(curvePool).add_liquidity(amounts,floor);
        if(lp<floor)revert Slippage();
        if(curveGauge!=address(0))IPoLGauge(curveGauge).deposit(lp);
    }
    function _curveWithdraw(uint256 lp,bool fromGauge) private returns(uint256 amount){
        if(lp==0||curvePool==address(0)||(fromGauge&&curveGauge==address(0)))revert Invalid();
        (,uint256 floor)=_bounds().quoteWithdraw(curvePool,0,lp,curveSlippageBps);
        if(floor==0)revert Slippage();
        if(fromGauge)IPoLGauge(curveGauge).withdraw(lp);
        amount=IPoLCurve(curvePool).remove_liquidity_one_coin(lp,0,floor);
        if(amount<floor)revert Slippage();
    }
    /// @notice SDT-only Curve operations, bounded by the external Curve EMA/rate model.
    function depositCurve(uint256 amount) external onlyOperator active guard returns(uint256){
        if(amount>_free(sdt))revert Invalid();
        return _curveDeposit(amount);
    }
    function withdrawCurve(uint256 lp,bool fromGauge) external onlyOperator guard returns(uint256){
        return _curveWithdraw(lp,fromGauge);
    }

    function currentPPS(uint8 slot) public view returns(uint256){
        if(slot>=5||vaults[slot]==address(0))revert Invalid();
        return IPoL4626(vaults[slot]).convertToAssets(shareUnits[slot]);
    }
    // Morpho V1's ERC-4626 maxRedeem() already accounts for liquidity across its withdraw queue.
    // Morpho V2 intentionally returns zero from maxRedeem and is NOT supported by this integration.
    function _maxRedeem(uint8 slot) private view returns(uint256 shares){
        address vault=vaults[slot];
        if(slot<3)return IPoLYearn(vault).maxRedeem(address(this),maxYearnLossBps);
        shares=IPoL4626(vault).maxRedeem(address(this));
    }
    function _accrue(uint8 slot) private {
        uint256 p=currentPPS(slot);uint256 h=highWatermarkPPS[slot];
        uint256 held=_balance(vaults[slot]);
        uint256 reserved=accruedFeeShares[slot];
        if(held<reserved)revert State();
        if(held==reserved){if(p!=h)highWatermarkPPS[slot]=p;return;}
        if(p>h){
            if(profitFeeBps!=0)accruedFeeShares[slot]=reserved+(held-reserved)*(p-h)*profitFeeBps/(p*BPS);
            highWatermarkPPS[slot]=p;
        }
    }
    function _vaultDeposit(uint8 slot,uint256 amount,uint256 minShares) private returns(uint256 shares){
        if(slot>=5||vaults[slot]==address(0)||amount==0)revert Invalid();
        _accrue(slot);
        address v=vaults[slot];
        shares=IPoL4626(v).deposit(amount,address(this));
        if(shares==0||shares<minShares)revert Slippage();
    }
    function _vaultRedeemRaw(uint8 slot,uint256 shares,uint256 minAssets) private returns(uint256 assetsOut){
        if(shares==0)revert Invalid();
        address v=vaults[slot];
        uint256 expected=IPoL4626(v).convertToAssets(shares);
        assetsOut=slot<3
            ?IPoLYearn(v).redeem(shares,address(this),address(this),maxYearnLossBps)
            :IPoL4626(v).redeem(shares,address(this),address(this));
        uint256 loss=slot<3?maxYearnLossBps:maxEulerLossBps;
        if(assetsOut==0||assetsOut<minAssets||assetsOut<expected*(BPS-loss)/BPS)revert Slippage();
    }
    function _vaultRedeem(uint8 slot,uint256 shares,uint256 minAssets) private returns(uint256){
        if(slot>=5||vaults[slot]==address(0))revert Invalid();
        _accrue(slot);
        if(shares>_balance(vaults[slot])-accruedFeeShares[slot]||shares>_maxRedeem(slot))revert Invalid();
        return _vaultRedeemRaw(slot,shares,minAssets);
    }
    function depositVault(uint8 slot,uint256 amount,uint256 minShares) external onlyOperator active guard returns(uint256){
        if(slot>=5||vaults[slot]==address(0)||amount>_free(assets[slot]))revert Invalid();
        return _vaultDeposit(slot,amount,minShares);
    }
    function redeemVault(uint8 slot,uint256 shares,uint256 minAssets) external onlyOperator guard returns(uint256){
        return _vaultRedeem(slot,shares,minAssets);
    }

    function _checkNft() private view returns(IPoLNft.Position memory p){
        p=IPoLNft(uniNftManager).positions(uniTokenId);
    }
    /// @notice Only accepts the configured pre-existing position; no mint/range-changing function exists.
    function onERC721Received(address,address,uint256 id,bytes calldata) external returns(bytes4){
        if(msg.sender!=uniNftManager||id!=uniTokenId)revert Invalid();
        IPoLNft.Position memory p=IPoLNft(uniNftManager).positions(id);
        initialOwed0=p.tokensOwed0;initialOwed1=p.tokensOwed1;
        return this.onERC721Received.selector;
    }
    function _uniAdd(uint256 a0,uint256 a1) private returns(uint128 liquidity,uint256 used0,uint256 used1){
        if(a0+a1==0||IPoLNft(uniNftManager).ownerOf(uniTokenId)!=address(this))revert Invalid();
        (,uint128 floor,,,uint256 min0,uint256 min1)=
            _bounds().quoteUniV3Deposit(uniNftManager,uniTokenId,a0,a1);
        if(floor==0)revert Slippage();
        (liquidity,used0,used1)=IPoLNft(uniNftManager).increaseLiquidity(
            IPoLNft.Increase(uniTokenId,a0,a1,min0,min1,block.timestamp));
        if(liquidity<floor)revert Slippage();
        emit UniLiquidity(1,used0,used1,liquidity);
    }
    function addUniLiquidity(uint256 amount0,uint256 amount1)
        external onlyOperator active guard returns(uint128 liquidity,uint256 used0,uint256 used1){
        if(amount0>_balance(uniToken0)||amount1>_balance(uniToken1))revert Invalid();
        (liquidity,used0,used1)=_uniAdd(amount0,amount1);
        pendingUniCompound0-=_min(used0,pendingUniCompound0);
        pendingUniCompound1-=_min(used1,pendingUniCompound1);
    }
    function _harvestUni() private returns(uint256 paid){
        (uint256 got0,uint256 got1)=IPoLNft(uniNftManager).collect(IPoLNft.Collect(uniTokenId,address(this),type(uint128).max,type(uint128).max));
        uint256 old0=_min(got0,initialOwed0);uint256 old1=_min(got1,initialOwed1);
        initialOwed0-=old0;initialOwed1-=old1;
        uint256 earned0=got0-old0;uint256 earned1=got1-old1;
        uint256 fee0=earned0*profitFeeBps/BPS;uint256 fee1=earned1*profitFeeBps/BPS;
        pendingUniCompound0+=earned0-fee0;pendingUniCompound1+=earned1-fee1;
        paid=_convert(uniToken0,sdt,fee0)+_convert(uniToken1,sdt,fee1);
    }
    function _pay(uint256 amount) private {if(amount!=0){_send(sdt,profitRecipient,amount);emit ProfitPaid(profitRecipient,amount);}}
    function _uniRemove(uint256 bps) private returns(uint256 a0,uint256 a1){
        if(bps==0||bps>BPS)revert Invalid();
        (uint128 liquidity,,,uint256 min0,uint256 min1)=
            _bounds().quoteUniV3Withdraw(uniNftManager,uniTokenId,uint16(bps));
        if(liquidity==0)revert Slippage();
        // Harvest first, so every subsequent collected token is principal from THIS withdrawal.
        _pay(_harvestUni());
        (a0,a1)=IPoLNft(uniNftManager).decreaseLiquidity(
            IPoLNft.Decrease(uniTokenId,liquidity,min0,min1,block.timestamp));
        if(a0<min0||a1<min1)revert Slippage();
        if(a0>type(uint128).max||a1>type(uint128).max)revert Invalid();
        (uint256 c0,uint256 c1)=IPoLNft(uniNftManager).collect(IPoLNft.Collect(uniTokenId,address(this),uint128(a0),uint128(a1)));
        if(c0!=a0||c1!=a1)revert State();
        emit UniLiquidity(2,a0,a1,liquidity);
    }
    function removeUniLiquidity(uint256 bps) external onlyOperator guard returns(uint256,uint256){
        return _uniRemove(bps);
    }
    function withdrawUniNFT(address recipient) external onlyOwner guard {
        if(recipient==address(0))revert Invalid();
        _checkNft();IPoLNft(uniNftManager).safeTransferFrom(address(this),recipient,uniTokenId);
        initialOwed0=0;initialOwed1=0;
        pendingUniCompound0=0;pendingUniCompound1=0;
    }

    function _invest(uint8 dest,address tokenA,uint256 amountA,address tokenB,uint256 amountB,uint256 minShares)
        private returns(uint256 units){
        if(dest>=7||dest==1||amountA+amountB==0)revert Invalid();
        if(dest==0){
            units=_curveDeposit(_convert(tokenA,sdt,amountA)+_convert(tokenB,sdt,amountB));
        }else{
            uint8 slot=dest-2;
            units=_vaultDeposit(slot,_convert(tokenA,assets[slot],amountA)+_convert(tokenB,assets[slot],amountB),minShares);
        }
    }
    /// @notice Explicitly allocate current idle balance; no passive token scanning or shadow ledger.
    /// @dev NFT automatic allocation still requires a ratio-sizing adapter; direct NFT adds/removals
    ///      already obtain their TWAP-derived minimums from the external bounds provider.
    function allocateFunds(address token,uint256 amount)
        external onlyOperator active guard {
        if((token!=sdt&&token!=usdc)||amount==0||amount>_free(token))revert Invalid();
        uint8 mask=allocationEnabledMask;
        uint8 last;uint256 total;
        for(uint8 i;i<7;++i)if((mask&(uint8(1)<<i))!=0&&allocations[i]!=0){
            total+=allocations[i];last=i;
        }
        if(total==0)revert State();
        uint256 left=amount;
        for(uint8 i;i<7;++i){
            if((mask&(uint8(1)<<i))==0||allocations[i]==0)continue;
            uint256 part=i==last?left:amount*allocations[i]/total;
            if(i!=last)left-=part;
            if(part!=0)_invest(i,token,part,address(0),0,0);
        }
    }
    function migrate(Migration calldata m) external onlyOperator active guard returns(uint256 result){
        if(m.source>=7||m.destination>=7||m.destination==1||m.source==m.destination||m.amount==0)revert Invalid();
        address a;address b;uint256 x;uint256 y;
        if(m.source==0){
            uint256 idle=_balance(curveLp);
            if(m.amount>idle){if(curveGauge==address(0))revert Invalid();IPoLGauge(curveGauge).withdraw(m.amount-idle);}
            a=sdt;x=_curveWithdraw(m.amount,false);
        }else if(m.source==1){
            (x,y)=_uniRemove(m.amount);
            a=uniToken0;b=uniToken1;
        }else{
            uint8 slot=m.source-2;a=assets[slot];x=_vaultRedeem(slot,m.amount,0);
        }
        result=_invest(m.destination,a,x,b,y,m.minDestinationShares);
        emit Migrated(m.source,m.destination,m.amount,result);
    }

    function _harvestCurve() private returns(uint256 paid){
        if(curveGauge==address(0))return 0;
        uint256 before_=_balance(crv);
        IPoLGauge(curveGauge).claim_rewards();
        uint256 reward=_balance(crv)-before_;
        if(reward==0)return 0;
        uint256 cut=reward*profitFeeBps/BPS;
        paid=_convert(crv,sdt,cut);
        if(reward>cut)_curveDeposit(_convert(crv,sdt,reward-cut));
    }
    function _harvestVault(uint8 slot) private returns(uint256 paid){
        if(vaults[slot]==address(0))return 0;
        _accrue(slot);
        uint256 due=accruedFeeShares[slot];
        if(due==0)return 0;
        uint256 shares=_min(due,_maxRedeem(slot));
        if(shares==0)return 0;
        accruedFeeShares[slot]=due-shares;
        paid=_convert(assets[slot],sdt,_vaultRedeemRaw(slot,shares,0));
    }
    function _harvestPosition(uint8 position) private returns(uint256){
        if(position==0)return _harvestCurve();
        if(position==1)return _harvestUni();
        return _harvestVault(position-2);
    }
    /// @notice Harvest only components enabled for harvesting; no unnecessary calls to inactive modules.
    /// @notice Selected bits harvest only enabled modules; 0x7f harvests all.
    function harvest(uint8 positions) external onlyOperator active guard returns(uint256 paid){
        uint8 mask=positions&harvestEnabledMask;
        for(uint8 i;i<7;++i)if((mask&(uint8(1)<<i))!=0)paid+=_harvestPosition(i);
        _pay(paid);
    }

    /// @notice Five optional, descending buy-price thresholds and ascending cumulative SDT budgets.
    /// @dev Both arrays default to all zeros. Unset levels do not trigger. Set configured
    ///      levels contiguously from index zero; unconfigured trailing entries remain zero.
    function setBuyLevels(uint256[5] calldata prices,uint256[5] calldata cumulativeSDT) external onlyOwner {
        uint256 lastPrice=type(uint256).max;
        uint256 lastCap;
        bool ended;
        for(uint8 i;i<5;++i){
            uint256 price=prices[i];uint256 cap=cumulativeSDT[i];
            if(price==0){
                if(cap!=0)revert Invalid();
                ended=true;
            }else{
                if(ended||price>=lastPrice||cap<=lastCap)revert Invalid();
                lastPrice=price;lastCap=cap;
            }
            buyLevels[i]=BuyLevel(price,cap);
        }
        activeBuyTier=0;
        emit BuyLevelsUpdated();
    }
    /// @notice The selected SDT Yearn and Morpho V1 sources are pinned in DeployConfig;
    ///         other SDT vaults are never consumed by this function.
    function _buySources() private view returns(uint8 y,uint8 e){
        y=sdtYearnIndex;e=sdtEulerIndex+3;
        if(vaults[y]==address(0)||vaults[e]==address(0)||assets[y]!=sdt||assets[e]!=sdt)revert State();
    }
    function buySourceVaults() external view returns(address yearn,address euler){
        (uint8 y,uint8 e)=_buySources();return(vaults[y],vaults[e]);
    }
    /// @notice Explicitly reset cumulative spending to zero for a fresh budget epoch.
    /// @dev Owner control prevents public callers from refreshing their own spending limits.
    function resetSwapRateAllocationWatermark() external onlyOwner {
        buySpentSDT=0;activeBuyTier=0;
    }
    /// @notice StableSwap-NG: coin 1 priced in coin 0, so this is SDT per cyvlSDT.
    /// @dev The intended pool is SDT=coin0 and cyvlSDT=coin1; no runtime order checks.
    function buyPrice() public view returns(uint256){
        if(curvePool==address(0))revert State();
        return IPoLCurve(curvePool).price_oracle(0);
    }
    /// @notice Permissionless SDT => cyvlSDT buy, with one cumulative SDT spending ceiling.
    /// @dev Uses Morpho V1 vault first (bounded by ERC-4626 maxRedeem), then Yearn.
    ///      The executed swap must respect the level's SDT/cyvlSDT maximum price.
    function swapForCyvlSDT(uint256 maxSpendSDT)
        external active guard returns(uint256 yearnShares,uint256 eulerShares,uint256 received){
        if(maxSpendSDT==0)revert Invalid();
        uint256 p=buyPrice();if(p==0||buyLevels[0].maxPriceWad==0)revert State();
        uint8 tier;
        for(uint8 i;i<5;++i){
            uint256 threshold=buyLevels[i].maxPriceWad;
            if(threshold!=0&&p<=threshold)tier=i+1;
        }
        uint8 old=activeBuyTier;
        // A triggered tier remains eligible until its EMA recovers more than 1% above
        // its threshold, but execution still must achieve the threshold rate itself.
        if(old>tier&&p<=buyLevels[old-1].maxPriceWad*101/100)tier=old;
        if(tier==0)revert State();
        uint256 ceiling=buyLevels[tier-1].cumulativeSDT;
        if(ceiling<=buySpentSDT)revert State();
        uint256 remaining=_min(maxSpendSDT,ceiling-buySpentSDT);
        (uint8 y,uint8 e)=_buySources();
        _accrue(y);_accrue(e);
        uint256 eFree=_balance(vaults[e])-accruedFeeShares[e];
        uint256 eLimit=_min(eFree,_maxRedeem(e));
        eulerShares=_min(eLimit,IPoL4626(vaults[e]).convertToShares(remaining));
        uint256 amount;
        if(eulerShares!=0)amount=_vaultRedeemRaw(e,eulerShares,0);
        if(amount>remaining)revert Slippage();
        remaining-=amount;
        if(remaining!=0){
            uint256 yFree=_balance(vaults[y])-accruedFeeShares[y];
            uint256 yLimit=_min(yFree,_maxRedeem(y));
            yearnShares=_min(yLimit,IPoL4626(vaults[y]).convertToShares(remaining));
            if(yearnShares!=0)amount+=_vaultRedeemRaw(y,yearnShares,0);
        }
        if(amount==0||amount>_min(maxSpendSDT,ceiling-buySpentSDT))revert State();
        buySpentSDT+=amount;activeBuyTier=tier;
        // The tier sets the *maximum SDT cost per cyvlSDT*; protect actual receipt.
        // Ceil(amount * cyvlUnit * 1e18 / (priceWad * sdtUnit)).
        uint256 numerator=amount*WAD*cyvlUnit;
        uint256 denominator=buyLevels[tier-1].maxPriceWad*sdtUnit;
        uint256 minimum=numerator/denominator+(numerator%denominator==0?0:1);
        uint256 before_=_balance(cyvlSDT);
        _swap(sdt,cyvlSDT,amount);
        received=_balance(cyvlSDT)-before_;
        if(received<minimum)revert Slippage();
        emit CyvlSDTBought(tier,p,yearnShares,eulerShares,received);
    }
    function rescueToken(address token,address recipient,uint256 amount) external onlyOwner guard {
        if(recipient==address(0)||token==curveLp)revert Invalid();
        for(uint8 i;i<5;++i)if(token==vaults[i])revert Invalid();
        if(amount>_free(token))revert Invalid();
        _send(token,recipient,amount);
    }
}