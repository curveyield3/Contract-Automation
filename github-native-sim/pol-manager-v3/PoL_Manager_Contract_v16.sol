// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Single-custody PoL manager (v16). Swaps and their TWAP/slippage protection belong to OmniRouter.
/// @dev Fixed Uniswap v3 NFT, five configurable ERC4626 positions, SDT-only Curve NG.
///      No internal Curve/Uniswap quote or price protection; external integration deferred.
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
    function maxRedeem(address) external view returns (uint256);
}
interface IPoLEuler is IPoL4626 {
    function cash() external view returns(uint256);
    function totalBorrows() external view returns(uint256);
    function convertToShares(uint256) external view returns(uint256);
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
    function remove_liquidity_one_coin(uint256,int128,uint256) external returns(uint256);
}
interface IPoLCurveNG {
    function add_liquidity(uint256[] calldata,uint256) external returns (uint256);
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
        address curvePool;
        address curveLp;
        address curveGauge;
        uint8 curveSdtIndex;
        address uniNftManager;
        uint256 uniTokenId;
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
    // Source/destination: 0 Curve LP/gauge, 1 fixed Uniswap NFT, 2-4 Yearn, 5-6 Euler.
    // source amount is Curve LP, ERC4626 shares, or NFT liquidity basis points (1..10000).
    struct Migration {
        uint8 source;uint8 destination;uint256 amount;
        uint256 minDestinationShares;
    }
    /// @notice Each tier has its own fraction of the original SDT Yearn/Euler holdings.
    /// @dev Prices are SDT per 1 cyvlSDT from OmniRouter, scaled to 1e18.
    struct BuyLevel { uint256 maxPriceWad; uint16 spendBps; }

    address public owner;
    address public pendingOwner;
    address public guardian;
    bool public paused;
    mapping(address=>bool) public operators;
    // Token/spender approvals are set once during deployment or reward configuration.
    // Fixed protocol operations do not check or update allowances.
    mapping(address=>mapping(address=>bool)) private allowanceInitialized;

    address public immutable curvePool;
    address private immutable curveLp;
    address private immutable curveGauge;
    uint8 private immutable curveSdtIndex;
    address private immutable crv;

    address private immutable uniNftManager;
    uint256 private immutable uniTokenId;
    address private immutable uniToken0;
    address private immutable uniToken1;
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
    uint8 private immutable sdtYearnIndex;
    uint8 private immutable sdtEulerIndex;
    address private immutable cyvlSDT;
    address public immutable sdt;
    address private immutable usdc;
    address public immutable omniRouter;
    uint16 public profitFeeBps;
    address public profitRecipient;
    uint16 private maxYearnLossBps=100;
    uint16 private maxEulerLossBps=100;
    uint16[7] public allocations;
    uint8 public allocationEnabledMask;
    uint8 public harvestEnabledMask;
    BuyLevel[3] public buyLevels;
    uint256 public buyBaseYearn;
    uint256 public buyBaseEuler;
    uint256[3] public buySpentYearn;
    uint256[3] public buySpentEuler;
    uint8 public activeBuyTier;

    event ProfitPaid(address recipient,uint256 amountSDT);
    event AllocationSet(uint16[7] allocations);
    event ModuleEnabled(uint8 indexed position,bool allocation,bool harvesting);
    event VaultConfigured(uint8 indexed slot,address vault,address asset);
    event Migrated(uint8 source,uint8 destination,uint256 input,uint256 output);
    event CyvlSDTBought(uint8 indexed tier,uint256 priceWad,uint256 yearnShares,uint256 eulerShares,uint256 received);
    event BuyLevelsUpdated();
    event UniLiquidity(uint8 action,uint256 amount0,uint256 amount1,uint128 liquidity);
    error Unauthorized();error Invalid();error State();error Slippage();
    modifier onlyOwner(){if(msg.sender!=owner)revert Unauthorized();_;}
    modifier onlyOperator(){if(msg.sender!=owner&&!operators[msg.sender])revert Unauthorized();_;}
    modifier active(){if(paused)revert State();_;}
    modifier guard(){if(entered!=1)revert State();entered=2;_;entered=1;}

    constructor(DeployConfig memory c) {
        if(c.owner==address(0)||c.curvePool.code.length==0||c.curveLp.code.length==0||
           c.uniNftManager.code.length==0||c.sdt.code.length==0||c.usdc.code.length==0||
           c.usdc==c.sdt||c.omniRouter.code.length==0||c.cyvlSDT.code.length==0||
           (c.curveGauge!=address(0)&&c.crv.code.length==0)||
           c.sdtYearnIndex>2||c.sdtEulerIndex>1||
           (c.curveGauge!=address(0)&&c.curveGauge.code.length==0))revert Invalid();
        owner=c.owner;profitRecipient=c.owner;
        curvePool=c.curvePool;curveLp=c.curveLp;curveGauge=c.curveGauge;
        sdt=c.sdt;usdc=c.usdc;omniRouter=c.omniRouter;cyvlSDT=c.cyvlSDT;crv=c.crv;
        sdtYearnIndex=c.sdtYearnIndex;sdtEulerIndex=c.sdtEulerIndex;
        if(c.curveSdtIndex>2||IPoLCurve(c.curvePool).coins(c.curveSdtIndex)!=c.sdt)revert Invalid();
        curveSdtIndex=c.curveSdtIndex;
        // Vault components may be omitted at deployment and added later by the owner.
        // The selected SDT Yearn/Euler rate-trigger slots need only exist when that rule is enabled.
        for(uint8 i;i<5;++i){
            address v=i<3?c.yearnVaults[i]:c.eulerVaults[i-3];
            if(v!=address(0))_configureVault(i,v);
        }
        uniNftManager=c.uniNftManager;uniTokenId=c.uniTokenId;
        IPoLNft.Position memory pos=IPoLNft(c.uniNftManager).positions(c.uniTokenId);
        if(pos.token0.code.length==0||pos.token1.code.length==0||pos.tickLower>=pos.tickUpper)revert Invalid();
        if(!((pos.token0==c.sdt&&pos.token1==c.cyvlSDT)||
             (pos.token1==c.sdt&&pos.token0==c.cyvlSDT)))revert Invalid();
        uniToken0=pos.token0;uniToken1=pos.token1;
        // One-time authorizations at deployment: no approval reads or writes in hot paths.
        _approveOnce(c.sdt,c.omniRouter);
        _approveOnce(c.usdc,c.omniRouter);
        if(c.crv!=address(0))_approveOnce(c.crv,c.omniRouter);
        _approveOnce(c.sdt,c.curvePool);
        _approveOnce(c.curveLp,c.curvePool);
        if(c.curveGauge!=address(0))_approveOnce(c.curveLp,c.curveGauge);
        _approveOnce(pos.token0,c.omniRouter);
        _approveOnce(pos.token1,c.omniRouter);
        _approveOnce(pos.token0,c.uniNftManager);
        _approveOnce(pos.token1,c.uniNftManager);
        // Curve is independently harvestable; NFT harvesting requires receipt and explicit enabling.
        allocationEnabledMask |= 1;
        harvestEnabledMask |= 1;
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
        return position<2||(position<7&&vaults[position-2]!=address(0));
    }
    /// @notice Add, remove, or replace an empty Yearn (0-2) or Euler (3-4) vault.
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
    // Minimal SDT-only StableSwap-NG calls; output bounds will be provided by
    // an external component in a later integration.
    function _curveDeposit(uint256 amount) private returns(uint256 lp){
        if(amount==0)revert Invalid();
        uint256[] memory amounts=new uint256[](3);
        amounts[curveSdtIndex]=amount;
        lp=IPoLCurveNG(curvePool).add_liquidity(amounts,0);
        if(curveGauge!=address(0))IPoLGauge(curveGauge).deposit(lp);
    }
    function _curveWithdraw(uint256 lp,bool fromGauge) private returns(uint256 amount){
        if(lp==0)revert Invalid();
        if(fromGauge)IPoLGauge(curveGauge).withdraw(lp);
        amount=IPoLCurve(curvePool).remove_liquidity_one_coin(lp,int128(uint128(curveSdtIndex)),0);
    }
    /// @notice SDT-only Curve operations. No internal spot or EMA slippage math.
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
    // U_after = borrows / (borrows + cash - withdrawal) <= 97%.
    // Thus withdrawable cash <= cash - ceil(3*borrows/97).
    function _maxRedeem(uint8 slot) private view returns(uint256 shares){
        address vault=vaults[slot];
        if(slot<3)return IPoLYearn(vault).maxRedeem(address(this),maxYearnLossBps);
        shares=IPoL4626(vault).maxRedeem(address(this));
        uint256 cash_=IPoLEuler(vault).cash();
        uint256 borrows=IPoLEuler(vault).totalBorrows();
        uint256 needed=(borrows*3+96)/97;
        if(cash_<=needed)return 0;
        uint256 allowed=IPoLEuler(vault).convertToShares(cash_-needed);
        if(allowed<shares)shares=allowed;
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
        (liquidity,used0,used1)=IPoLNft(uniNftManager).increaseLiquidity(
            IPoLNft.Increase(uniTokenId,a0,a1,0,0,block.timestamp));
        if(liquidity==0)revert State();
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
        IPoLNft.Position memory p=_checkNft();
        uint128 liquidity=uint128(uint256(p.liquidity)*bps/BPS);
        if(liquidity==0)revert Invalid();
        // Harvest first, so every subsequent collected token is principal from THIS withdrawal.
        _pay(_harvestUni());
        (a0,a1)=IPoLNft(uniNftManager).decreaseLiquidity(IPoLNft.Decrease(uniTokenId,liquidity,0,0,block.timestamp));
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
    /// @dev The NFT allocation path remains disabled until its external ratio adapter is available.
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

    /// @notice Three *independent* spend budgets at descending SDT/cyvlSDT prices.
    /// @dev E.g. 0.9=>10%, 0.7=>40%, 0.5=>75% of the original source-vault holdings.
    ///      Updates do not reset spent amounts or the budget snapshot.
    function setBuyLevels(uint256[3] calldata prices,uint16[3] calldata spendBps) external onlyOwner {
        if(prices[0]==0){
            if(prices[1]!=0||prices[2]!=0||spendBps[0]!=0||
               spendBps[1]!=0||spendBps[2]!=0)revert Invalid();
        }else if(prices[0]<=prices[1]||prices[1]<=prices[2]||prices[2]==0||
            spendBps[0]==0||spendBps[1]==0||spendBps[2]==0||
            spendBps[0]>BPS||spendBps[1]>BPS||spendBps[2]>BPS)revert Invalid();
        for(uint8 i;i<3;++i)buyLevels[i]=BuyLevel(prices[i],spendBps[i]);
        activeBuyTier=0;
        emit BuyLevelsUpdated();
    }
    /// @notice Starts a new owner-authorized budget epoch. Public swap calls cannot reset budgets.
    function resetBuyBudget() external onlyOwner {
        activeBuyTier=0;
        buyBaseYearn=0;buyBaseEuler=0;
        delete buySpentYearn;delete buySpentEuler;
    }
    function buyPrice() public view returns(uint256){
        return IPoLRouter(omniRouter).price_oracle(cyvlSDT,sdt);
    }
    /// @notice Public, price-gated purchase of cyvlSDT using redeemed SDT Yearn/Euler shares.
    /// @dev Caller chooses size; each tier has an independent cap on the initial eligible shares.
    ///      The oracle reports a historical rate, so recovery must be observed between calls.
    function swapForCyvlSDT(uint256 maxYearnShares,uint256 maxEulerShares)
        external active guard returns(uint256 yearnShares,uint256 eulerShares,uint256 received){
        if(maxYearnShares==0&&maxEulerShares==0)revert Invalid();
        uint256 p=buyPrice();if(p==0||buyLevels[0].maxPriceWad==0)revert State();
        uint8 tier;
        for(uint8 i;i<3;++i)if(p<=buyLevels[i].maxPriceWad)tier=i+1;
        uint8 old=activeBuyTier;
        if(old>tier&&p<buyLevels[old-1].maxPriceWad*101/100)tier=old;
        if(tier==0)revert State();
        uint8 y=sdtYearnIndex;uint8 e=sdtEulerIndex+3;
        if(assets[y]!=sdt||assets[e]!=sdt)revert State();
        _accrue(y);_accrue(e);
        uint256 heldY=_balance(vaults[y])-accruedFeeShares[y];
        uint256 heldE=_balance(vaults[e])-accruedFeeShares[e];
        if(buyBaseYearn==0&&buyBaseEuler==0){
            buyBaseYearn=heldY;buyBaseEuler=heldE;
        }
        uint256 idx=tier-1;
        uint256 bps=buyLevels[idx].spendBps;
        uint256 capY=buyBaseYearn*bps/BPS;
        uint256 capE=buyBaseEuler*bps/BPS;
        if(capY>buySpentYearn[idx]&&maxYearnShares!=0){
            yearnShares=_min(maxYearnShares,_min(capY-buySpentYearn[idx],_min(heldY,_maxRedeem(y))));
        }
        if(capE>buySpentEuler[idx]&&maxEulerShares!=0){
            eulerShares=_min(maxEulerShares,_min(capE-buySpentEuler[idx],_min(heldE,_maxRedeem(e))));
        }
        if(yearnShares==0&&eulerShares==0)revert State();
        activeBuyTier=tier;
        buySpentYearn[tier-1]+=yearnShares;buySpentEuler[tier-1]+=eulerShares;
        uint256 amount;
        if(yearnShares!=0)amount+=_vaultRedeemRaw(y,yearnShares,0);
        if(eulerShares!=0)amount+=_vaultRedeemRaw(e,eulerShares,0);
        received=_swap(sdt,cyvlSDT,amount);
        emit CyvlSDTBought(tier,p,yearnShares,eulerShares,received);
    }
    function rescueToken(address token,address recipient,uint256 amount) external onlyOwner guard {
        if(recipient==address(0)||token==curveLp)revert Invalid();
        for(uint8 i;i<5;++i)if(token==vaults[i])revert Invalid();
        if(amount>_free(token))revert Invalid();
        _send(token,recipient,amount);
    }
}