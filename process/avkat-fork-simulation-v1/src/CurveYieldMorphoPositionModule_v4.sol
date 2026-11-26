// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * @title CurveYield Morpho Position Module v4
 * @notice Thin transaction executor for Safe-owned secondary Morpho positions.
 * @dev Worker supplies exact amounts, borrow shares, flash size, swap steps, minimum
 *      outputs and deadline. No on-chain opportunity selection, debt projections,
 *      allocation accounting, sizing, price discovery or duplicated primary logic.
 *      Primary market mutations use the original module only. No arbitrary targets,
 *      calldata forwarding, recipient selection or delegatecalls.
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
    ICYPrimary public immutable PRIMARY;
    ICYSafe public immutable SAFE;
    ICYMorpho public immutable MORPHO;
    bytes32 public immutable PRIMARY_MARKET;

    struct Policy { uint64 maxLtv; uint8 operations; }
    // operations: 1 increase, 2 reduce/close, 4 migrate
    mapping(bytes32=>Policy) public marketPolicy;
    mapping(address=>bool) public isExecutor;
    bool private transient locked;
    bytes32 private transient commitment;

    struct Hop { address tokenOut; uint256 minOut; }
    // All quantities are raw token units, not normalized decimals.
    // Increase: seed, flash, minimum (collateral out), hops.
    // Reduce: flash, repayShares, withdraw, sell, minimum (net loan equity), hops.
    // Primary migration destination: minimum = primary's avKAT/KAT rate floor (WAD).
    struct Action {
        bytes32 id;
        uint256 flash;
        uint256 seed;
        uint256 repayShares;
        uint256 withdraw;
        uint256 sell;
        uint256 minimum;
        bool up;
        Hop[] hops;
    }
    error Unauthorized();
    error Invalid();
    error Callback();
    error Failed();
    error Limit();
    event ExecutorSet(address indexed executor,bool enabled);
    event PolicySet(bytes32 indexed id,uint64 maxLtv,uint8 operations);
    event Adjusted(bytes32 indexed id,bool up,uint256 flash,uint256 repayShares,uint256 collateralAmount,uint256 result);
    event Migrated(bytes32 indexed fromId,bytes32 indexed toId,uint256 sourceEquity,uint256 destinationSeed);

    modifier onlySafe(){if(msg.sender!=address(SAFE)) revert Unauthorized(); _;}
    constructor(address primary){
        PRIMARY=ICYPrimary(primary);
        SAFE=ICYSafe(ICYPrimary(primary).SAFE());
        MORPHO=ICYMorpho(ICYPrimary(primary).MORPHO());
        PRIMARY_MARKET=ICYPrimary(primary).LOOP_MARKET();
        if(address(SAFE).code.length==0||address(MORPHO).code.length==0) revert Invalid();
    }
    function setExecutor(address executor,bool enabled) external onlySafe {
        isExecutor[executor]=enabled;
        emit ExecutorSet(executor,enabled);
    }
    function setMarketPolicy(bytes32 id,uint64 maxLtv,uint8 operations) external onlySafe {
        if(id==PRIMARY_MARKET||operations>7||(operations!=0&&(maxLtv==0||maxLtv>=MORPHO.idToMarketParams(id).lltv))) revert Invalid();
        marketPolicy[id]=Policy(maxLtv,operations);
        emit PolicySet(id,maxLtv,operations);
    }

    /// @notice Worker ABI-encodes each Action. An empty second action means a single operation.
    ///         A second action is an increase funded solely by the first unwind's proceeds.
    ///         Close uses the current full borrow-share and collateral amounts supplied by Worker.
    ///         If actual bridge output exceeds the specified seed, the excess stays in the Safe.
    function execute(bytes calldata first,bytes calldata second,Hop[] calldata bridge,uint256 deadline)
        external returns(uint256 result)
    {
        if(msg.sender!=address(SAFE)&&!isExecutor[msg.sender]) revert Unauthorized();
        if(locked||block.timestamp>deadline) revert Invalid();
        locked=true;
        Action memory a=abi.decode(first,(Action));
        bool migration=second.length!=0;
        if(migration&&(a.up||a.sell!=a.withdraw)) revert Invalid();
        CYMarketParams memory p=_params(a.id,(a.up?1:2)|(migration?4:0));
        result=_run(p,a,first);
        if(migration){
            Action memory b=abi.decode(second,(Action));
            if(!b.up||a.id==b.id||b.seed==0||result==0) revert Invalid();
            bool primary=b.id==PRIMARY_MARKET;
            CYMarketParams memory q=primary?MORPHO.idToMarketParams(b.id):_params(b.id,5);
            uint256 available=_swap(p.loanToken,q.loanToken,result,bridge);
            if(b.seed>available) revert Limit();
            emit Migrated(a.id,b.id,result,b.seed);
            if(primary) result=_intoPrimary(q,b,deadline);
            else result=_run(q,b,second);
        }else if(bridge.length!=0) revert Invalid();
        locked=false;
    }
    function _params(bytes32 id,uint8 flags) private view returns(CYMarketParams memory){
        if(id==PRIMARY_MARKET||(marketPolicy[id].operations&flags)!=flags) revert Unauthorized();
        return MORPHO.idToMarketParams(id);
    }
    function _run(CYMarketParams memory p,Action memory a,bytes calldata data) private returns(uint256 result){
        if(a.up){
            if(a.seed+a.flash==0||a.minimum==0||a.repayShares!=0||a.withdraw!=0||a.sell!=0) revert Invalid();
        }else if(a.seed!=0||a.sell>a.withdraw||(a.repayShares==0)!=(a.flash==0)||(a.repayShares==0&&a.withdraw==0)) revert Invalid();
        MORPHO.accrueInterest(p);
        uint256 beforeLoan=_balance(p.loanToken,address(SAFE));
        uint256 beforeSelf=_balance(p.loanToken,address(this));
        (,,uint128 beforeCol)=MORPHO.position(a.id,address(SAFE));
        if(a.flash==0) _perform(p,a);
        else{
            commitment=keccak256(data);
            MORPHO.flashLoan(p.loanToken,a.flash,data);
            if(commitment!=bytes32(0)) revert Callback();
            _approve(p.loanToken,address(MORPHO),0,false);
        }
        if(_balance(p.loanToken,address(this))!=beforeSelf) revert Limit();
        if(a.up){
            (,,uint128 afterCol)=MORPHO.position(a.id,address(SAFE));
            result=uint256(afterCol)-beforeCol;
            if(result<a.minimum||_balance(p.loanToken,address(SAFE))!=beforeLoan-a.seed) revert Limit();
        }else{
            result=_balance(p.loanToken,address(SAFE))-beforeLoan;
            if(result<a.minimum) revert Limit();
        }
        _checkLtv(a.id,p);
        emit Adjusted(a.id,a.up,a.flash,a.repayShares,a.up?result:a.withdraw,result);
    }
    function onMorphoFlashLoan(uint256 assets,bytes calldata data) external {
        if(msg.sender!=address(MORPHO)||!locked||commitment==bytes32(0)||keccak256(data)!=commitment) revert Callback();
        Action memory a=abi.decode(data,(Action));
        if(assets!=a.flash) revert Callback();
        commitment=bytes32(0);
        CYMarketParams memory p=MORPHO.idToMarketParams(a.id);
        _perform(p,a);
        _approve(p.loanToken,address(MORPHO),assets,false);
    }
    function _perform(CYMarketParams memory p,Action memory a) private {
        if(a.up){
            if(a.flash!=0) _transfer(p.loanToken,address(SAFE),a.flash,false);
            uint256 acquired=_swap(p.loanToken,p.collateralToken,a.seed+a.flash,a.hops);
            if(acquired<a.minimum) revert Limit();
            _approve(p.collateralToken,address(MORPHO),acquired,true);
            _safe(address(MORPHO),abi.encodeCall(ICYMorpho.supplyCollateral,(p,acquired,address(SAFE),"")));
            _approve(p.collateralToken,address(MORPHO),0,true);
            if(a.flash!=0) _safe(address(MORPHO),abi.encodeCall(ICYMorpho.borrow,(p,a.flash,0,address(SAFE),address(this))));
        }else{
            uint256 paid;
            if(a.repayShares!=0){
                _approve(p.loanToken,address(MORPHO),a.flash,false);
                uint256 shares;
                (paid,shares)=MORPHO.repay(p,0,a.repayShares,address(SAFE),"");
                if(paid>a.flash||shares!=a.repayShares) revert Limit();
                _approve(p.loanToken,address(MORPHO),0,false);
            }
            if(a.withdraw!=0) _safe(address(MORPHO),abi.encodeCall(ICYMorpho.withdrawCollateral,(p,a.withdraw,address(SAFE),address(SAFE))));
            uint256 proceeds;
            if(a.sell!=0) proceeds=_swap(p.collateralToken,p.loanToken,a.sell,a.hops);
            else if(a.hops.length!=0) revert Invalid();
            if(proceeds<paid+a.minimum) revert Limit();
            if(paid!=0) _transfer(p.loanToken,address(this),paid,true);
        }
    }
    /// @dev Delegate the original primary's all-balance loop after isolating unrelated
    ///      loose KAT and avKAT. Restore the parked balances before returning.
    function _intoPrimary(CYMarketParams memory p,Action memory a,uint256 deadline) private returns(uint256 result){
        if(a.flash==0||a.minimum==0||a.hops.length!=0||a.repayShares!=0||a.withdraw!=0||a.sell!=0) revert Invalid();
        uint256 parkedLoan=_balance(p.loanToken,address(SAFE))-a.seed;
        uint256 parkedCol=_balance(p.collateralToken,address(SAFE));
        if(parkedLoan!=0) _transfer(p.loanToken,address(this),parkedLoan,true);
        if(parkedCol!=0) _transfer(p.collateralToken,address(this),parkedCol,true);
        if(_balance(p.loanToken,address(SAFE))!=a.seed||_balance(p.collateralToken,address(SAFE))!=0) revert Limit();
        (,,uint128 beforeCol)=MORPHO.position(a.id,address(SAFE));
        ICYPrimary.PreSteps memory empty=ICYPrimary.PreSteps(new ICYPrimary.RangeExit[](0),new ICYPrimary.VaultExit[](0),new ICYPrimary.Swap[](0));
        PRIMARY.atomicLoopUp(empty,ICYPrimary.LoopUp(a.flash,a.flash,a.minimum,0,deadline));
        if(parkedLoan!=0) _transfer(p.loanToken,address(SAFE),parkedLoan,false);
        if(parkedCol!=0) _transfer(p.collateralToken,address(SAFE),parkedCol,false);
        if(_balance(p.loanToken,address(SAFE))!=parkedLoan||_balance(p.collateralToken,address(SAFE))!=parkedCol) revert Limit();
        (,,uint128 afterCol)=MORPHO.position(a.id,address(SAFE));
        result=uint256(afterCol)-beforeCol;
    }
    function _swap(address from,address to,uint256 amount,Hop[] memory hops) private returns(uint256){
        if(from==to){if(hops.length!=0) revert Invalid();return amount;}
        if(amount==0||hops.length==0||hops[hops.length-1].tokenOut!=to) revert Invalid();
        ICYPrimary.Swap[] memory req=new ICYPrimary.Swap[](1);
        for(uint256 i;i<hops.length;++i){
            Hop memory h=hops[i];
            if(from==h.tokenOut||h.minOut==0) revert Invalid();
            uint256 beforeIn=_balance(from,address(SAFE));
            uint256 beforeOut=_balance(h.tokenOut,address(SAFE));
            req[0]=ICYPrimary.Swap(from,h.tokenOut,amount);
            PRIMARY.executeApprovedSwaps(req);
            if(beforeIn-_balance(from,address(SAFE))!=amount) revert Limit();
            amount=_balance(h.tokenOut,address(SAFE))-beforeOut;
            if(amount<h.minOut) revert Limit();
            from=h.tokenOut;
        }
        return amount;
    }
    // Final live-state cap only. All forecasting and target selection are Worker-side.
    function _checkLtv(bytes32 id,CYMarketParams memory p) private view {
        (,uint128 shares,uint128 col)=MORPHO.position(id,address(SAFE));
        if(shares==0) return;
        CYMarket memory m=MORPHO.market(id);
        uint256 debt=_mulDivUp(shares,uint256(m.totalBorrowAssets)+1,uint256(m.totalBorrowShares)+1e6);
        uint256 value=_mulDiv(col,ICYOracle(p.oracle).price(),1e36);
        if(debt>_mulDiv(value,marketPolicy[id].maxLtv,1e18)) revert Limit();
    }
    function _balance(address token,address owner) private view returns(uint256){return ICYToken(token).balanceOf(owner);}
    function _safe(address to,bytes memory data) private returns(bytes memory ret){
        (bool ok,bytes memory result)=SAFE.execTransactionFromModuleReturnData(to,0,data,0);
        if(!ok) revert Failed();
        return result;
    }
    function _transfer(address token,address to,uint256 amount,bool fromSafe) private{
        uint256 beforeOut=_balance(token,to);
        _token(token,abi.encodeCall(ICYToken.transfer,(to,amount)),fromSafe);
        if(_balance(token,to)-beforeOut!=amount) revert Limit();
    }
    function _approve(address token,address spender,uint256 amount,bool fromSafe) private{
        _token(token,abi.encodeCall(ICYToken.approve,(spender,0)),fromSafe);
        if(amount!=0) _token(token,abi.encodeCall(ICYToken.approve,(spender,amount)),fromSafe);
    }
    function _token(address token,bytes memory data,bool fromSafe) private{
        bytes memory ret;
        if(fromSafe) ret=_safe(token,data);
        else{
            bool ok;
            (ok,ret)=token.call(data);
            if(!ok) revert Failed();
        }
        if(ret.length!=0&&!abi.decode(ret,(bool))) revert Failed();
    }
    function _mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        if (denominator == 0) revert Invalid();
        uint256 prod0; uint256 prod1;
        assembly {
            let mm := mulmod(a, b, not(0))
            prod0 := mul(a, b)
            prod1 := sub(sub(mm, prod0), lt(mm, prod0))
        }
        if (prod1 == 0) return prod0 / denominator;
        if (denominator <= prod1) revert Invalid();
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
            if (result == type(uint256).max) revert Invalid();
            ++result;
        }
    }


}
