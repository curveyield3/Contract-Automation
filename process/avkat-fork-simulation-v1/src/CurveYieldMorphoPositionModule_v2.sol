// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * @title CurveYield Morpho Position Module v2
 * @notice Secondary Safe module for Morpho positions outside the primary avKAT/KAT market.
 * @dev Reuses the deployed primary module's Safe swap entry point, router selection,
 *      and primary-market loop-up. No NFT, vault, claim, gas, routing or primary-market
 *      management is duplicated. All position ownership stays with the Safe.
 *      The secondary executor role is separately granted by the Safe.
 */
struct CYMarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}
struct CYMarket {
    uint128 totalSupplyAssets;
    uint128 totalSupplyShares;
    uint128 totalBorrowAssets;
    uint128 totalBorrowShares;
    uint128 lastUpdate;
    uint128 fee;
}
interface ICYMorpho {
    function idToMarketParams(bytes32 id) external view returns (CYMarketParams memory);
    function market(bytes32 id) external view returns (CYMarket memory);
    function position(bytes32 id, address owner) external view returns (uint256, uint128, uint128);
    function accrueInterest(CYMarketParams memory p) external;
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
    function supplyCollateral(CYMarketParams memory p,uint256 assets,address owner,bytes calldata data) external;
    function borrow(CYMarketParams memory p,uint256 assets,uint256 shares,address owner,address receiver) external returns(uint256,uint256);
    function repay(CYMarketParams memory p,uint256 assets,uint256 shares,address owner,bytes calldata data) external returns(uint256,uint256);
    function withdrawCollateral(CYMarketParams memory p,uint256 assets,address owner,address receiver) external;
}
interface ICYSafe {
    function execTransactionFromModuleReturnData(address to,uint256 value,bytes calldata data,uint8 operation) external returns(bool,bytes memory);
}
interface ICYToken {
    function balanceOf(address owner) external view returns(uint256);
    function transfer(address receiver,uint256 amount) external returns(bool);
    function approve(address spender,uint256 amount) external returns(bool);
}
interface ICYOracle { function price() external view returns(uint256); }
interface ICYIrm { function borrowRateView(CYMarketParams memory p,CYMarket memory m) external view returns(uint256); }

interface ICYPrimary {
    struct Swap { address tokenIn; address tokenOut; uint256 amountIn; }
    struct RangeExit { uint256 rangeId; uint128 liquidity; uint256 min0; uint256 min1; bool burnIfEmpty; }
    struct VaultExit { address vault; uint256 shares; uint256 min0; uint256 min1; }
    struct PreSteps { RangeExit[] ranges; VaultExit[] vaults; Swap[] toKat; }
    struct LoopUp { uint256 maxFlash; uint256 minFlash; uint256 minAvkatPerKatWad; uint256 maxLtv; uint256 deadline; }
    function SAFE() external view returns(address);
    function MORPHO() external view returns(address);
    function LOOP_MARKET() external view returns(bytes32);
    function executeApprovedSwaps(Swap[] calldata requests) external;
    function atomicLoopUp(PreSteps calldata pre,LoopUp calldata plan) external;
}
contract CurveYieldMorphoPositionModule {
    uint256 private constant WAD=1e18;
    uint8 public constant UP=1;
    uint8 public constant DOWN=2;
    uint8 public constant MIGRATE=4;

    ICYPrimary public immutable PRIMARY;
    ICYSafe public immutable SAFE;
    ICYMorpho public immutable MORPHO;
    bytes32 public immutable PRIMARY_MARKET;

    struct Policy { uint64 targetLtv; uint8 operations; }
    mapping(bytes32=>Policy) public marketPolicy;
    mapping(address=>bool) public isExecutor;
    bool private transient locked;
    bytes32 private transient commitment;

    struct Hop { address tokenOut; uint256 minOut; }
    // Minimum raw collateral units per raw loan unit, scaled by 1e18.
    struct UpPlan { uint256 flash; uint256 minRate; Hop[] hops; }
    struct DownPlan {
        uint256 repayShares;     // max uint = all live shares
        uint256 withdrawAssets;  // max uint = all live collateral
        uint256 sellAssets;      // max uint = all withdrawn collateral
        uint256 maxRepayAssets;
        uint256 minEquityOut;
        Hop[] hops;
    }
    struct State {
        uint256 collateral;
        uint256 borrowShares;
        uint256 debt;
        uint256 oraclePrice;
        uint256 collateralValue;
        int256 equity;
        uint256 ltv;
    }
    struct Action {
        bytes32 id;
        uint256 flash;
        uint256 seed;
        uint256 shares;
        uint256 withdrawAssets;
        uint256 sellAssets;
        uint256 minimum;
        uint256 deadline;
        bool up;
        Hop[] hops;
    }
    error Unauthorized();
    error InvalidMarket();
    error InvalidAmount();
    error InvalidPolicy();
    error Callback();
    error ExternalCallFailed();
    error Slippage();
    error ExcessLtv(uint256 actual,uint256 limit);
    event ExecutorSet(address indexed executor,bool enabled);
    event PolicySet(bytes32 indexed id,uint64 targetLtv,uint8 operations);
    event Looped(bytes32 indexed id,uint256 seed,uint256 flash,uint256 collateralAdded,uint256 finalLtv);
    event Unwound(bytes32 indexed id,uint256 sharesRepaid,uint256 collateralWithdrawn,uint256 loanEquity,uint256 finalLtv);
    event Migrated(bytes32 indexed fromId,bytes32 indexed toId,uint256 sourceEquity,uint256 destinationSeed,uint256 destinationFlash);

    modifier onlySafe(){if(msg.sender!=address(SAFE)) revert Unauthorized(); _;}
    modifier operation(uint256 deadline){
        if(msg.sender!=address(SAFE)&&!isExecutor[msg.sender]) revert Unauthorized();
        if(locked||block.timestamp>deadline) revert Callback();
        locked=true; _; locked=false;
    }
    constructor(address primary){
        if(primary.code.length==0) revert InvalidPolicy();
        PRIMARY=ICYPrimary(primary);
        SAFE=ICYSafe(ICYPrimary(primary).SAFE());
        MORPHO=ICYMorpho(ICYPrimary(primary).MORPHO());
        PRIMARY_MARKET=ICYPrimary(primary).LOOP_MARKET();
        if(address(SAFE).code.length==0||address(MORPHO).code.length==0) revert InvalidPolicy();
        _params(PRIMARY_MARKET);
    }
    function setExecutor(address executor,bool enabled) external onlySafe {
        if(executor==address(0)||executor==address(this)) revert InvalidPolicy();
        isExecutor[executor]=enabled;
        emit ExecutorSet(executor,enabled);
    }
    function setMarketPolicy(bytes32 id,uint64 target,uint8 permissions) external onlySafe {
        if(id==PRIMARY_MARKET||permissions>7||target==0||target>=_params(id).lltv) revert InvalidPolicy();
        marketPolicy[id]=Policy(target,permissions);
        emit PolicySet(id,target,permissions);
    }
    /// @notice Reads the Safe's actual position, including positions opened outside either module.
    function positionState(bytes32 id) public view returns(State memory){
        CYMarketParams memory p=_params(id);
        CYMarket memory m=MORPHO.market(id);
        uint256 assets=m.totalBorrowAssets;
        if(block.timestamp>m.lastUpdate&&assets!=0&&p.irm!=address(0)){
            uint256 first=ICYIrm(p.irm).borrowRateView(p,m)*(block.timestamp-m.lastUpdate);
            uint256 second=_mulDiv(first,first,2*WAD);
            uint256 third=_mulDiv(second,first,3*WAD);
            assets+=_mulDiv(assets,first+second+third,WAD);
        }
        return _state(id,p,assets,m.totalBorrowShares);
    }
    function loopUp(bytes32 id,uint256 seed,UpPlan calldata plan,uint256 deadline)
        external operation(deadline) returns(uint256 collateralAdded)
    {
        return _up(id,_allowed(id,UP),seed,plan,deadline);
    }
    /// @notice Partial unwind or close; use max uint for all shares and collateral.
    /// @dev If all collateral is sold, remaining loan-token equity stays in the Safe.
    function loopDown(bytes32 id,DownPlan calldata plan,uint256 deadline)
        external operation(deadline) returns(uint256 equity)
    {
        return _down(id,_allowed(id,DOWN),plan,deadline);
    }
    /// @notice Migrate secondary-market equity into another secondary market, or
    ///         into the primary market using ONLY the primary module's loop-up.
    function migratePosition(bytes32 fromId,bytes32 toId,DownPlan calldata down,
        Hop[] calldata bridge,uint256 minSeed,UpPlan calldata up,uint256 deadline)
        external operation(deadline) returns(uint256 added)
    {
        if(fromId==toId||minSeed==0) revert InvalidAmount();
        CYMarketParams memory src=_allowed(fromId,DOWN|MIGRATE);
        CYMarketParams memory dst=toId==PRIMARY_MARKET?_params(toId):_allowed(toId,UP|MIGRATE);
        (,,uint128 col)=MORPHO.position(fromId,address(SAFE));
        uint256 take=down.withdrawAssets==type(uint256).max?col:down.withdrawAssets;
        if(down.sellAssets!=type(uint256).max&&down.sellAssets!=take) revert InvalidAmount();
        uint256 equity=_down(fromId,src,down,deadline);
        uint256 seed=_swap(src.loanToken,dst.loanToken,equity,bridge);
        if(seed<minSeed) revert Slippage();
        added=toId==PRIMARY_MARKET?_intoPrimary(dst,seed,up,deadline):_up(toId,dst,seed,up,deadline);
        emit Migrated(fromId,toId,equity,seed,up.flash);
    }
    function _intoPrimary(CYMarketParams memory p,uint256 seed,UpPlan memory plan,uint256 deadline)
        private returns(uint256 added)
    {
        if(plan.hops.length!=0||plan.flash==0||plan.minRate==0) revert InvalidAmount();
        // Original atomicLoopUp consumes all loose Safe KAT and avKAT. Temporarily
        // isolate only the preexisting balances; restore them before transaction end.
        uint256 heldLoan=_safeBalance(p.loanToken)-seed;
        uint256 heldCol=_safeBalance(p.collateralToken);
        if(heldLoan!=0) _safeTransfer(p.loanToken,address(this),heldLoan);
        if(heldCol!=0) _safeTransfer(p.collateralToken,address(this),heldCol);
        if(_safeBalance(p.loanToken)!=seed||_safeBalance(p.collateralToken)!=0) revert InvalidAmount();
        (,,uint128 beforeCol)=MORPHO.position(PRIMARY_MARKET,address(SAFE));
        ICYPrimary.PreSteps memory empty=ICYPrimary.PreSteps(new ICYPrimary.RangeExit[](0),new ICYPrimary.VaultExit[](0),new ICYPrimary.Swap[](0));
        PRIMARY.atomicLoopUp(empty,ICYPrimary.LoopUp(plan.flash,plan.flash,plan.minRate,0,deadline));
        (,,uint128 afterCol)=MORPHO.position(PRIMARY_MARKET,address(SAFE));
        added=uint256(afterCol)-beforeCol;
        if(added<_mulDivUp(seed+plan.flash,plan.minRate,WAD)) revert Slippage();
        if(heldLoan!=0) _token(p.loanToken,abi.encodeCall(ICYToken.transfer,(address(SAFE),heldLoan)));
        if(heldCol!=0) _token(p.collateralToken,abi.encodeCall(ICYToken.transfer,(address(SAFE),heldCol)));
        if(_safeBalance(p.loanToken)!=heldLoan||_safeBalance(p.collateralToken)!=heldCol) revert InvalidAmount();
    }
    function _up(bytes32 id,CYMarketParams memory p,uint256 seed,UpPlan memory plan,uint256 deadline)
        private returns(uint256 added)
    {
        if(seed+plan.flash==0||plan.minRate==0||_safeBalance(p.loanToken)<seed) revert InvalidAmount();
        MORPHO.accrueInterest(p);
        (,,uint128 beforeCol)=MORPHO.position(id,address(SAFE));
        uint256 beforeLoan=_safeBalance(p.loanToken);
        _run(p,Action(id,plan.flash,seed,0,0,0,_mulDivUp(seed+plan.flash,plan.minRate,WAD),deadline,true,plan.hops));
        (,,uint128 afterCol)=MORPHO.position(id,address(SAFE));
        if(_safeBalance(p.loanToken)!=beforeLoan-seed) revert InvalidAmount();
        added=uint256(afterCol)-beforeCol;
        if(added<_mulDivUp(seed+plan.flash,plan.minRate,WAD)) revert Slippage();
        emit Looped(id,seed,plan.flash,added,_checkLtv(id,p));
    }
    function _down(bytes32 id,CYMarketParams memory p,DownPlan memory plan,uint256 deadline)
        private returns(uint256 equity)
    {
        MORPHO.accrueInterest(p);
        (,uint128 bs,uint128 col)=MORPHO.position(id,address(SAFE));
        uint256 shares=plan.repayShares==type(uint256).max?bs:plan.repayShares;
        uint256 withdraw=plan.withdrawAssets==type(uint256).max?col:plan.withdrawAssets;
        uint256 sell=plan.sellAssets==type(uint256).max?withdraw:plan.sellAssets;
        if(shares>bs||withdraw>col||sell>withdraw||(shares==0&&withdraw==0)) revert InvalidAmount();
        CYMarket memory m=MORPHO.market(id);
        uint256 flash=_mulDivUp(shares,uint256(m.totalBorrowAssets)+1,uint256(m.totalBorrowShares)+1e6);
        if(flash>plan.maxRepayAssets) revert InvalidAmount();
        uint256 beforeLoan=_safeBalance(p.loanToken);
        _run(p,Action(id,flash,0,shares,withdraw,sell,plan.minEquityOut,deadline,false,plan.hops));
        equity=_safeBalance(p.loanToken)-beforeLoan;
        if(equity<plan.minEquityOut) revert Slippage();
        (,uint128 afterShares,uint128 afterCol)=MORPHO.position(id,address(SAFE));
        if(afterShares!=bs-shares||afterCol!=col-withdraw) revert InvalidAmount();
        emit Unwound(id,shares,withdraw,equity,_checkLtv(id,p));
    }
    function _run(CYMarketParams memory p,Action memory a) private {
        uint256 beforeLoan=ICYToken(p.loanToken).balanceOf(address(this));
        if(a.flash==0) _execute(p,a);
        else{
            bytes memory data=abi.encode(a);
            commitment=keccak256(data);
            MORPHO.flashLoan(p.loanToken,a.flash,data);
            if(commitment!=bytes32(0)) revert Callback();
            _approve(p.loanToken,address(MORPHO),0);
        }
        if(ICYToken(p.loanToken).balanceOf(address(this))!=beforeLoan) revert InvalidAmount();
    }
    function onMorphoFlashLoan(uint256 assets,bytes calldata data) external {
        if(msg.sender!=address(MORPHO)||!locked||commitment==bytes32(0)||keccak256(data)!=commitment) revert Callback();
        Action memory a=abi.decode(data,(Action));
        if(assets!=a.flash||block.timestamp>a.deadline) revert Callback();
        commitment=bytes32(0);
        CYMarketParams memory p=_params(a.id);
        _execute(p,a);
        _approve(p.loanToken,address(MORPHO),assets);
    }
    function _execute(CYMarketParams memory p,Action memory a) private {
        if(a.up){
            if(a.flash!=0) _token(p.loanToken,abi.encodeCall(ICYToken.transfer,(address(SAFE),a.flash)));
            uint256 acquired=_swap(p.loanToken,p.collateralToken,a.seed+a.flash,a.hops);
            if(acquired<a.minimum) revert Slippage();
            _safeApprove(p.collateralToken,address(MORPHO),acquired);
            _safe(address(MORPHO),abi.encodeCall(ICYMorpho.supplyCollateral,(p,acquired,address(SAFE),"")));
            _safeApprove(p.collateralToken,address(MORPHO),0);
            if(a.flash!=0){
                (uint256 borrowed,)=abi.decode(_safe(address(MORPHO),abi.encodeCall(ICYMorpho.borrow,(p,a.flash,0,address(SAFE),address(this)))),(uint256,uint256));
                if(borrowed!=a.flash) revert InvalidAmount();
            }
        }else{
            if(a.shares!=0){
                _approve(p.loanToken,address(MORPHO),a.flash);
                (uint256 paid,uint256 shares)=MORPHO.repay(p,0,a.shares,address(SAFE),"");
                _approve(p.loanToken,address(MORPHO),0);
                if(paid!=a.flash||shares!=a.shares) revert InvalidAmount();
            }
            if(a.withdrawAssets!=0) _safe(address(MORPHO),abi.encodeCall(ICYMorpho.withdrawCollateral,(p,a.withdrawAssets,address(SAFE),address(SAFE))));
            uint256 proceeds;
            if(a.sellAssets!=0) proceeds=_swap(p.collateralToken,p.loanToken,a.sellAssets,a.hops);
            else if(a.hops.length!=0) revert InvalidAmount();
            if(proceeds<a.flash+a.minimum) revert Slippage();
            if(a.flash!=0) _safeTransfer(p.loanToken,address(this),a.flash);
        }
    }
    /// @dev Primary module executes every swap from the Safe using its current router.
    ///      Exact input and actual balance-delta output are checked per hop.
    function _swap(address from,address to,uint256 amount,Hop[] memory hops) private returns(uint256){
        if(from==to){if(hops.length!=0) revert InvalidAmount();return amount;}
        if(amount==0||hops.length==0||hops[hops.length-1].tokenOut!=to) revert InvalidAmount();
        ICYPrimary.Swap[] memory req=new ICYPrimary.Swap[](1);
        for(uint256 i;i<hops.length;++i){
            Hop memory h=hops[i];
            if(from==h.tokenOut||h.tokenOut.code.length==0||h.minOut==0) revert InvalidAmount();
            uint256 beforeIn=_safeBalance(from);
            uint256 beforeOut=_safeBalance(h.tokenOut);
            req[0]=ICYPrimary.Swap(from,h.tokenOut,amount);
            PRIMARY.executeApprovedSwaps(req);
            if(beforeIn-_safeBalance(from)!=amount) revert InvalidAmount();
            amount=_safeBalance(h.tokenOut)-beforeOut;
            if(amount<h.minOut) revert Slippage();
            from=h.tokenOut;
        }
        return amount;
    }
    function _params(bytes32 id) private view returns(CYMarketParams memory p){
        p=MORPHO.idToMarketParams(id);
        if(p.loanToken==address(0)||p.collateralToken==address(0)||p.oracle==address(0)||
           p.loanToken==p.collateralToken||p.lltv==0||p.lltv>WAD||keccak256(abi.encode(p))!=id) revert InvalidMarket();
    }
    function _allowed(bytes32 id,uint8 needed) private view returns(CYMarketParams memory p){
        Policy memory pol=marketPolicy[id];
        if(id==PRIMARY_MARKET||(pol.operations&needed)!=needed||pol.targetLtv==0) revert InvalidPolicy();
        return _params(id);
    }
    function _state(bytes32 id,CYMarketParams memory p,uint256 assets,uint256 totalShares) private view returns(State memory s){
        (,uint128 shares,uint128 collateral)=MORPHO.position(id,address(SAFE));
        s.collateral=collateral;s.borrowShares=shares;
        s.debt=_mulDivUp(shares,assets+1,totalShares+1e6);
        s.oraclePrice=ICYOracle(p.oracle).price();
        if(s.oraclePrice==0) revert InvalidMarket();
        s.collateralValue=_mulDiv(collateral,s.oraclePrice,1e36);
        if(s.collateralValue>uint256(type(int256).max)||s.debt>uint256(type(int256).max)) revert InvalidAmount();
        s.equity=int256(s.collateralValue)-int256(s.debt);
        s.ltv=s.debt==0?0:s.collateralValue==0?type(uint256).max:_mulDivUp(s.debt,WAD,s.collateralValue);
    }
    function _checkLtv(bytes32 id,CYMarketParams memory p) private view returns(uint256 ltv){
        CYMarket memory m=MORPHO.market(id);
        ltv=_state(id,p,m.totalBorrowAssets,m.totalBorrowShares).ltv;
        uint256 target=marketPolicy[id].targetLtv;
        if(ltv>target) revert ExcessLtv(ltv,target);
    }
    function _safeBalance(address token) private view returns(uint256){return ICYToken(token).balanceOf(address(SAFE));}
    function _safe(address to,bytes memory data) private returns(bytes memory ret){
        (bool ok,bytes memory result)=SAFE.execTransactionFromModuleReturnData(to,0,data,0);
        if(!ok) revert ExternalCallFailed();
        return result;
    }
    function _safeTransfer(address token,address to,uint256 amount) private {
        _checkToken(_safe(token,abi.encodeCall(ICYToken.transfer,(to,amount))));
    }
    function _safeApprove(address token,address spender,uint256 amount) private {
        _checkToken(_safe(token,abi.encodeCall(ICYToken.approve,(spender,0))));
        if(amount!=0) _checkToken(_safe(token,abi.encodeCall(ICYToken.approve,(spender,amount))));
    }
    function _approve(address token,address spender,uint256 amount) private {
        _token(token,abi.encodeCall(ICYToken.approve,(spender,0)));
        if(amount!=0) _token(token,abi.encodeCall(ICYToken.approve,(spender,amount)));
    }
    function _token(address token,bytes memory data) private {
        (bool ok,bytes memory result)=token.call(data);
        if(!ok) revert ExternalCallFailed();
        _checkToken(result);
    }
    function _checkToken(bytes memory ret) private pure{
        if(ret.length!=0&&!abi.decode(ret,(bool))) revert ExternalCallFailed();
    }
    function _mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        if (denominator == 0) revert InvalidAmount();
        uint256 prod0; uint256 prod1;
        assembly {
            let mm := mulmod(a, b, not(0))
            prod0 := mul(a, b)
            prod1 := sub(sub(mm, prod0), lt(mm, prod0))
        }
        if (prod1 == 0) return prod0 / denominator;
        if (denominator <= prod1) revert InvalidAmount();
        uint256 remainder;
        assembly {
            remainder := mulmod(a, b, denominator)
            prod1 := sub(prod1, gt(remainder, prod0))
            prod0 := sub(prod0, remainder)
        }
        uint256 twos = denominator & (~denominator + 1);
        assembly {
            denominator := div(denominator, twos)
            prod0 := div(prod0, twos)
            twos := add(div(sub(0, twos), twos), 1)
        }
        uint256 inv;
        unchecked {
            prod0 |= prod1 * twos;
            inv = (3 * denominator) ^ 2;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            result = prod0 * inv;
        }
    }
    function _mulDivUp(uint256 a, uint256 b, uint256 d) internal pure returns (uint256 result) {
        result = _mulDiv(a, b, d);
        if (mulmod(a, b, d) > 0) {
            if (result == type(uint256).max) revert InvalidAmount();
            ++result;
        }
    }

}
