// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Single-custody PoL manager (v9). Swaps and their TWAP/slippage protection belong to OmniRouter.
/// @dev This manager never changes or mints a Uniswap range: it only increases/decreases liquidity in
///      the preselected tokenId. No Uni price observation, automatic range withdrawals or rebalancing.
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
    function balanceOf(address) external view returns (uint256);
}
interface IPoLCurve {
    function coins(uint256) external view returns (address);
    function get_dy(int128,int128,uint256) external view returns (uint256);
    function calc_withdraw_one_coin(uint256,int128) external view returns (uint256);
    function remove_liquidity_one_coin(uint256,int128,uint256) external;
}
interface IPoLCurveFixed {
    function calc_token_amount(uint256[3] calldata,bool) external view returns (uint256);
    function add_liquidity(uint256[3] calldata,uint256) external;
}
interface IPoLCurveNG {
    function calc_token_amount(uint256[] calldata,bool) external view returns (uint256);
    function add_liquidity(uint256[] calldata,uint256) external returns (uint256);
}
interface IPoLFactory { function getPool(address,address,uint24) external view returns (address); }
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
        address[3] curveCoins;
        bool curveIsNG;
        address uniNftManager;
        uint256 uniTokenId;
        address[3] yearnVaults;
        uint8 sdtYearnIndex;
        address[2] eulerVaults;
        uint8 sdtEulerIndex;
        address sdt;
        address usdc;
        address omniRouter;
    }
    // Source/destination: 0 Curve LP/gauge, 1 fixed Uniswap NFT, 2-4 Yearn, 5-6 Euler.
    // source amount is Curve LP, ERC4626 shares, or NFT liquidity basis points (1..10000).
    struct Migration {
        uint8 source;uint8 destination;uint256 amount;uint8 curveExitCoin;
        uint16 uniToken0Bps;uint256 minDestinationShares;uint128 minUniLiquidity;
        uint256 minUniRemoved0;uint256 minUniRemoved1;
    }
    struct RateRule {
        uint256 quoteAmount;uint256 thresholdWad;
        uint16 maxDeviationBps;uint16 yearnRedeemBps;uint16 eulerRedeemBps;
        uint32 persistSeconds;uint32 cooldownSeconds;
        uint64 armedAt;uint64 lastAt;bool enabled;
    }

    address public owner;
    address public pendingOwner;
    address public guardian;
    bool public paused;
    mapping(address=>bool) public operators;
    // Token/spender approvals are set once during deployment or reward configuration.
    // Fixed protocol operations do not check or update allowances.
    mapping(address=>mapping(address=>bool)) private allowanceInitialized;

    address public immutable curvePool;
    address public immutable curveLp;
    address public immutable curveGauge;
    address[3] public curveCoins;
    bool private immutable curveIsNG;
    bool public autoStakeCurve=true;
    uint8 public defaultCurveCoin;
    uint16 public maxCurveSlippageBps=300;
    address[] public gaugeRewards;

    address public immutable uniNftManager;
    uint256 public immutable uniTokenId;
    address public immutable uniToken0;
    address public immutable uniToken1;
    // Amounts owed to the pre-transfer owner at NFT receipt are not new managed profits.
    uint256 private initialOwed0;
    uint256 private initialOwed1;
    uint256 public pendingUniCompound0;
    uint256 public pendingUniCompound1;
    uint16 public uniAllocationToken0Bps=5000;

    address[5] public vaults;
    address[5] public assets;
    uint256[5] private shareUnits;
    uint256[5] private highWatermarkPPS;
    uint256[5] private accruedFeeShares;
    uint8 private immutable sdtYearnIndex;
    uint8 private immutable sdtEulerIndex;
    address public immutable sdt;
    address public immutable usdc;
    address public immutable omniRouter;
    uint16 public profitFeeBps;
    address public profitRecipient;
    uint16 public maxYearnLossBps=100;
    uint16 public maxEulerLossBps=100;
    uint16[7] public allocations;
    bool public allocationsSet;
    uint8 public allocationEnabledMask;
    uint8 public harvestEnabledMask;
    RateRule public rateRule;
    uint8 public rateFrom;
    uint8 public rateTo;

    event ProfitPaid(address recipient,uint256 amountSDT);
    event AllocationSet(uint16[7] allocations);
    event ModuleEnabled(uint8 indexed position,bool allocation,bool harvesting);
    event VaultConfigured(uint8 indexed slot,address vault,address asset);
    event Migrated(uint8 source,uint8 destination,uint256 input,uint256 output);
    event RateExecuted(uint8 from,uint8 to,uint256 yearnShares,uint256 eulerShares);
    event UniLiquidity(uint8 action,uint256 amount0,uint256 amount1,uint128 liquidity);
    error Unauthorized();error Invalid();error State();error Slippage();
    modifier onlyOwner(){if(msg.sender!=owner)revert Unauthorized();_;}
    modifier onlyOperator(){if(msg.sender!=owner&&!operators[msg.sender])revert Unauthorized();_;}
    modifier active(){if(paused)revert State();_;}
    modifier guard(){if(entered!=1)revert State();entered=2;_;entered=1;}

    constructor(DeployConfig memory c) {
        if(c.owner==address(0)||c.curvePool.code.length==0||c.curveLp.code.length==0||
           c.uniNftManager.code.length==0||c.sdt.code.length==0||c.usdc.code.length==0||
           c.usdc==c.sdt||c.omniRouter.code.length==0||
           c.sdtYearnIndex>2||c.sdtEulerIndex>1||
           (c.curveGauge!=address(0)&&c.curveGauge.code.length==0))revert Invalid();
        owner=c.owner;profitRecipient=c.owner;
        curvePool=c.curvePool;curveLp=c.curveLp;curveGauge=c.curveGauge;curveIsNG=c.curveIsNG;
        sdt=c.sdt;usdc=c.usdc;omniRouter=c.omniRouter;
        sdtYearnIndex=c.sdtYearnIndex;sdtEulerIndex=c.sdtEulerIndex;
        for(uint256 i;i<3;++i){
            if(c.curveCoins[i].code.length==0||IPoLCurve(c.curvePool).coins(i)!=c.curveCoins[i])revert Invalid();
            curveCoins[i]=c.curveCoins[i];
        }
        // Vault components may be omitted at deployment and added later by the owner.
        // The selected SDT Yearn/Euler rate-trigger slots need only exist when that rule is enabled.
        for(uint8 i;i<5;++i){
            address v=i<3?c.yearnVaults[i]:c.eulerVaults[i-3];
            if(v!=address(0))_configureVault(i,v);
        }
        uniNftManager=c.uniNftManager;uniTokenId=c.uniTokenId;
        IPoLNft.Position memory pos=IPoLNft(c.uniNftManager).positions(c.uniTokenId);
        if(pos.token0.code.length==0||pos.token1.code.length==0||pos.tickLower>=pos.tickUpper)revert Invalid();
        uniToken0=pos.token0;uniToken1=pos.token1;
        // One-time authorizations at deployment: no approval reads or writes in hot paths.
        _approveOnce(c.sdt,c.omniRouter);
        _approveOnce(c.usdc,c.omniRouter);
        for(uint8 i;i<3;++i){
            _approveOnce(c.curveCoins[i],c.omniRouter);
            _approveOnce(c.curveCoins[i],c.curvePool);
        }
        _approveOnce(c.curveLp,c.curvePool);
        if(c.curveGauge!=address(0))_approveOnce(c.curveLp,c.curveGauge);
        _approveOnce(pos.token0,c.omniRouter);
        _approveOnce(pos.token1,c.omniRouter);
        _approveOnce(pos.token0,c.uniNftManager);
        _approveOnce(pos.token1,c.uniNftManager);
        // Curve is independently harvestable; NFT harvesting requires receipt and explicit enabling.
        allocationEnabledMask |= 3;
        harvestEnabledMask |= 1;
    }

    function proposeOwner(address next) external onlyOwner {if(next==address(0))revert Invalid();pendingOwner=next;}
    function acceptOwner() external {if(msg.sender!=pendingOwner)revert Unauthorized();owner=msg.sender;pendingOwner=address(0);}
    function setOperator(address who,bool on) external onlyOwner {operators[who]=on;}
    function setGuardian(address who) external onlyOwner {guardian=who;}
    function setPaused(bool on) external {if(msg.sender!=owner&&!(on&&msg.sender==guardian))revert Unauthorized();paused=on;}
    function setSafetyLimits(uint16 curve,uint16 yearn,uint16 euler) external onlyOwner {
        if(curve>1500||yearn>1000||euler>1000)revert Invalid();
        maxCurveSlippageBps=curve;maxYearnLossBps=yearn;maxEulerLossBps=euler;
    }
    function setProfitFee(uint16 bps) external onlyOwner {
        if(bps>5000)revert Invalid();
        // Capture fees at the old rate before a change, so fee-rate changes are not retroactive.
        for(uint8 i;i<5;++i)if(vaults[i]!=address(0))_accrue(i);
        profitFeeBps=bps;
    }
    function setProfitRecipient(address to) external onlyOwner {if(to==address(0))revert Invalid();profitRecipient=to;}
    function setCurveConfig(uint8 coin,bool stake) external onlyOwner {
        if(coin>2||(stake&&curveGauge==address(0)))revert Invalid();
        defaultCurveCoin=coin;autoStakeCurve=stake;
    }
    function setGaugeRewards(address[] calldata rewards) external onlyOwner {
        if(rewards.length>16)revert Invalid();delete gaugeRewards;
        for(uint256 i;i<rewards.length;++i){
            if(rewards[i].code.length==0)revert Invalid();
            for(uint256 j;j<i;++j)if(rewards[j]==rewards[i])revert Invalid();
            gaugeRewards.push(rewards[i]);
            _approveOnce(rewards[i],omniRouter);
        }
    }
    function setAllocations(uint16[7] calldata bps) external onlyOwner {
        uint256 total;for(uint8 i;i<7;++i)total+=bps[i];
        if(total!=BPS)revert Invalid();allocations=bps;allocationsSet=true;emit AllocationSet(bps);
    }
    /// @notice Independent allocation and scheduled-harvest permissions for each position.
    /// @dev Disabling a position never blocks withdrawals, migration-out, or mandatory fee booking.
    function setModuleEnabled(uint8 position,bool allocation,bool harvesting) external onlyOwner {
        if(position>=7||((allocation||harvesting)&&!_configured(position)))revert Invalid();
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
        vaults[slot]=address(0);assets[slot]=address(0);
        shareUnits[slot]=0;highWatermarkPPS[slot]=0;accruedFeeShares[slot]=0;
        uint8 bit=uint8(1)<<(slot+2);
        allocationEnabledMask&=~bit;harvestEnabledMask&=~bit;
        if(v!=address(0)){
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
    function setUniAllocationSplit(uint16 bps) external onlyOwner {if(bps>BPS)revert Invalid();uniAllocationToken0Bps=bps;}

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
    function _curveInput(address token,uint256 amount) private returns(uint8 coin,uint256 converted){
        for(uint8 i;i<3;++i)if(token==curveCoins[i])return(i,amount);
        coin=defaultCurveCoin;
        converted=_convert(token,curveCoins[coin],amount);
    }
    function _curveInvest(address token,uint256 amount) private returns(uint256){
        (uint8 coin,uint256 converted)=_curveInput(token,amount);
        return _curveDeposit(coin,converted,0);
    }
    function _curvePreview(uint8 coin,uint256 amount) private view returns(uint256){
        if(curveIsNG){uint256[] memory values=new uint256[](3);values[coin]=amount;return IPoLCurveNG(curvePool).calc_token_amount(values,true);}
        uint256[3] memory values;values[coin]=amount;return IPoLCurveFixed(curvePool).calc_token_amount(values,true);
    }
    function _curveDeposit(uint8 coin,uint256 amount,uint256 minLp) private returns(uint256 lp){
        if(coin>2||amount==0)revert Invalid();
        uint256 floor=_curvePreview(coin,amount)*(BPS-maxCurveSlippageBps)/BPS;
        if(minLp>floor)floor=minLp;
        uint256 before_=_balance(curveLp);
        if(curveIsNG){uint256[] memory values=new uint256[](3);values[coin]=amount;IPoLCurveNG(curvePool).add_liquidity(values,floor);}
        else{uint256[3] memory values;values[coin]=amount;IPoLCurveFixed(curvePool).add_liquidity(values,floor);}
        lp=_balance(curveLp)-before_;
        if(lp==0||lp<floor)revert Slippage();
        if(autoStakeCurve&&curveGauge!=address(0))_stake(lp);
    }
    function _curveWithdraw(uint8 coin,uint256 lp,uint256 minOut,bool fromGauge) private returns(uint256 amount){
        if(coin>2||lp==0)revert Invalid();
        if(fromGauge){if(curveGauge==address(0))revert Invalid();IPoLGauge(curveGauge).withdraw(lp);}
        uint256 floor=IPoLCurve(curvePool).calc_withdraw_one_coin(lp,int128(uint128(coin)))*(BPS-maxCurveSlippageBps)/BPS;
        if(minOut>floor)floor=minOut;
        uint256 before_=_balance(curveCoins[coin]);
        IPoLCurve(curvePool).remove_liquidity_one_coin(lp,int128(uint128(coin)),floor);
        amount=_balance(curveCoins[coin])-before_;
        if(amount==0||amount<floor)revert Slippage();
    }
    function _stake(uint256 lp) private {
        if(curveGauge==address(0))revert Invalid();
        IPoLGauge(curveGauge).deposit(lp);
    }
    function depositCurve(uint8 coin,uint256 amount,uint256 minLp) external onlyOperator active guard returns(uint256){
        return _curveDeposit(coin,amount,minLp);
    }
    function withdrawCurve(uint8 coin,uint256 lp,uint256 minOut,bool fromGauge) external onlyOperator guard returns(uint256){
        return _curveWithdraw(coin,lp,minOut,fromGauge);
    }
    function stakeCurve(uint256 lp) external onlyOperator active guard {_stake(lp);}
    function unstakeCurve(uint256 lp) external onlyOperator guard {IPoLGauge(curveGauge).withdraw(lp);}

    function currentPPS(uint8 slot) public view returns(uint256){
        if(slot>=5||vaults[slot]==address(0))revert Invalid();
        return IPoL4626(vaults[slot]).convertToAssets(shareUnits[slot]);
    }
    function _maxRedeem(uint8 slot) private view returns(uint256){
        return slot<3?IPoLYearn(vaults[slot]).maxRedeem(address(this),maxYearnLossBps):IPoL4626(vaults[slot]).maxRedeem(address(this));
    }
    function pendingProfitShares(uint8 slot) public view returns(uint256 amount){
        if(slot>=5||vaults[slot]==address(0))revert Invalid();
        amount=accruedFeeShares[slot];
        uint256 p=currentPPS(slot);uint256 h=highWatermarkPPS[slot];
        if(profitFeeBps==0||p<=h)return amount;
        uint256 held=_balance(vaults[slot]);
        if(held>amount)amount+=(held-amount)*(p-h)*profitFeeBps/(p*BPS);
    }
    function _accrue(uint8 slot) private {
        uint256 p=currentPPS(slot);uint256 h=highWatermarkPPS[slot];
        uint256 held=_balance(vaults[slot]);
        uint256 reserved=accruedFeeShares[slot];
        if(held<reserved)revert State();
        if(held==reserved){highWatermarkPPS[slot]=p;return;}
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
        if(shares==0||shares>_maxRedeem(slot))revert Invalid();
        address v=vaults[slot];
        uint256 expected=IPoL4626(v).convertToAssets(shares);
        uint256 before_=_balance(assets[slot]);
        if(slot<3)IPoLYearn(v).redeem(shares,address(this),address(this),maxYearnLossBps);
        else IPoL4626(v).redeem(shares,address(this),address(this));
        assetsOut=_balance(assets[slot])-before_;
        uint256 loss=slot<3?maxYearnLossBps:maxEulerLossBps;
        if(assetsOut==0||assetsOut<minAssets||assetsOut<expected*(BPS-loss)/BPS)revert Slippage();
    }
    function _vaultRedeem(uint8 slot,uint256 shares,uint256 minAssets) private returns(uint256){
        if(slot>=5||vaults[slot]==address(0))revert Invalid();
        _accrue(slot);
        if(shares>_balance(vaults[slot])-accruedFeeShares[slot])revert Invalid();
        return _vaultRedeemRaw(slot,shares,minAssets);
    }
    function depositVault(uint8 slot,uint256 amount,uint256 minShares) external onlyOperator active guard returns(uint256){
        return _vaultDeposit(slot,amount,minShares);
    }
    function redeemVault(uint8 slot,uint256 shares,uint256 minAssets) external onlyOperator guard returns(uint256){
        return _vaultRedeem(slot,shares,minAssets);
    }

    function _checkNft() private view returns(IPoLNft.Position memory p){
        IPoLNft n=IPoLNft(uniNftManager);
        if(n.ownerOf(uniTokenId)!=address(this))revert State();
        p=n.positions(uniTokenId);
    }
    /// @notice Only accepts the configured pre-existing position; no mint/range-changing function exists.
    function onERC721Received(address,address,uint256 id,bytes calldata) external returns(bytes4){
        if(msg.sender!=uniNftManager||id!=uniTokenId)revert Invalid();
        IPoLNft.Position memory p=IPoLNft(uniNftManager).positions(id);
        initialOwed0=p.tokensOwed0;initialOwed1=p.tokensOwed1;
        return this.onERC721Received.selector;
    }
    function _uniAdd(uint256 a0,uint256 a1,uint256 min0,uint256 min1,uint128 minL) private returns(uint128 liquidity,uint256 used0,uint256 used1){
        _checkNft();
        if(a0+a1==0)revert Invalid();
        (liquidity,used0,used1)=IPoLNft(uniNftManager).increaseLiquidity(IPoLNft.Increase(uniTokenId,a0,a1,min0,min1,block.timestamp));
        if(liquidity==0||liquidity<minL)revert Slippage();
        emit UniLiquidity(1,used0,used1,liquidity);
    }
    function addUniLiquidity(uint256 amount0,uint256 amount1,uint256 min0,uint256 min1,uint128 minLiquidity)
        external onlyOperator active guard returns(uint128,uint256,uint256){
        if(amount0>_free(uniToken0)||amount1>_free(uniToken1))revert Invalid();
        return _uniAdd(amount0,amount1,min0,min1,minLiquidity);
    }
    function _harvestUni() private returns(uint256 paid){
        _checkNft();
        (uint256 got0,uint256 got1)=IPoLNft(uniNftManager).collect(IPoLNft.Collect(uniTokenId,address(this),type(uint128).max,type(uint128).max));
        uint256 old0=_min(got0,initialOwed0);uint256 old1=_min(got1,initialOwed1);
        initialOwed0-=old0;initialOwed1-=old1;
        uint256 earned0=got0-old0;uint256 earned1=got1-old1;
        uint256 fee0=earned0*profitFeeBps/BPS;uint256 fee1=earned1*profitFeeBps/BPS;
        pendingUniCompound0+=earned0-fee0;pendingUniCompound1+=earned1-fee1;
        paid=_convert(uniToken0,sdt,fee0)+_convert(uniToken1,sdt,fee1);
    }
    function _pay(uint256 amount) private {if(amount!=0){_send(sdt,profitRecipient,amount);emit ProfitPaid(profitRecipient,amount);}}
    function _uniRemove(uint256 bps,uint256 min0,uint256 min1) private returns(uint256 a0,uint256 a1){
        if(bps==0||bps>BPS)revert Invalid();
        IPoLNft.Position memory p=_checkNft();
        uint128 liquidity=uint128(uint256(p.liquidity)*bps/BPS);
        if(liquidity==0)revert Invalid();
        // Harvest first, so every subsequent collected token is principal from THIS withdrawal.
        _pay(_harvestUni());
        (a0,a1)=IPoLNft(uniNftManager).decreaseLiquidity(IPoLNft.Decrease(uniTokenId,liquidity,min0,min1,block.timestamp));
        if(a0>type(uint128).max||a1>type(uint128).max)revert Invalid();
        (uint256 c0,uint256 c1)=IPoLNft(uniNftManager).collect(IPoLNft.Collect(uniTokenId,address(this),uint128(a0),uint128(a1)));
        if(c0!=a0||c1!=a1)revert State();
        emit UniLiquidity(2,a0,a1,liquidity);
    }
    function removeUniLiquidity(uint256 bps,uint256 min0,uint256 min1) external onlyOperator guard returns(uint256,uint256){
        return _uniRemove(bps,min0,min1);
    }
    function compoundUni(uint256 desired0,uint256 desired1,uint256 min0,uint256 min1,uint128 minLiquidity)
        external onlyOperator active guard returns(uint128 liquidity){
        uint256 a0=_min(desired0,pendingUniCompound0);uint256 a1=_min(desired1,pendingUniCompound1);
        uint256 used0;uint256 used1;
        (liquidity,used0,used1)=_uniAdd(a0,a1,min0,min1,minLiquidity);
        pendingUniCompound0-=used0;pendingUniCompound1-=used1;
    }
    function withdrawUniNFT(address recipient) external onlyOwner guard {
        if(recipient==address(0))revert Invalid();
        _checkNft();IPoLNft(uniNftManager).safeTransferFrom(address(this),recipient,uniTokenId);
        initialOwed0=0;initialOwed1=0;
        pendingUniCompound0=0;pendingUniCompound1=0;
    }

    function _invest(uint8 dest,address tokenA,uint256 amountA,address tokenB,uint256 amountB,uint16 split,uint256 minShares,uint128 minUni)
        private returns(uint256 units){
        if(dest>=7||amountA+amountB==0)revert Invalid();
        if(dest==0){
            if(amountA>0)units+=_curveInvest(tokenA,amountA);
            if(amountB>0)units+=_curveInvest(tokenB,amountB);
        }else if(dest==1){
            if(split>BPS)revert Invalid();
            uint256 a0;uint256 a1;
            if(amountB!=0){
                a0=_convert(tokenA,uniToken0,amountA);a1=_convert(tokenB,uniToken1,amountB);
            }else{
                a0=_convert(tokenA,uniToken0,amountA*split/BPS);
                a1=_convert(tokenA,uniToken1,amountA-amountA*split/BPS);
            }
            (uint128 l,,)=_uniAdd(a0,a1,0,0,minUni);units=l;
        }else{
            uint8 slot=dest-2;
            units=_vaultDeposit(slot,_convert(tokenA,assets[slot],amountA)+_convert(tokenB,assets[slot],amountB),minShares);
        }
        if(units==0||units<minShares)revert Slippage();
    }
    /// @notice Explicitly allocate current idle balance; no passive token scanning or shadow ledger.
    function allocateFunds(address token,uint256 amount) external onlyOperator active guard returns(uint256[7] memory minted){
        if(!allocationsSet||(token!=sdt&&token!=usdc)||amount==0||amount>_free(token))revert Invalid();
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
            if(part!=0)minted[i]=_invest(i,token,part,address(0),0,uniAllocationToken0Bps,0,0);
        }
    }
    function migrate(Migration calldata m) external onlyOperator active guard returns(uint256 result){
        if(m.source>=7||m.destination>=7||m.source==m.destination||m.amount==0||m.uniToken0Bps>BPS)revert Invalid();
        address a;address b;uint256 x;uint256 y;
        if(m.source==0){
            if(m.curveExitCoin>2)revert Invalid();
            uint256 idle=_balance(curveLp);
            if(m.amount>idle){if(curveGauge==address(0))revert Invalid();IPoLGauge(curveGauge).withdraw(m.amount-idle);}
            a=curveCoins[m.curveExitCoin];x=_curveWithdraw(m.curveExitCoin,m.amount,0,false);
        }else if(m.source==1){
            (x,y)=_uniRemove(m.amount,m.minUniRemoved0,m.minUniRemoved1);
            a=uniToken0;b=uniToken1;
        }else{
            uint8 slot=m.source-2;a=assets[slot];x=_vaultRedeem(slot,m.amount,0);
        }
        result=_invest(m.destination,a,x,b,y,m.uniToken0Bps,m.minDestinationShares,m.minUniLiquidity);
        emit Migrated(m.source,m.destination,m.amount,result);
    }

    function _harvestCurve() private returns(uint256 paid){
        if(curveGauge==address(0))return 0;
        uint256 n=gaugeRewards.length;
        uint256[] memory delta=new uint256[](n);
        for(uint256 i;i<n;++i)delta[i]=_balance(gaugeRewards[i]);
        IPoLGauge(curveGauge).claim_rewards();
        for(uint256 i;i<n;++i){
            address token=gaugeRewards[i];uint256 reward=_balance(token)-delta[i];
            uint256 cut=reward*profitFeeBps/BPS;
            paid+=_convert(token,sdt,cut);
            if(reward>cut)_curveInvest(token,reward-cut);
        }
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
    function harvest() external onlyOperator active guard returns(uint256 paid){
        uint8 mask=harvestEnabledMask;
        for(uint8 i;i<7;++i)if((mask&(uint8(1)<<i))!=0)paid+=_harvestPosition(i);
        _pay(paid);
    }
    function harvestPosition(uint8 position) external onlyOperator active guard returns(uint256 paid){
        if(position>=7||(harvestEnabledMask&(uint8(1)<<position))==0)revert State();
        paid=_harvestPosition(position);
        _pay(paid);
    }

    function setRateRule(uint8 from,uint8 to,RateRule calldata c) external onlyOwner {
        if(from>2||to>2||from==to)revert Invalid();
        if(c.enabled&&(c.quoteAmount==0||c.thresholdWad==0||c.maxDeviationBps>2000||
            c.yearnRedeemBps>BPS||c.eulerRedeemBps>BPS||
            (c.yearnRedeemBps==0&&c.eulerRedeemBps==0)||
            c.persistSeconds<300||c.cooldownSeconds<3600))revert Invalid();
        if(c.enabled&&(assets[sdtYearnIndex]!=sdt||assets[sdtEulerIndex+3]!=sdt))revert State();
        rateFrom=from;rateTo=to;
        RateRule storage r=rateRule;
        r.quoteAmount=c.quoteAmount;r.thresholdWad=c.thresholdWad;
        r.maxDeviationBps=c.maxDeviationBps;r.yearnRedeemBps=c.yearnRedeemBps;
        r.eulerRedeemBps=c.eulerRedeemBps;r.persistSeconds=c.persistSeconds;
        r.cooldownSeconds=c.cooldownSeconds;r.enabled=c.enabled;r.armedAt=0;
    }
    function rateStatus() public view returns(uint256 spot,uint256 oracleRate,uint256 deviationBps){
        RateRule storage r=rateRule;
        if(r.quoteAmount==0)revert Invalid();
        uint8 from=rateFrom;uint8 to=rateTo;
        uint256 out=IPoLCurve(curvePool).get_dy(int128(uint128(from)),int128(uint128(to)),r.quoteAmount);
        uint256 scaleIn=10**uint256(IPoL20(curveCoins[from]).decimals());
        uint256 scaleOut=10**uint256(IPoL20(curveCoins[to]).decimals());
        spot=out*scaleIn*WAD/(r.quoteAmount*scaleOut);
        oracleRate=IPoLRouter(omniRouter).price_oracle(curveCoins[from],curveCoins[to]);
        if(oracleRate==0)revert Invalid();
        deviationBps=(spot>oracleRate?spot-oracleRate:oracleRate-spot)*BPS/oracleRate;
    }
    function observeRate() external active {
        RateRule storage r=rateRule;if(!r.enabled)revert State();
        (uint256 spot,,uint256 dev)=rateStatus();
        if(spot>=r.thresholdWad&&dev<=r.maxDeviationBps){if(r.armedAt==0)r.armedAt=uint64(block.timestamp);}
        else r.armedAt=0;
    }
    function executeRate() external active guard returns(uint256 yearnShares,uint256 eulerShares){
        RateRule storage r=rateRule;
        if(!r.enabled||r.armedAt==0||block.timestamp<uint256(r.armedAt)+r.persistSeconds||
            block.timestamp<uint256(r.lastAt)+r.cooldownSeconds)revert State();
        (uint256 spot,,uint256 dev)=rateStatus();
        if(spot<r.thresholdWad||dev>r.maxDeviationBps)revert State();
        uint8 y=sdtYearnIndex;uint8 e=sdtEulerIndex+3;
        if(assets[y]!=sdt||assets[e]!=sdt)revert State();
        _accrue(y);_accrue(e);
        yearnShares=_min((_balance(vaults[y])-accruedFeeShares[y])*r.yearnRedeemBps/BPS,_maxRedeem(y));
        eulerShares=_min((_balance(vaults[e])-accruedFeeShares[e])*r.eulerRedeemBps/BPS,_maxRedeem(e));
        if(yearnShares==0&&eulerShares==0)revert State();
        r.armedAt=0;r.lastAt=uint64(block.timestamp);
        if(yearnShares>0)_curveInvest(assets[y],_vaultRedeemRaw(y,yearnShares,0));
        if(eulerShares>0)_curveInvest(assets[e],_vaultRedeemRaw(e,eulerShares,0));
        emit RateExecuted(rateFrom,rateTo,yearnShares,eulerShares);
    }
    function rescueToken(address token,address recipient,uint256 amount) external onlyOwner guard {
        if(recipient==address(0)||token==curveLp)revert Invalid();
        for(uint8 i;i<5;++i)if(token==vaults[i])revert Invalid();
        if(amount>_free(token))revert Invalid();
        _send(token,recipient,amount);
    }
}