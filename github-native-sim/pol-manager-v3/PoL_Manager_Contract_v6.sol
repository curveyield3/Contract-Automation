// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// One PoL manager; all ERC20 swaps use the preconfigured OmniRouter's native guard.
interface IPOLToken {
    function balanceOf(address) external view returns (uint256);
    function decimals() external view returns (uint8);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}
interface IPOLVault is IPOLToken {
    function asset() external view returns (address);
    function deposit(uint256,address) external returns (uint256);
    function redeem(uint256,address,address) external returns (uint256);
    function convertToAssets(uint256) external view returns (uint256);
    function maxRedeem(address) external view returns (uint256);
}
interface IPOLYearn is IPOLVault {
    function redeem(uint256,address,address,uint256) external returns (uint256);
    function maxRedeem(address,uint256) external view returns (uint256);
}
interface IPOLRouter {
    function swap(address tokenIn,address tokenOut,uint256 amountIn) external returns (uint256 amountOut);
    function price_oracle(address tokenIn,address tokenOut) external view returns (uint256 rateWad);
}
interface IPOLCurveGauge {
    function deposit(uint256) external;
    function withdraw(uint256) external;
    function claim_rewards() external;
    function balanceOf(address) external view returns (uint256);
}
interface IPOLCurve {
    function coins(uint256) external view returns (address);
    function get_dy(int128,int128,uint256) external view returns (uint256);
    function remove_liquidity_one_coin(uint256,int128,uint256) external;
    function calc_withdraw_one_coin(uint256,int128) external view returns (uint256);
}
interface IPOLCurveFixed {
    function add_liquidity(uint256[3] calldata,uint256) external;
    function calc_token_amount(uint256[3] calldata,bool) external view returns (uint256);
}
interface IPOLCurveNG {
    function add_liquidity(uint256[] calldata,uint256) external returns (uint256);
    function calc_token_amount(uint256[] calldata,bool) external view returns (uint256);
}
interface IPOLUniFactory {
    function getPool(address,address,uint24) external view returns (address);
}
interface IPOLUniPool {
    function slot0() external view returns (uint160,int24,uint16,uint16,uint16,uint8,bool);
    function observe(uint32[] calldata) external view returns (int56[] memory,uint160[] memory);
}
interface IPOLNFT {
    struct Position {
        uint96 nonce; address operator; address token0; address token1; uint24 fee;
        int24 tickLower; int24 tickUpper; uint128 liquidity;
        uint256 feeGrowthInside0LastX128; uint256 feeGrowthInside1LastX128;
        uint128 tokensOwed0; uint128 tokensOwed1;
    }
    struct Increase {uint256 tokenId; uint256 amount0Desired; uint256 amount1Desired;
        uint256 amount0Min; uint256 amount1Min; uint256 deadline;}
    struct Decrease {uint256 tokenId; uint128 liquidity; uint256 amount0Min;
        uint256 amount1Min; uint256 deadline;}
    struct Collect {uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max;}
    function positions(uint256) external view returns (Position memory);
    function ownerOf(uint256) external view returns (address);
    function factory() external view returns (address);
    function increaseLiquidity(Increase calldata) external payable returns (uint128,uint256,uint256);
    function decreaseLiquidity(Decrease calldata) external payable returns (uint256,uint256);
    function collect(Collect calldata) external payable returns (uint256,uint256);
    function safeTransferFrom(address,address,uint256) external;
}

/// @title PoLManager v6: one Curve gauge, one existing Uni v3 NFT, two Yearn vaults, two Euler vaults.
/// @dev All vaults are standard ERC4626 (Yearn v3 uses max-loss-aware redemption).
abstract contract PoLStorage {

    uint256 internal constant BPS = 10000;
    uint256 internal constant WAD = 1e18;
    uint256 internal lock = 1;

    struct DeployConfig {
        address executionFacet;
        address initialOwner;
        address curvePool;
        address curveLpToken;
        address curveGauge;
        address[3] curveCoins;
        bool curveIsNG;
        address uniPositionManager;
        uint256 uniTokenId;
        address[2] yearnVaults;
        uint8 sdtYearnIndex;
        address[2] eulerMarkets;
        address sdtToken;
        uint8 sdtEulerIndex;
        address swapRouter;
    }
    struct UniPolicy {
        uint32 twapSeconds;
        uint32 minActionInterval;
        uint24 maxSpotTwapDifference;
        int24 bufferTicks;
        uint16 outOfRangeWithdrawBps;
        uint128 maxAdd0;
        uint128 maxAdd1;
        bool enabled;
    }
    struct Migration {
        uint8 source; uint8 destination;
        uint256 amount; // LP, ERC4626 shares, or NFT liquidity basis points.
        uint8 curveExitCoin;
        uint16 uniToken0Bps;
        uint256 minDestinationShares;
        uint128 minUniLiquidity;
        uint256 minUniRemoved0;
        uint256 minUniRemoved1;
    }
    struct RateParams {
        uint256 quoteAmountIn;
        uint256 targetRateWad;
        uint16 maxOracleDeviationBps;
        uint16 yearnRedeemBps;
        uint16 sdtRedeemBps;
        uint32 minPersistSeconds;
        uint32 cooldownSeconds;
        bool enabled;
    }
    struct RateState {
        RateParams params;
        uint64 armedAt;
        uint64 lastTriggeredAt;
    }
    struct Route { uint128 maxAmountPerSwap; uint8 curveCoinIndex; bool enabled; }

    address public owner;
    address public pendingOwner;
    address public guardian;
    bool public paused;
    mapping(address=>bool) public operators;

    address public curvePool;
    address public curveLpToken;
    address public curveGauge;
    address[3] public curveCoins;
    bool public curveIsNG;
    bool public autoStakeCurve;

    address public uniPositionManager;
    address public uniPool;
    uint256 public uniTokenId;
    address public uniToken0;
    address public uniToken1;
    int24 public uniLowerTick;
    int24 public uniUpperTick;
    UniPolicy public uniPolicy;
    uint256 public lastUniActionAt;
    uint256 public uniPrincipalOwed0;
    uint256 public uniPrincipalOwed1;
    uint256 public uniPendingCompound0;
    uint256 public uniPendingCompound1;
    bool public uniNftReceived;

    address[2] public yearnVaults;
    address[2] public yearnAssets;
    address[2] public eulerMarkets;
    address[2] public eulerAssets;
    uint8 public sdtYearnIndex;
    uint8 public sdtEulerIndex;
    address public sdtToken;
    address public swapRouter;
    uint256[4] public highWatermarkPPS;
    uint256[4] public trackedShares;
    uint256[4] internal shareUnits;
    uint16 public cyvlSDTProfitShare;
    address public cyvlSDTProfitRecipient;
    uint16 public maxYearnLossBps = 100;
    uint16 public maxEulerLossBps = 100;
    uint16 public maxCurveSlippageBps = 300;
    mapping(address=>uint128) public sdtSwapLimits;
    address[] public gaugeRewardTokens;
    mapping(address=>Route) internal routes;

    uint16[6] public positionAllocationBps;
    bool public allocationsConfigured;
    uint16 public uniAllocationToken0Bps = 5000;
    address[] public fundingTokens;
    mapping(address=>bool) public isFundingToken;
    mapping(address=>uint256) public observedFundingBalance;
    mapping(address=>uint256) public availableIncomingFunds;

    mapping(uint8=>RateState) internal rateStates;
    uint32 public globalRateCooldown = 1 days;
    uint256 public lastGlobalRateExecutionAt;
    bool internal delegateActionArmed;

    event OwnershipProposed(address next);
    event OwnershipTransferred(address owner);
    event ProfitPaid(address indexed to,uint256 amountSDT);
    event PositionAllocationsSet(uint16[6] bps);
    event SwapConverted(address indexed input,address indexed output,uint256 amountIn,uint256 amountOut);
    event LiquidityMigrated(uint8 indexed source,uint8 indexed destination,uint256 amount,uint256 output);
    event VaultHarvested(uint8 indexed slot,uint256 sharesRedeemed,uint256 sdtAmount,uint256 newPPS);
    event CurveDeposit(uint8 indexed coin,uint256 assets,uint256 minted,bool staked);
    event CurveWithdrawal(uint8 indexed coin,uint256 lp,uint256 amount);
    event UniAction(uint8 indexed action,uint256 amount0,uint256 amount1,uint128 liquidity);
    event RateTriggered(uint8 indexed from,uint8 indexed to,uint256 yearnShares,uint256 eulerShares);
    error Unauthorized();
    error Invalid();
    error State();
    error Slippage();

    modifier onlyOwner() { if(msg.sender!=owner) revert Unauthorized(); _; }
    modifier onlyOperator() { if(msg.sender!=owner && !operators[msg.sender]) revert Unauthorized(); _; }
    modifier whenActive() { if(paused) revert State(); _; }
    modifier nonReentrant() { if(lock!=1) revert State(); lock=2; _; lock=1; }
    modifier trackIncoming() { _observeIncoming(); _; _checkpointIncoming(); }


    function _observeIncoming() internal {
        for(uint256 i;i<fundingTokens.length;++i){
            address token=fundingTokens[i];uint256 actual=IPOLToken(token).balanceOf(address(this));uint256 prev=observedFundingBalance[token];
            if(actual>prev)availableIncomingFunds[token]+=actual-prev;
            if(availableIncomingFunds[token]>actual)availableIncomingFunds[token]=actual;
            observedFundingBalance[token]=actual;
        }
    }

    function _checkpointIncoming() internal {
        for(uint256 i;i<fundingTokens.length;++i){
            address token=fundingTokens[i];uint256 actual=IPOLToken(token).balanceOf(address(this));
            if(availableIncomingFunds[token]>actual)availableIncomingFunds[token]=actual;
            observedFundingBalance[token]=actual;
        }
    }

    function _tokenCall(address token,bytes memory data) internal {
        (bool ok,bytes memory r)=token.call(data);
        if(!ok || (r.length!=0 && (r.length!=32 || !abi.decode(r,(bool)))))revert Invalid();
    }

    function _approve(address token,address target,uint256 amount) internal {
        _tokenCall(token,abi.encodeWithSelector(IPOLToken.approve.selector,target,0));
        if(amount>0)_tokenCall(token,abi.encodeWithSelector(IPOLToken.approve.selector,target,amount));
    }

    function _send(address token,address recipient,uint256 amount) internal {
        _tokenCall(token,abi.encodeWithSelector(IPOLToken.transfer.selector,recipient,amount));
    }

    function _swap(address input,address output,uint256 amount) internal returns(uint256 received){
        if(input==output || amount==0)revert Invalid();
        uint256 beforeOut=IPOLToken(output).balanceOf(address(this));
        _approve(input,swapRouter,amount);
        uint256 reported=IPOLRouter(swapRouter).swap(input,output,amount);
        _approve(input,swapRouter,0);
        received=IPOLToken(output).balanceOf(address(this))-beforeOut;
        if(received==0 || reported!=received)revert Slippage();
        emit SwapConverted(input,output,amount,received);
    }

    function _convert(address token,address output,uint256 amount) internal returns(uint256){
        if(amount==0)return 0;
        return token==output?amount:_swap(token,output,amount);
    }

    function _convertSDT(address token,uint256 amount) internal returns(uint256){
        if(amount==0)return 0;
        if(token==sdtToken)return amount;
        if(sdtSwapLimits[token]==0 || amount>sdtSwapLimits[token])revert Invalid();
        return _swap(token,sdtToken,amount);
    }

    function _curveInput(address token,uint256 amount) internal returns(uint8 coin,uint256 out){
        for(uint8 i;i<3;++i)if(token==curveCoins[i])return(i,amount);
        Route memory r=routes[token];if(!r.enabled || amount>r.maxAmountPerSwap)revert Invalid();
        return (r.curveCoinIndex,_swap(token,curveCoins[r.curveCoinIndex],amount));
    }

    function _curveMintPreview(uint8 coin,uint256 amount) internal view returns(uint256){
        if(curveIsNG){uint256[] memory a=new uint256[](3);a[coin]=amount;return IPOLCurveNG(curvePool).calc_token_amount(a,true);}
        uint256[3] memory b;b[coin]=amount;return IPOLCurveFixed(curvePool).calc_token_amount(b,true);
    }

    function _curveDeposit(uint8 coin,uint256 amount,uint256 minLp) internal returns(uint256 minted){
        if(coin>2 || amount==0)revert Invalid();
        uint256 floor=_curveMintPreview(coin,amount)*(BPS-maxCurveSlippageBps)/BPS;
        if(minLp>floor)floor=minLp;
        uint256 beforeLp=IPOLToken(curveLpToken).balanceOf(address(this));
        _approve(curveCoins[coin],curvePool,amount);
        if(curveIsNG){uint256[] memory a=new uint256[](3);a[coin]=amount;IPOLCurveNG(curvePool).add_liquidity(a,floor);}
        else{uint256[3] memory b;b[coin]=amount;IPOLCurveFixed(curvePool).add_liquidity(b,floor);}
        _approve(curveCoins[coin],curvePool,0);
        minted=IPOLToken(curveLpToken).balanceOf(address(this))-beforeLp;
        if(minted==0 || minted<floor)revert Slippage();
        if(autoStakeCurve){_approve(curveLpToken,curveGauge,minted);IPOLCurveGauge(curveGauge).deposit(minted);_approve(curveLpToken,curveGauge,0);}
        emit CurveDeposit(coin,amount,minted,autoStakeCurve);
    }

    function _curveWithdraw(uint8 coin,uint256 shares,uint256 minOut,bool unstake) internal returns(uint256 amount){
        if(coin>2 || shares==0)revert Invalid();
        if(unstake){if(curveGauge==address(0))revert Invalid();IPOLCurveGauge(curveGauge).withdraw(shares);}
        uint256 floor=IPOLCurve(curvePool).calc_withdraw_one_coin(shares,int128(uint128(coin)))*(BPS-maxCurveSlippageBps)/BPS;
        if(minOut>floor)floor=minOut;
        uint256 beforeAssets=IPOLToken(curveCoins[coin]).balanceOf(address(this));
        _approve(curveLpToken,curvePool,shares);
        IPOLCurve(curvePool).remove_liquidity_one_coin(shares,int128(uint128(coin)),floor);
        _approve(curveLpToken,curvePool,0);
        amount=IPOLToken(curveCoins[coin]).balanceOf(address(this))-beforeAssets;
        if(amount==0 || amount<floor)revert Slippage();
        emit CurveWithdrawal(coin,shares,amount);
    }

    function _vault(uint8 slot) internal view returns(address){
        if(slot>=4)revert Invalid();
        return slot<2?yearnVaults[slot]:eulerMarkets[slot-2];
    }

    function _asset(uint8 slot) internal view returns(address){
        if(slot>=4)revert Invalid();
        return slot<2?yearnAssets[slot]:eulerAssets[slot-2];
    }

    function currentPPS(uint8 slot) public view returns(uint256){return IPOLVault(_vault(slot)).convertToAssets(shareUnits[slot]);}

    function _maxRedeem(uint8 slot) internal view returns(uint256){address v=_vault(slot);return slot<2?IPOLYearn(v).maxRedeem(address(this),maxYearnLossBps):IPOLVault(v).maxRedeem(address(this));}

    function _requireHarvest(uint8 slot) internal view {
        if(cyvlSDTProfitShare>0 && trackedShares[slot]>0 && currentPPS(slot)>highWatermarkPPS[slot])revert State();
    }

    function _depositVault(uint8 slot,uint256 amount,uint256 minShares) internal returns(uint256 shares){
        if(amount==0)revert Invalid();_requireHarvest(slot);
        address v=_vault(slot);
        if(trackedShares[slot]==0){uint256 p=currentPPS(slot);if(p>highWatermarkPPS[slot])highWatermarkPPS[slot]=p;}
        address a=_asset(slot);
        _approve(a,v,amount);
        shares=IPOLVault(v).deposit(amount,address(this));
        _approve(a,v,0);
        if(shares==0 || shares<minShares)revert Slippage();
        trackedShares[slot]+=shares;
    }

    function _redeemVault(uint8 slot,uint256 shares,uint256 minAssets) internal returns(uint256 assets){
        if(shares==0 || shares>_maxRedeem(slot))revert Invalid();
        address v=_vault(slot);
        address a=_asset(slot);
        uint256 prior=IPOLToken(a).balanceOf(address(this));
        uint256 expected=IPOLVault(v).convertToAssets(shares);
        assets=slot<2?IPOLYearn(v).redeem(shares,address(this),address(this),maxYearnLossBps):IPOLVault(v).redeem(shares,address(this),address(this));
        if(assets!=IPOLToken(a).balanceOf(address(this))-prior)revert Slippage();
        uint256 maxLoss=slot<2?maxYearnLossBps:maxEulerLossBps;
        if(assets==0 || assets<minAssets || assets<expected*(BPS-maxLoss)/BPS)revert Slippage();
        uint256 registered=trackedShares[slot];
        trackedShares[slot]=shares>registered?0:registered-shares;
    }

    function _min(uint256 a,uint256 b) internal pure returns(uint256){return a<b?a:b;}
}

contract PoLManager is PoLStorage {

    address public immutable executionFacet;
    function _delegate(bytes memory input) private returns(bytes memory result) {
        delegateActionArmed=true;
        (bool ok,bytes memory output)=executionFacet.delegatecall(input);
        delegateActionArmed=false;
        if(!ok) assembly { revert(add(output,32),mload(output)) }
        return output;
    }
    fallback() external payable {
        address target=executionFacet;
        assembly {
            calldatacopy(0,0,calldatasize())
            let success := delegatecall(gas(),target,0,calldatasize(),0,0)
            returndatacopy(0,0,returndatasize())
            switch success
            case 0 { revert(0,returndatasize()) }
            default { return(0,returndatasize()) }
        }
    }

    constructor(DeployConfig memory c) {
        if(c.executionFacet.code.length==0)revert Invalid();
        executionFacet=c.executionFacet;
        if(c.initialOwner==address(0) || c.curvePool.code.length==0 ||
            c.curveLpToken.code.length==0 || c.uniPositionManager.code.length==0 ||
            c.swapRouter.code.length==0 || c.sdtToken.code.length==0 ||
            c.sdtYearnIndex>1 || c.sdtEulerIndex>1 ||
            (c.curveGauge!=address(0) && c.curveGauge.code.length==0)) revert Invalid();
        owner=c.initialOwner;
        curvePool=c.curvePool; curveLpToken=c.curveLpToken; curveGauge=c.curveGauge;
        curveIsNG=c.curveIsNG;
        sdtToken=c.sdtToken; swapRouter=c.swapRouter;
        sdtYearnIndex=c.sdtYearnIndex; sdtEulerIndex=c.sdtEulerIndex;
        for(uint256 i;i<3;++i) {
            if(c.curveCoins[i].code.length==0 || IPOLCurve(c.curvePool).coins(i)!=c.curveCoins[i]) revert Invalid();
            curveCoins[i]=c.curveCoins[i];
        }
        for(uint8 i;i<4;++i) {
            address v=i<2?c.yearnVaults[i]:c.eulerMarkets[i-2];
            if(v.code.length==0) revert Invalid();
            address a=IPOLVault(v).asset();
            if(a.code.length==0) revert Invalid();
            if(i<2){yearnVaults[i]=v;yearnAssets[i]=a;}
            else{eulerMarkets[i-2]=v;eulerAssets[i-2]=a;}
            uint8 decimals_=IPOLToken(v).decimals();
            if(decimals_>30) revert Invalid();
            shareUnits[i]=10**uint256(decimals_);
            uint256 p=IPOLVault(v).convertToAssets(shareUnits[i]);
            if(p==0) revert Invalid();
            highWatermarkPPS[i]=p;
        }
        if(yearnAssets[c.sdtYearnIndex]!=c.sdtToken || eulerAssets[c.sdtEulerIndex]!=c.sdtToken) revert Invalid();
        uniPositionManager=c.uniPositionManager; uniTokenId=c.uniTokenId;
        IPOLNFT.Position memory p=IPOLNFT(c.uniPositionManager).positions(c.uniTokenId);
        if(p.token0.code.length==0 || p.token1.code.length==0 || p.tickLower>=p.tickUpper) revert Invalid();
        uniToken0=p.token0;uniToken1=p.token1;uniLowerTick=p.tickLower;uniUpperTick=p.tickUpper;
        address pool=IPOLUniFactory(IPOLNFT(c.uniPositionManager).factory()).getPool(p.token0,p.token1,p.fee);
        if(pool.code.length==0) revert Invalid();
        uniPool=pool;
    }
    function proposeOwner(address newOwner) external onlyOwner { if(newOwner==address(0)) revert Invalid(); pendingOwner=newOwner; emit OwnershipProposed(newOwner); }

    function acceptOwner() external { if(msg.sender!=pendingOwner) revert Unauthorized(); owner=msg.sender;pendingOwner=address(0);emit OwnershipTransferred(msg.sender); }

    function setOperator(address who,bool enabled) external onlyOwner { operators[who]=enabled; }

    function setGuardian(address who) external onlyOwner { guardian=who; }

    function setPaused(bool state) external { if(msg.sender!=owner && !(state && msg.sender==guardian)) revert Unauthorized(); paused=state; }

    function setSafetyLimits(uint16 curveSlippage,uint16 yearnLoss,uint16 eulerLoss) external onlyOwner {
        if(curveSlippage>1500 || yearnLoss>1000 || eulerLoss>1000) revert Invalid();
        maxCurveSlippageBps=curveSlippage;maxYearnLossBps=yearnLoss;maxEulerLossBps=eulerLoss;
    }

    function setCyvlSDTProfitShare(uint16 bps) external onlyOwner {
        if(bps>5000 || (bps>0 && cyvlSDTProfitRecipient==address(0))) revert Invalid();
        if(cyvlSDTProfitShare==0 && bps>0) {
            for(uint8 i;i<4;++i){uint256 p=currentPPS(i);if(p>highWatermarkPPS[i])highWatermarkPPS[i]=p;trackedShares[i]=IPOLToken(_vault(i)).balanceOf(address(this));}
        }
        cyvlSDTProfitShare=bps;
    }

    function setCyvlSDTProfitRecipient(address recipient) external onlyOwner { if(recipient==address(0)) revert Invalid();cyvlSDTProfitRecipient=recipient; }

    function setSdtSwapLimit(address token,uint128 maxAmount) external onlyOwner { if(token==address(0)) revert Invalid();sdtSwapLimits[token]=maxAmount; }

    function setGaugeRewardTokens(address[] calldata list) external onlyOwner {
        if(list.length>16)revert Invalid();delete gaugeRewardTokens;
        for(uint256 i;i<list.length;++i){if(list[i].code.length==0)revert Invalid();gaugeRewardTokens.push(list[i]);}
    }

    function setCurveAutoStake(bool enabled) external onlyOwner { if(enabled && curveGauge==address(0))revert Invalid();autoStakeCurve=enabled; }

    function setRoute(address token,uint8 curveCoinIndex,uint128 maxAmount,bool enabled) external onlyOwner {
        if(token==address(0)||curveCoinIndex>2||(enabled && maxAmount==0))revert Invalid();
        routes[token]=Route(maxAmount,curveCoinIndex,enabled);
    }

    function getRoute(address token) external view returns(Route memory){return routes[token];}

    function setPositionAllocations(uint16[6] calldata bps) external onlyOwner {
        uint256 sum;for(uint256 i;i<6;++i)sum+=bps[i];if(sum!=BPS)revert Invalid();
        positionAllocationBps=bps;allocationsConfigured=true;emit PositionAllocationsSet(bps);
    }

    function setUniAllocationToken0Bps(uint16 bps) external onlyOwner { if(bps>BPS)revert Invalid();uniAllocationToken0Bps=bps; }

    function setFundingToken(address token,bool enabled) external onlyOwner {
        if(token.code.length==0 || isFundingToken[token]==enabled)revert Invalid();
        if(enabled){
            if(fundingTokens.length>=12 || token==curveLpToken || token==yearnVaults[0] || token==yearnVaults[1] || token==eulerMarkets[0] || token==eulerMarkets[1])revert Invalid();
            fundingTokens.push(token);isFundingToken[token]=true;
        }else{
            for(uint256 i;i<fundingTokens.length;++i)if(fundingTokens[i]==token){fundingTokens[i]=fundingTokens[fundingTokens.length-1];fundingTokens.pop();break;}
            isFundingToken[token]=false;availableIncomingFunds[token]=0;
        }
        observedFundingBalance[token]=IPOLToken(token).balanceOf(address(this));
    }

    function pendingIncomingFunds(address token) external view returns(uint256) {
        if(!isFundingToken[token])return 0;
        uint256 actual=IPOLToken(token).balanceOf(address(this));uint256 prev=observedFundingBalance[token];
        uint256 pending=availableIncomingFunds[token]+(actual>prev?actual-prev:0);
        return pending>actual?actual:pending;
    }

    function syncIncomingFunds() external nonReentrant trackIncoming {}

    function allocateIncomingFunds(address token,uint256 amount) external onlyOperator whenActive nonReentrant trackIncoming returns(uint256[6] memory minted){
        if(!allocationsConfigured || !isFundingToken[token])revert Invalid();
        if(amount==0)amount=availableIncomingFunds[token];
        if(amount==0 || amount>availableIncomingFunds[token])revert Invalid();
        availableIncomingFunds[token]-=amount;
        uint8 last;for(uint8 i;i<6;++i)if(positionAllocationBps[i]>0)last=i;
        uint256 remaining=amount;
        for(uint8 i;i<6;++i){
            uint256 part=i==last?remaining:amount*positionAllocationBps[i]/BPS;
            if(i!=last)remaining-=part;
            if(part>0)minted[i]=abi.decode(_delegate(abi.encodeWithSelector(PoLManagerFacet.investToPosition.selector,i,token,part,address(0),uint256(0),uniAllocationToken0Bps,uint256(0),uint128(0))),(uint256));
        }
    }

    function rescueToken(address token,address recipient,uint256 amount) external onlyOwner nonReentrant trackIncoming {
        if(recipient==address(0)||token==yearnVaults[0]||token==yearnVaults[1]||token==eulerMarkets[0]||token==eulerMarkets[1]||token==curveLpToken||token==address(curveGauge))revert Invalid();
        _send(token,recipient,amount);
    }

    function depositCurveOne(uint8 coin,uint256 amount,uint256 minLp) external onlyOperator whenActive nonReentrant trackIncoming returns(uint256){return _curveDeposit(coin,amount,minLp);}

    function withdrawCurveOne(uint8 coin,uint256 lp,uint256 minAmountOut,bool unstakeFirst) external onlyOperator nonReentrant trackIncoming returns(uint256){return _curveWithdraw(coin,lp,minAmountOut,unstakeFirst);}

    function stakeCurveLp(uint256 lp) external onlyOperator whenActive nonReentrant trackIncoming {if(curveGauge==address(0))revert Invalid();_approve(curveLpToken,curveGauge,lp);IPOLCurveGauge(curveGauge).deposit(lp);_approve(curveLpToken,curveGauge,0);}

    function unstakeCurveLp(uint256 lp) external onlyOperator nonReentrant trackIncoming {IPOLCurveGauge(curveGauge).withdraw(lp);}

    function depositYearn(uint8 index,uint256 amount,uint256 minShares) external onlyOperator whenActive nonReentrant trackIncoming returns(uint256){if(index>1)revert Invalid();return _depositVault(index,amount,minShares);}

    function redeemYearn(uint8 index,uint256 shares,uint256 minAssets) external onlyOperator nonReentrant trackIncoming returns(uint256){if(index>1)revert Invalid();_requireHarvest(index);return _redeemVault(index,shares,minAssets);}

    function depositEuler(uint8 index,uint256 amount,uint256 minShares) external onlyOperator whenActive nonReentrant trackIncoming returns(uint256){if(index>1)revert Invalid();return _depositVault(index+2,amount,minShares);}

    function redeemEuler(uint8 index,uint256 shares,uint256 minAssets) external onlyOperator nonReentrant trackIncoming returns(uint256){if(index>1)revert Invalid();_requireHarvest(index+2);return _redeemVault(index+2,shares,minAssets);}

    function pendingProfitShares(uint8 slot) external view returns(uint256){
        address v=_vault(slot);uint256 p=currentPPS(slot);uint256 h=highWatermarkPPS[slot];
        if(p<=h || cyvlSDTProfitShare==0)return 0;
        uint256 held=IPOLToken(v).balanceOf(address(this));
        uint256 eligible=held<trackedShares[slot]?held:trackedShares[slot];
        return eligible*(p-h)*cyvlSDTProfitShare/(p*BPS);
    }

    function _harvestPPS(uint8 slot) private returns(uint256 amountSDT){
        address v=_vault(slot);uint256 price=currentPPS(slot);uint256 old=highWatermarkPPS[slot];
        uint256 balance=IPOLToken(v).balanceOf(address(this));
        if(price<=old || cyvlSDTProfitShare==0 || balance==0){
            if(price>old)highWatermarkPPS[slot]=price;
            trackedShares[slot]=balance;
            return 0;
        }
        uint256 eligible=_min(balance,trackedShares[slot]);
        if(eligible==0){highWatermarkPPS[slot]=price;trackedShares[slot]=balance;return 0;}
        uint256 feeShares=eligible*(price-old)*cyvlSDTProfitShare/(price*BPS);
        if(feeShares==0 || feeShares>_maxRedeem(slot))return 0;
        uint256 assets=_redeemVault(slot,feeShares,0);
        amountSDT=_convertSDT(_asset(slot),assets);
        highWatermarkPPS[slot]=price;
        trackedShares[slot]=IPOLToken(v).balanceOf(address(this));
        emit VaultHarvested(slot,feeShares,amountSDT,price);
    }

    function _harvestCurve() private returns(uint256 paidSDT){
        if(curveGauge==address(0))return 0;
        uint256 n=gaugeRewardTokens.length;
        uint256[] memory claimed=new uint256[](n);
        for(uint256 i;i<n;++i)claimed[i]=IPOLToken(gaugeRewardTokens[i]).balanceOf(address(this));
        IPOLCurveGauge(curveGauge).claim_rewards();
        for(uint256 i;i<n;++i)claimed[i]=IPOLToken(gaugeRewardTokens[i]).balanceOf(address(this))-claimed[i];
        for(uint256 i;i<n;++i){
            uint256 amount=claimed[i];if(amount==0)continue;
            uint256 cut=amount*cyvlSDTProfitShare/BPS;
            if(cut>0)paidSDT+=_convertSDT(gaugeRewardTokens[i],cut);
            if(amount>cut){(uint8 coin,uint256 out)=_curveInput(gaugeRewardTokens[i],amount-cut);_curveDeposit(coin,out,0);}
        }
    }

    function harvest() external onlyOperator whenActive nonReentrant trackIncoming returns(uint256 paidSDT){
        if(cyvlSDTProfitShare>0 && cyvlSDTProfitRecipient==address(0))revert Invalid();
        paidSDT=_harvestCurve()+abi.decode(_delegate(abi.encodeWithSelector(PoLManagerFacet.harvestUniPart.selector)),(uint256));
        for(uint8 i;i<4;++i)paidSDT+=_harvestPPS(i);
        if(paidSDT>0){_send(sdtToken,cyvlSDTProfitRecipient,paidSDT);emit ProfitPaid(cyvlSDTProfitRecipient,paidSDT);}
    }

    function curveExposure() external view returns(uint256 idleLp,uint256 gaugeLp){idleLp=IPOLToken(curveLpToken).balanceOf(address(this));if(curveGauge!=address(0))gaugeLp=IPOLCurveGauge(curveGauge).balanceOf(address(this));}

    function vaultShares() external view returns(uint256,uint256,uint256,uint256){return(IPOLToken(yearnVaults[0]).balanceOf(address(this)),IPOLToken(yearnVaults[1]).balanceOf(address(this)),IPOLToken(eulerMarkets[0]).balanceOf(address(this)),IPOLToken(eulerMarkets[1]).balanceOf(address(this)));}
}

contract PoLManagerFacet is PoLStorage {

    /// @dev Internal delegate-only entrypoints. An already locked core operation
    ///      must be in progress; they cannot be invoked as standalone external actions.
    function investToPosition(uint8 dest,address a,uint256 va,address b,uint256 vb,uint16 uniSplit,uint256 minShares,uint128 minUni)
        external returns(uint256 units) {
        if(lock!=2 || !delegateActionArmed)revert State();
        delegateActionArmed=false;
        return _invest(dest,a,va,b,vb,uniSplit,minShares,minUni);
    }
    function harvestUniPart() external returns(uint256 paid) {
        if(lock!=2 || !delegateActionArmed)revert State();
        delegateActionArmed=false;
        return _harvestUni();
    }

    function onERC721Received(address,address,uint256 tokenId,bytes calldata) external returns(bytes4){
        if(msg.sender!=uniPositionManager || tokenId!=uniTokenId || uniNftReceived)revert Invalid();
        IPOLNFT.Position memory p=IPOLNFT(uniPositionManager).positions(tokenId);
        uniPrincipalOwed0=p.tokensOwed0;uniPrincipalOwed1=p.tokensOwed1;uniNftReceived=true;
        return this.onERC721Received.selector;
    }

    function _position() private view returns(IPOLNFT.Position memory p){
        IPOLNFT m=IPOLNFT(uniPositionManager);
        if(m.ownerOf(uniTokenId)!=address(this))revert State();
        p=m.positions(uniTokenId);
        if(p.token0!=uniToken0 || p.token1!=uniToken1 || p.tickLower!=uniLowerTick || p.tickUpper!=uniUpperTick)revert Invalid();
    }

    function configureUniPolicy(UniPolicy calldata p) external onlyOwner {
        if(p.twapSeconds<60 || p.twapSeconds>86400 || p.minActionInterval<300 ||
            p.maxSpotTwapDifference>2500 || p.bufferTicks<0 || p.bufferTicks>2000 ||
            p.outOfRangeWithdrawBps>BPS || int256(uniLowerTick)+int256(p.bufferTicks)>=int256(uniUpperTick)-int256(p.bufferTicks))revert Invalid();
        uniPolicy=p;
    }

    function uniTicks() public view returns(int24 twap,int24 spot){
        uint32 dt=uniPolicy.twapSeconds;
        if(dt==0)revert Invalid();
        uint32[] memory times=new uint32[](2);times[0]=dt;
        (int56[] memory cum,)=IPOLUniPool(uniPool).observe(times);
        int56 diff=cum[1]-cum[0];int56 divisor=int56(uint56(dt));
        twap=int24(diff/divisor);
        if(diff<0 && diff%divisor!=0)--twap;
        (,spot,,,,,)=IPOLUniPool(uniPool).slot0();
    }

    function uniSignal() public view returns(uint8 action,int24 twap,int24 spot){
        UniPolicy memory p=uniPolicy;
        if(!p.enabled)return(0,0,0);
        (twap,spot)=uniTicks();
        uint256 diff=uint256(twap>spot?int256(twap)-int256(spot):int256(spot)-int256(twap));
        if(diff>p.maxSpotTwapDifference)return(0,twap,spot);
        int256 t=int256(twap);int256 b=int256(p.bufferTicks);
        if(t>=int256(uniLowerTick)+b && t<=int256(uniUpperTick)-b)return(1,twap,spot);
        if(t<int256(uniLowerTick)-b || t>int256(uniUpperTick)+b)return(2,twap,spot);
    }

    function _uniIncrease(uint256 amount0,uint256 amount1,uint256 min0,uint256 min1) private returns(uint128 liquidity,uint256 used0,uint256 used1){
        _approve(uniToken0,uniPositionManager,amount0);
        _approve(uniToken1,uniPositionManager,amount1);
        (liquidity,used0,used1)=IPOLNFT(uniPositionManager).increaseLiquidity(IPOLNFT.Increase(uniTokenId,amount0,amount1,min0,min1,block.timestamp));
        _approve(uniToken0,uniPositionManager,0);
        _approve(uniToken1,uniPositionManager,0);
    }

    function _uniDecrease(uint128 liquidity,uint256 min0,uint256 min1) private returns(uint256 a0,uint256 a1){
        (a0,a1)=IPOLNFT(uniPositionManager).decreaseLiquidity(IPOLNFT.Decrease(uniTokenId,liquidity,min0,min1,block.timestamp));
        uniPrincipalOwed0+=a0;uniPrincipalOwed1+=a1;
    }

    function executeUniPolicy(uint256 desired0,uint256 desired1,uint256 min0,uint256 min1,uint128 minLiquidityAdded)
        external onlyOperator whenActive nonReentrant trackIncoming returns(uint8 action){
        if(block.timestamp<lastUniActionAt+uniPolicy.minActionInterval)revert State();
        (action,,)=uniSignal();if(action==0)revert State();
        IPOLNFT.Position memory p=_position();lastUniActionAt=block.timestamp;
        if(action==1){
            uint256 b0=IPOLToken(uniToken0).balanceOf(address(this));uint256 b1=IPOLToken(uniToken1).balanceOf(address(this));
            uint256 a0=_min(desired0,_min(uniPolicy.maxAdd0,b0>uniPendingCompound0?b0-uniPendingCompound0:0));
            uint256 a1=_min(desired1,_min(uniPolicy.maxAdd1,b1>uniPendingCompound1?b1-uniPendingCompound1:0));
            (uint128 liq,uint256 used0,uint256 used1)=_uniIncrease(a0,a1,min0,min1);
            if(liq<minLiquidityAdded || liq==0)revert Slippage();
            emit UniAction(1,used0,used1,liq);
        }else{
            uint128 removed=uint128(uint256(p.liquidity)*uniPolicy.outOfRangeWithdrawBps/BPS);
            if(removed==0)revert State();
            (uint256 a0,uint256 a1)=_uniDecrease(removed,min0,min1);
            emit UniAction(2,a0,a1,removed);
        }
    }

    function withdrawUniNFT(address recipient) external onlyOwner nonReentrant {
        if(recipient==address(0))revert Invalid();
        _position();IPOLNFT(uniPositionManager).safeTransferFrom(address(this),recipient,uniTokenId);
        uniNftReceived=false;uniPrincipalOwed0=0;uniPrincipalOwed1=0;
    }

    function _removeUniPrincipal(uint256 bps,uint256 min0,uint256 min1) private returns(uint256 a0,uint256 a1){
        if(bps==0 || bps>BPS)revert Invalid();
        uint128 liq=uint128(uint256(_position().liquidity)*bps/BPS);
        if(liq==0)revert Invalid();
        (a0,a1)=_uniDecrease(liq,min0,min1);
        if(a0>type(uint128).max || a1>type(uint128).max)revert Invalid();
        (uint256 paid0,uint256 paid1)=IPOLNFT(uniPositionManager).collect(IPOLNFT.Collect(uniTokenId,address(this),uint128(a0),uint128(a1)));
        if(paid0!=a0 || paid1!=a1)revert State();
        uniPrincipalOwed0-=a0;uniPrincipalOwed1-=a1;
    }

    function _uniAddTokens(uint256 a0,uint256 a1,uint128 minL) private returns(uint256 minted){
        if(!uniPolicy.enabled || uniSignalCode()!=1)revert State();
        _position();
        if(a0>uniPolicy.maxAdd0 || a1>uniPolicy.maxAdd1)revert Invalid();
        (uint128 delta,,)=_uniIncrease(a0,a1,0,0);
        if(delta==0 || delta<minL)revert Slippage();
        minted=delta;
    }

    function uniSignalCode() private view returns(uint8 action){(action,,)=uniSignal();}

    function _uniAddAsset(address token,uint256 amount,uint16 bps,uint128 minL) private returns(uint256){
        if(bps>BPS)revert Invalid();
        uint256 a0=_convert(token,uniToken0,amount*bps/BPS);
        uint256 a1=_convert(token,uniToken1,amount-amount*bps/BPS);
        return _uniAddTokens(a0,a1,minL);
    }

    function _invest(uint8 dest,address tokenA,uint256 a,address tokenB,uint256 b,uint16 uniSplit,uint256 minShares,uint128 minUni)
        private returns(uint256 units){
        if(dest>=6 || (a==0 && b==0))revert Invalid();
        if(dest==0){
            if(a>0){(uint8 coin,uint256 out)=_curveInput(tokenA,a);units+=_curveDeposit(coin,out,0);}
            if(b>0){(uint8 coin,uint256 out)=_curveInput(tokenB,b);units+=_curveDeposit(coin,out,0);}
        } else if(dest==1){
            if(b>0){uint256 u0=_convert(tokenA,uniToken0,a);uint256 u1=_convert(tokenB,uniToken1,b);units=_uniAddTokens(u0,u1,minUni);}
            else{units=_uniAddAsset(tokenA,a,uniSplit,minUni);}
        }else{
            uint8 slot=dest-2;address asset=_asset(slot);
            uint256 converted=_convert(tokenA,asset,a)+_convert(tokenB,asset,b);
            units=_depositVault(slot,converted,minShares);
        }
        if(units==0 || units<minShares)revert Slippage();
    }

    function migrateLiquidity(Migration calldata m) external onlyOperator whenActive nonReentrant trackIncoming returns(uint256 result){
        if(m.source>=6 || m.destination>=6 || m.source==m.destination || m.amount==0 || m.uniToken0Bps>BPS)revert Invalid();
        address tokenA;address tokenB;uint256 a;uint256 b;
        if(m.source==0){
            uint256 idle=IPOLToken(curveLpToken).balanceOf(address(this));
            if(m.amount>idle){if(curveGauge==address(0))revert State();IPOLCurveGauge(curveGauge).withdraw(m.amount-idle);}
            tokenA=curveCoins[m.curveExitCoin];a=_curveWithdraw(m.curveExitCoin,m.amount,0,false);
        }else if(m.source==1){
            (a,b)=_removeUniPrincipal(m.amount,m.minUniRemoved0,m.minUniRemoved1);
            tokenA=uniToken0;tokenB=uniToken1;
        }else{
            uint8 slot=m.source-2;_requireHarvest(slot);
            tokenA=_asset(slot);a=_redeemVault(slot,m.amount,0);
        }
        result=_invest(m.destination,tokenA,a,tokenB,b,m.uniToken0Bps,m.minDestinationShares,m.minUniLiquidity);
        emit LiquidityMigrated(m.source,m.destination,m.amount,result);
    }

    function _harvestUni() private returns(uint256 paidSDT){
        _position();
        (uint256 r0,uint256 r1)=IPOLNFT(uniPositionManager).collect(IPOLNFT.Collect(uniTokenId,address(this),type(uint128).max,type(uint128).max));
        uint256 principal0=_min(r0,uniPrincipalOwed0);uint256 principal1=_min(r1,uniPrincipalOwed1);
        uniPrincipalOwed0-=principal0;uniPrincipalOwed1-=principal1;
        uint256 earned0=r0-principal0;uint256 earned1=r1-principal1;
        uint256 fee0=earned0*cyvlSDTProfitShare/BPS;uint256 fee1=earned1*cyvlSDTProfitShare/BPS;
        paidSDT+=_convertSDT(uniToken0,fee0);
        paidSDT+=_convertSDT(uniToken1,fee1);
        uniPendingCompound0+=earned0-fee0;uniPendingCompound1+=earned1-fee1;
        if(uniSignalCode()!=1)return paidSDT;
        uint256 a0=_min(uniPendingCompound0,_min(IPOLToken(uniToken0).balanceOf(address(this)),uniPolicy.maxAdd0));
        uint256 a1=_min(uniPendingCompound1,_min(IPOLToken(uniToken1).balanceOf(address(this)),uniPolicy.maxAdd1));
        if(a0==0 || a1==0)return paidSDT;
        // A small unbalanced fee remainder should not block the other four positions' harvest.
        _approve(uniToken0,uniPositionManager,a0);_approve(uniToken1,uniPositionManager,a1);
        try IPOLNFT(uniPositionManager).increaseLiquidity(IPOLNFT.Increase(uniTokenId,a0,a1,0,0,block.timestamp)) returns(uint128 l,uint256 used0,uint256 used1){
            if(l>0){uniPendingCompound0-=used0;uniPendingCompound1-=used1;}
        }catch{}
        _approve(uniToken0,uniPositionManager,0);_approve(uniToken1,uniPositionManager,0);
    }

    function _rateKey(uint8 from,uint8 to) private pure returns(uint8){if(from>2 || to>2 || from==to)revert Invalid();return from*3+to;}

    function setRateRule(uint8 from,uint8 to,RateParams calldata p) external onlyOwner {
        uint8 key=_rateKey(from,to);
        if(p.enabled && (p.quoteAmountIn==0 || p.targetRateWad==0 || p.maxOracleDeviationBps>2000 ||
            p.yearnRedeemBps>BPS || p.sdtRedeemBps>BPS ||
            (p.yearnRedeemBps==0 && p.sdtRedeemBps==0) || p.minPersistSeconds<300 || p.cooldownSeconds<3600))revert Invalid();
        rateStates[key]=RateState(p,0,0);
    }

    function setGlobalRateCooldown(uint32 seconds_) external onlyOwner {if(seconds_<3600 || seconds_>30 days)revert Invalid();globalRateCooldown=seconds_;}

    function getRateRule(uint8 from,uint8 to) external view returns(RateState memory){return rateStates[_rateKey(from,to)];}

    function rateStatus(uint8 from,uint8 to) public view returns(uint256 spotWad,uint256 referenceWad,uint256 deviationBps){
        RateParams memory p=rateStates[_rateKey(from,to)].params;
        if(p.quoteAmountIn==0)revert Invalid();
        uint256 out=IPOLCurve(curvePool).get_dy(int128(uint128(from)),int128(uint128(to)),p.quoteAmountIn);
        uint256 denom=p.quoteAmountIn*10**uint256(IPOLToken(curveCoins[to]).decimals());
        spotWad=out*10**uint256(IPOLToken(curveCoins[from]).decimals())*WAD/denom;
        referenceWad=IPOLRouter(swapRouter).price_oracle(curveCoins[from],curveCoins[to]);
        if(referenceWad==0)revert Invalid();
        deviationBps=(spotWad>referenceWad?spotWad-referenceWad:referenceWad-spotWad)*BPS/referenceWad;
    }

    function observeRate(uint8 from,uint8 to) external whenActive nonReentrant {
        RateState storage r=rateStates[_rateKey(from,to)];if(!r.params.enabled)revert State();
        (uint256 spot,,uint256 dev)=rateStatus(from,to);
        if(spot>=r.params.targetRateWad && dev<=r.params.maxOracleDeviationBps){if(r.armedAt==0)r.armedAt=uint64(block.timestamp);}
        else r.armedAt=0;
    }

    function executeRateTrigger(uint8 from,uint8 to) external whenActive nonReentrant trackIncoming returns(uint256 yearnShares,uint256 sdtShares){
        RateState storage r=rateStates[_rateKey(from,to)];RateParams memory p=r.params;
        if(!p.enabled || r.armedAt==0 || block.timestamp<uint256(r.armedAt)+p.minPersistSeconds ||
            block.timestamp<uint256(r.lastTriggeredAt)+p.cooldownSeconds ||
            block.timestamp<lastGlobalRateExecutionAt+globalRateCooldown)revert State();
        (uint256 spot,,uint256 dev)=rateStatus(from,to);
        if(spot<p.targetRateWad || dev>p.maxOracleDeviationBps)revert State();
        _requireHarvest(0);_requireHarvest(sdtEulerIndex+2);
        yearnShares=_min(IPOLToken(yearnVaults[0]).balanceOf(address(this))*p.yearnRedeemBps/BPS,_maxRedeem(0));
        sdtShares=_min(IPOLToken(eulerMarkets[sdtEulerIndex]).balanceOf(address(this))*p.sdtRedeemBps/BPS,_maxRedeem(sdtEulerIndex+2));
        if(yearnShares==0 && sdtShares==0)revert State();
        r.lastTriggeredAt=uint64(block.timestamp);r.armedAt=0;lastGlobalRateExecutionAt=block.timestamp;
        if(yearnShares>0){uint256 a=_redeemVault(0,yearnShares,0);(uint8 coin,uint256 out)=_curveInput(yearnAssets[0],a);_curveDeposit(coin,out,0);}
        if(sdtShares>0){uint256 a=_redeemVault(sdtEulerIndex+2,sdtShares,0);(uint8 coin,uint256 out)=_curveInput(sdtToken,a);_curveDeposit(coin,out,0);}
        emit RateTriggered(from,to,yearnShares,sdtShares);
    }
}
