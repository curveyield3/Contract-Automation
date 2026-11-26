// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * @title CurveYield Morpho Position Module v1
 * @notice CurveYield Safe-owned, market-configurable leveraged positions on Morpho Blue.
 * @dev One scoped Safe module; no arbitrary calls, caller-selected recipients, custody
 *      wallets, price discovery or automated opportunity selection. The existing
 *      OmniSwapper supplies all swap routing. Explicit input amounts preserve unrelated
 *      Safe balances. Source-only until compiled, reviewed and installed by the Safe.
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
interface ICYSwapper {
    function swapExactInput(address from,address to,uint256 amount,uint256 minimum,address receiver,uint256 deadline) external returns(uint256);
}
contract CurveYieldMorphoPositionModule {
    uint256 private constant WAD=1e18;
    uint256 private constant ORACLE_SCALE=1e36;
    uint8 public constant UP=1;
    uint8 public constant DOWN=2;
    uint8 public constant MIGRATE=4;
    ICYSafe public immutable SAFE;
    ICYMorpho public immutable MORPHO;
    ICYSwapper public immutable SWAPPER;

    struct Policy { uint64 targetLtv; uint64 maximumLtv; uint8 operations; }
    mapping(bytes32=>Policy) public marketPolicy;
    mapping(address=>bool) public isExecutor;
    bool private locked;
    bytes32 private transient commitment;

    struct Hop { address tokenOut; uint256 minOut; }
    struct UpPlan { uint256 flash; uint256 minCollateral; Hop[] hops; }
    struct DownPlan {
        uint256 repayShares;     // max uint = all current borrow shares
        uint256 withdrawAssets;  // max uint = all current collateral
        uint256 sellAssets;      // max uint = all withdrawn collateral
        uint256 maxRepayAssets;  // cap on fresh share-based repayment quote
        uint256 minEquityOut;    // minimum residual loan-token output after repayment
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
        bool up;
        uint256 flash;
        uint256 seed;
        uint256 shares;
        uint256 withdrawAssets;
        uint256 sellAssets;
        uint256 minimum;
        uint256 deadline;
        Hop[] hops;
    }
    error Unauthorized();
    error Busy();
    error InvalidMarket();
    error InvalidPolicy();
    error InvalidAmount();
    error Expired();
    error Callback();
    error TokenFailure(address token);
    error SafeFailure(address target);
    error InsufficientOutput();
    error ExcessLtv(uint256 actual,uint256 limit);

    event ExecutorSet(address indexed executor,bool enabled);
    event PolicySet(bytes32 indexed id,uint64 targetLtv,uint64 maximumLtv,uint8 operations);
    event Looped(bytes32 indexed id,uint256 seed,uint256 flash,uint256 collateralAdded,uint256 finalLtv);
    event Unwound(bytes32 indexed id,uint256 sharesRepaid,uint256 collateralWithdrawn,uint256 loanEquity,uint256 finalLtv);
    event Migrated(bytes32 indexed fromId,bytes32 indexed toId,uint256 sourceEquity,uint256 destinationSeed,uint256 destinationFlash);

    modifier onlySafe() { if(msg.sender!=address(SAFE)) revert Unauthorized(); _; }
    modifier operation(uint256 deadline) {
        if(msg.sender!=address(SAFE)&&!isExecutor[msg.sender]) revert Unauthorized();
        if(locked) revert Busy();
        if(block.timestamp>deadline) revert Expired();
        locked=true; _; locked=false;
    }
    constructor(address safe,address morpho,address swapper) {
        if(safe.code.length==0||morpho.code.length==0||swapper.code.length==0||
           safe==morpho||safe==swapper||morpho==swapper) revert InvalidPolicy();
        SAFE=ICYSafe(safe); MORPHO=ICYMorpho(morpho); SWAPPER=ICYSwapper(swapper);
    }
    function setExecutor(address executor,bool enabled) external onlySafe {
        if(executor==address(0)||executor==address(this)) revert InvalidPolicy();
        isExecutor[executor]=enabled; emit ExecutorSet(executor,enabled);
    }
    function setMarketPolicy(bytes32 id,uint64 target,uint64 maximum,uint8 permissions) external onlySafe {
        CYMarketParams memory p=_params(id);
        if(permissions>7||target==0||target>maximum||maximum>=p.lltv||maximum>=WAD) revert InvalidPolicy();
        marketPolicy[id]=Policy(target,maximum,permissions);
        emit PolicySet(id,target,maximum,permissions);
    }
    /// @notice Project accrued debt using the configured market's Morpho IRM and Blue rounding.
    /// @dev Read-only quote; execution accrues interest and recomputes debt against live state.
    function positionState(bytes32 id) public view returns(State memory) {
        CYMarketParams memory p=_params(id);
        CYMarket memory m=MORPHO.market(id);
        uint256 assets=m.totalBorrowAssets;
        uint256 elapsed=block.timestamp-m.lastUpdate;
        if(elapsed!=0&&assets!=0&&p.irm!=address(0)){
            uint256 first=ICYIrm(p.irm).borrowRateView(p,m)*elapsed;
            uint256 second=first*first/(2*WAD);
            uint256 third=second*first/(3*WAD);
            assets+=assets*(first+second+third)/WAD;
        }
        return _state(id,p,assets,m.totalBorrowShares);
    }
    /// @notice Use only seedAssets of Safe-held loan token and the requested flash size.
    ///         The executor chooses size using live liquidity and net swap quotes.
    function loopUp(bytes32 id,uint256 seedAssets,UpPlan calldata plan,uint256 deadline)
        external operation(deadline) returns(uint256 collateralAdded)
    {
        CYMarketParams memory p=_allowed(id,UP);
        if(seedAssets!=0) _takeFromSafe(p.loanToken,seedAssets);
        return _up(id,p,seedAssets,plan,deadline);
    }
    /// @notice Share-exact partial or full unwind. Unsold collateral and equity go to Safe.
    function loopDown(bytes32 id,DownPlan calldata plan,uint256 deadline)
        external operation(deadline) returns(uint256 equity)
    {
        CYMarketParams memory p=_allowed(id,DOWN);
        equity=_down(id,p,plan,deadline);
        _send(p.loanToken,address(SAFE),equity);
    }
    /// @notice Reuse unwind logic; sellAssets can be exact or max uint (all collateral).
    function closePosition(bytes32 id,DownPlan calldata plan,uint256 deadline)
        external operation(deadline) returns(uint256 equity)
    {
        CYMarketParams memory p=_allowed(id,DOWN);
        DownPlan memory full=plan;
        full.repayShares=type(uint256).max;
        full.withdrawAssets=type(uint256).max;
        equity=_down(id,p,full,deadline);
        _send(p.loanToken,address(SAFE),equity);
        (,uint128 shares,uint128 collateral)=MORPHO.position(id,address(SAFE));
        if(shares!=0||collateral!=0) revert InvalidAmount();
    }
    /// @notice Atomic reallocation, limited to the exact source position slice.
    ///         The first flash settles before the destination flash begins.
    ///         No preexisting loose Safe balances fund this operation.
    function migratePosition(bytes32 fromId,bytes32 toId,DownPlan calldata down,
        Hop[] calldata bridge,uint256 minDestinationSeed,UpPlan calldata up,uint256 deadline)
        external operation(deadline) returns(uint256 collateralAdded)
    {
        if(fromId==toId||minDestinationSeed==0) revert InvalidAmount();
        CYMarketParams memory src=_allowed(fromId,DOWN|MIGRATE);
        CYMarketParams memory dst=_allowed(toId,UP|MIGRATE);
        // Migration sells the entire released source slice; no unsold collateral is diverted.
        (, ,uint128 sourceCollateral)=MORPHO.position(fromId,address(SAFE));
        uint256 withdrawn=down.withdrawAssets==type(uint256).max?sourceCollateral:down.withdrawAssets;
        if(down.sellAssets!=type(uint256).max&&down.sellAssets!=withdrawn) revert InvalidAmount();
        uint256 equity=_down(fromId,src,down,deadline);
        if(equity==0) revert InsufficientOutput();
        uint256 seed=_swap(src.loanToken,dst.loanToken,equity,bridge,deadline);
        if(seed<minDestinationSeed) revert InsufficientOutput();
        collateralAdded=_up(toId,dst,seed,up,deadline);
        emit Migrated(fromId,toId,equity,seed,up.flash);
    }
    function _up(bytes32 id,CYMarketParams memory p,uint256 seed,UpPlan memory plan,uint256 deadline)
        private returns(uint256 collateralAdded)
    {
        if(seed+plan.flash==0||plan.minCollateral==0) revert InvalidAmount();
        MORPHO.accrueInterest(p);
        uint256 initialLoan=_balance(p.loanToken);
        if(initialLoan<seed) revert InvalidAmount();
        (, ,uint128 beforeCollateral)=MORPHO.position(id,address(SAFE));
        Action memory a=Action(id,true,plan.flash,seed,0,0,0,plan.minCollateral,deadline,plan.hops);
        _run(p,a);
        if(_balance(p.loanToken)!=initialLoan-seed) revert InvalidAmount();
        (, ,uint128 afterCollateral)=MORPHO.position(id,address(SAFE));
        collateralAdded=uint256(afterCollateral)-beforeCollateral;
        if(collateralAdded<plan.minCollateral) revert InsufficientOutput();
        uint256 ltv=_checkLtv(id,p);
        emit Looped(id,seed,plan.flash,collateralAdded,ltv);
    }
    function _down(bytes32 id,CYMarketParams memory p,DownPlan memory plan,uint256 deadline)
        private returns(uint256 equity)
    {
        MORPHO.accrueInterest(p);
        (,uint128 currentShares,uint128 currentCollateral)=MORPHO.position(id,address(SAFE));
        uint256 shares=plan.repayShares==type(uint256).max?currentShares:plan.repayShares;
        uint256 withdraw=plan.withdrawAssets==type(uint256).max?currentCollateral:plan.withdrawAssets;
        uint256 sell=plan.sellAssets==type(uint256).max?withdraw:plan.sellAssets;
        if(shares>currentShares||withdraw>currentCollateral||sell>withdraw||(shares==0&&withdraw==0)) revert InvalidAmount();
        CYMarket memory m=MORPHO.market(id);
        uint256 flash=_ceil(shares*(uint256(m.totalBorrowAssets)+1),uint256(m.totalBorrowShares)+1e6);
        if(flash>plan.maxRepayAssets) revert InvalidAmount();
        uint256 beforeLoan=_balance(p.loanToken);
        Action memory a=Action(id,false,flash,0,shares,withdraw,sell,plan.minEquityOut,deadline,plan.hops);
        _run(p,a);
        equity=_balance(p.loanToken)-beforeLoan;
        if(equity<plan.minEquityOut) revert InsufficientOutput();
        (,uint128 afterShares,uint128 afterCollateral)=MORPHO.position(id,address(SAFE));
        if(afterShares!=currentShares-shares||afterCollateral!=currentCollateral-withdraw) revert InvalidAmount();
        uint256 ltv=_checkLtv(id,p);
        emit Unwound(id,shares,withdraw,equity,ltv);
    }
    function _run(CYMarketParams memory p,Action memory a) private {
        if(a.flash==0){ _execute(p,a); return; }
        bytes memory data=abi.encode(a);
        if(commitment!=bytes32(0)) revert Callback();
        commitment=keccak256(data);
        MORPHO.flashLoan(p.loanToken,a.flash,data);
        if(commitment!=bytes32(0)) revert Callback();
        _approve(p.loanToken,address(MORPHO),0);
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
            uint256 acquired=_swap(p.loanToken,p.collateralToken,a.seed+a.flash,a.hops,a.deadline);
            if(acquired<a.minimum) revert InsufficientOutput();
            _approve(p.collateralToken,address(MORPHO),acquired);
            MORPHO.supplyCollateral(p,acquired,address(SAFE),"");
            _approve(p.collateralToken,address(MORPHO),0);
            if(a.flash!=0){
                bytes memory ret=_safe(address(MORPHO),abi.encodeCall(ICYMorpho.borrow,(p,a.flash,0,address(SAFE),address(this))));
                (uint256 borrowed,)=abi.decode(ret,(uint256,uint256));
                if(borrowed!=a.flash) revert InvalidAmount();
            }
        } else {
            uint256 beforeLoan=_balance(p.loanToken)-a.flash;
            if(a.shares!=0){
                _approve(p.loanToken,address(MORPHO),a.flash);
                (uint256 paid,uint256 shares)=MORPHO.repay(p,0,a.shares,address(SAFE),"");
                _approve(p.loanToken,address(MORPHO),0);
                if(paid>a.flash||shares!=a.shares) revert InvalidAmount();
            }
            if(a.withdrawAssets!=0){
                uint256 beforeCollateral=_balance(p.collateralToken);
                _safe(address(MORPHO),abi.encodeCall(ICYMorpho.withdrawCollateral,(p,a.withdrawAssets,address(SAFE),address(this))));
                if(_balance(p.collateralToken)-beforeCollateral!=a.withdrawAssets) revert InvalidAmount();
                if(a.sellAssets!=0) _swap(p.collateralToken,p.loanToken,a.sellAssets,a.hops,a.deadline);
                else if(a.hops.length!=0) revert InvalidAmount();
                _send(p.collateralToken,address(SAFE),a.withdrawAssets-a.sellAssets);
                if(_balance(p.collateralToken)!=beforeCollateral) revert InvalidAmount();
            } else if(a.hops.length!=0) revert InvalidAmount();
            if(_balance(p.loanToken)<beforeLoan+a.flash+a.minimum) revert InsufficientOutput();
        }
    }
    /// @dev Each hop spends exactly the preceding hop's received balance delta.
    ///      Existing configured router paths, net min-outs and deadline are enforced.
    function _swap(address from,address to,uint256 amount,Hop[] memory hops,uint256 deadline)
        private returns(uint256)
    {
        if(from==to){ if(hops.length!=0) revert InvalidAmount(); return amount; }
        if(amount==0||hops.length==0||hops[hops.length-1].tokenOut!=to) revert InvalidAmount();
        address token=from;
        for(uint256 i;i<hops.length;++i){
            Hop memory h=hops[i];
            if(h.tokenOut==token||h.tokenOut.code.length==0||h.minOut==0) revert InvalidAmount();
            uint256 beforeIn=_balance(token);
            uint256 beforeOut=_balance(h.tokenOut);
            _approve(token,address(SWAPPER),amount);
            uint256 out=SWAPPER.swapExactInput(token,h.tokenOut,amount,h.minOut,address(this),deadline);
            _approve(token,address(SWAPPER),0);
            if(beforeIn-_balance(token)!=amount) revert InvalidAmount();
            amount=_balance(h.tokenOut)-beforeOut;
            if(amount<h.minOut||out!=amount) revert InsufficientOutput();
            token=h.tokenOut;
        }
        return amount;
    }
    function _params(bytes32 id) private view returns(CYMarketParams memory p){
        p=MORPHO.idToMarketParams(id);
        if(p.loanToken.code.length==0||p.collateralToken.code.length==0||p.oracle.code.length==0||
           p.loanToken==p.collateralToken||p.lltv==0||p.lltv>WAD||
           keccak256(abi.encode(p))!=id) revert InvalidMarket();
    }
    function _allowed(bytes32 id,uint8 needed) private view returns(CYMarketParams memory p){
        p=_params(id);
        Policy memory pol=marketPolicy[id];
        if((pol.operations&needed)!=needed||pol.targetLtv==0||pol.targetLtv>pol.maximumLtv||pol.maximumLtv>=p.lltv) revert InvalidPolicy();
    }
    function _state(bytes32 id,CYMarketParams memory p,uint256 assets,uint256 totalShares) private view returns(State memory s){
        (,uint128 shares,uint128 collateral)=MORPHO.position(id,address(SAFE));
        s.collateral=collateral; s.borrowShares=shares;
        s.debt=_ceil(uint256(shares)*(assets+1),totalShares+1e6);
        s.oraclePrice=ICYOracle(p.oracle).price();
        if(s.oraclePrice==0) revert InvalidMarket();
        // Checked arithmetic intentionally reverts instead of truncating extreme unsupported values.
        s.collateralValue=uint256(collateral)*s.oraclePrice/ORACLE_SCALE;
        if(s.collateralValue>uint256(type(int256).max)||s.debt>uint256(type(int256).max)) revert InvalidAmount();
        s.equity=int256(s.collateralValue)-int256(s.debt);
        s.ltv=s.debt==0?0:s.collateralValue==0?type(uint256).max:_ceil(s.debt*WAD,s.collateralValue);
    }
    function _checkLtv(bytes32 id,CYMarketParams memory p) private view returns(uint256 ltv){
        CYMarket memory m=MORPHO.market(id);
        ltv=_state(id,p,m.totalBorrowAssets,m.totalBorrowShares).ltv;
        uint256 target=marketPolicy[id].targetLtv;
        if(ltv>target) revert ExcessLtv(ltv,target);
    }
    function _ceil(uint256 a,uint256 b) private pure returns(uint256){ return a==0?0:1+(a-1)/b; }
    function _balance(address t) private view returns(uint256){return ICYToken(t).balanceOf(address(this));}
    function _safe(address to,bytes memory data) private returns(bytes memory ret){
        (bool success,bytes memory result)=SAFE.execTransactionFromModuleReturnData(to,0,data,0);
        if(!success) revert SafeFailure(to);
        return result;
    }
    function _takeFromSafe(address token,uint256 amount) private {
        uint256 beforeBalance=_balance(token);
        bytes memory result=_safe(token,abi.encodeCall(ICYToken.transfer,(address(this),amount)));
        if(result.length!=0&&!abi.decode(result,(bool))) revert TokenFailure(token);
        if(_balance(token)-beforeBalance!=amount) revert InvalidAmount();
    }
    function _send(address token,address to,uint256 amount) private {
        if(amount==0) return;
        uint256 beforeBalance=_balance(token);
        uint256 beforeTo=ICYToken(token).balanceOf(to);
        _tokenCall(token,abi.encodeCall(ICYToken.transfer,(to,amount)));
        if(beforeBalance-_balance(token)!=amount||ICYToken(token).balanceOf(to)-beforeTo!=amount) revert InvalidAmount();
    }
    function _approve(address token,address spender,uint256 amount) private {
        _tokenCall(token,abi.encodeCall(ICYToken.approve,(spender,0)));
        if(amount!=0) _tokenCall(token,abi.encodeCall(ICYToken.approve,(spender,amount)));
    }
    function _tokenCall(address token,bytes memory data) private {
        (bool success,bytes memory result)=token.call(data);
        if(!success||(result.length!=0&&!abi.decode(result,(bool)))) revert TokenFailure(token);
    }
}
