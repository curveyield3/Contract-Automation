// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * @title CurveYield Morpho Position Module v5
 * @notice Standalone Safe module for generic Morpho Blue flash-loan leverage adjustments.
 * @dev Worker chooses markets, amounts, routes, minimums and deadlines.
 *      No migration engine, primary module dependency, strategy or position registry.
 *      All position ownership and released equity belong to the Safe.
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


interface ICYSwapper {
    function swapExactInput(address tokenIn,address tokenOut,uint256 amountIn,
        uint256 minNetAmountOut,address recipient,uint256 deadline) external returns(uint256);
}

contract CurveYieldMorphoPositionModule {
    ICYSafe public immutable SAFE;
    ICYMorpho public immutable MORPHO;
    ICYSwapper public immutable SWAPPER;
    // Optional market reserved for management outside this module; zero means none.
    bytes32 public immutable RESERVED_MARKET;
    struct Policy { uint64 maxLtv; uint8 operations; } // 1 = increase, 2 = decrease
    mapping(bytes32=>Policy) public marketPolicy;
    mapping(address=>bool) public isExecutor;
    bool private transient locked;
    bytes32 private transient commitment;

    struct Hop { address tokenOut; uint256 minOut; }
    struct Loop {
        bytes32 id;
        uint256 flash;
        uint256 amount; // Safe loan-token seed on increase, borrow shares on decrease
        uint256 withdraw;
        uint256 sell;
        uint256 minimum; // acquired collateral on increase, net loan-token equity on decrease
        uint256 deadline;
        bool up;
    }

    error Unauthorized();
    error Invalid();
    error Callback();
    error Failed();
    error Limit();
    event ExecutorSet(address indexed executor,bool enabled);
    event PolicySet(bytes32 indexed id,uint64 maxLtv,uint8 operations);
    event Looped(bytes32 indexed id,bool up,uint256 flash,uint256 amount,uint256 withdrawn,uint256 result);

    constructor(address safe,address morpho,address swapper,bytes32 reservedMarket){
        if(safe.code.length==0||morpho.code.length==0||swapper.code.length==0||
           safe==morpho||safe==swapper||morpho==swapper) revert Invalid();
        SAFE=ICYSafe(safe); MORPHO=ICYMorpho(morpho); SWAPPER=ICYSwapper(swapper);
        RESERVED_MARKET=reservedMarket;
    }
    function setExecutor(address executor,bool enabled) external {
        if(msg.sender!=address(SAFE)) revert Unauthorized();
        isExecutor[executor]=enabled;
        emit ExecutorSet(executor,enabled);
    }
    function setMarketPolicy(bytes32 id,uint64 maxLtv,uint8 operations) external {
        if(msg.sender!=address(SAFE)) revert Unauthorized();
        if(id==bytes32(0)||id==RESERVED_MARKET||operations>3) revert Invalid();
        if(operations!=0){
            CYMarketParams memory p=MORPHO.idToMarketParams(id);
            if(maxLtv==0||maxLtv>=p.lltv||p.loanToken==p.collateralToken||p.oracle==address(0)) revert Invalid();
        }
        marketPolicy[id]=Policy(maxLtv,operations);
        emit PolicySet(id,maxLtv,operations);
    }

    /// @notice Supply collateral bought using exact Safe seed plus requested loan-token flash;
    ///         borrow the flash principal for the Safe and settle the flash.
    function loopUp(bytes32 id,uint256 flash,uint256 seed,uint256 minCollateral,
        Hop[] calldata hops,uint256 deadline) external {
        if(seed+flash==0||minCollateral==0) revert Invalid();
        _run(Loop(id,flash,seed,0,0,minCollateral,deadline,true),hops);
    }

    /// @notice Repay exact debt shares, withdraw collateral, sell the specified slice,
    ///         settle the flash and return all remaining proceeds to the Safe.
    /// @dev A zero-flash call can withdraw debt-free collateral. Worker supplies all
    ///      current shares and collateral for a full close; no separate close function.
    function loopDown(bytes32 id,uint256 flash,uint256 repayShares,uint256 withdraw,uint256 sell,
        uint256 minEquity,Hop[] calldata hops,uint256 deadline) external {
        if(sell>withdraw||(repayShares==0)!=(flash==0)||(repayShares==0&&withdraw==0)) revert Invalid();
        _run(Loop(id,flash,repayShares,withdraw,sell,minEquity,deadline,false),hops);
    }

    function _run(Loop memory a,Hop[] memory hops) private {
        if(msg.sender!=address(SAFE)&&!isExecutor[msg.sender]) revert Unauthorized();
        if(locked||block.timestamp>a.deadline) revert Invalid();
        Policy memory pol=marketPolicy[a.id];
        if(a.id==RESERVED_MARKET||(pol.operations&(a.up?1:2))==0) revert Unauthorized();
        locked=true;
        CYMarketParams memory p=MORPHO.idToMarketParams(a.id);
        MORPHO.accrueInterest(p);
        uint256 loanBefore=_balance(p.loanToken);
        uint256 colBefore=_balance(p.collateralToken);
        if(a.flash==0) _perform(p,a,hops);
        else{
            bytes memory data=abi.encode(a,hops);
            commitment=keccak256(data);
            MORPHO.flashLoan(p.loanToken,a.flash,data);
            if(commitment!=bytes32(0)) revert Callback();
            _approve(p.loanToken,address(MORPHO),0);
        }
        if(_balance(p.loanToken)!=loanBefore||_balance(p.collateralToken)!=colBefore) revert Limit();
        _checkLtv(a.id,p,pol.maxLtv);
        locked=false;
    }

    function onMorphoFlashLoan(uint256 assets,bytes calldata data) external {
        if(msg.sender!=address(MORPHO)||!locked||commitment==bytes32(0)||keccak256(data)!=commitment) revert Callback();
        (Loop memory a,Hop[] memory hops)=abi.decode(data,(Loop,Hop[]));
        if(a.flash!=assets) revert Callback();
        commitment=bytes32(0);
        CYMarketParams memory p=MORPHO.idToMarketParams(a.id);
        _perform(p,a,hops);
        _approve(p.loanToken,address(MORPHO),assets);
    }

    function _perform(CYMarketParams memory p,Loop memory a,Hop[] memory hops) private {
        uint256 result;
        if(a.up){
            if(a.amount!=0){
                uint256 beforeSeed=_balance(p.loanToken);
                _checkToken(_safe(p.loanToken,abi.encodeCall(ICYToken.transfer,(address(this),a.amount))));
                if(_balance(p.loanToken)-beforeSeed!=a.amount) revert Limit();
            }
            result=_swap(p.loanToken,p.collateralToken,a.amount+a.flash,hops,a.deadline);
            if(result<a.minimum) revert Limit();
            _approve(p.collateralToken,address(MORPHO),result);
            MORPHO.supplyCollateral(p,result,address(SAFE),"");
            _approve(p.collateralToken,address(MORPHO),0);
            if(a.flash!=0) _safe(address(MORPHO),abi.encodeCall(ICYMorpho.borrow,(p,a.flash,0,address(SAFE),address(this))));
        }else{
            uint256 paid;
            if(a.amount!=0){
                _approve(p.loanToken,address(MORPHO),a.flash);
                uint256 shares;
                (paid,shares)=MORPHO.repay(p,0,a.amount,address(SAFE),"");
                if(paid>a.flash||shares!=a.amount) revert Limit();
                _approve(p.loanToken,address(MORPHO),0);
            }
            if(a.withdraw!=0){
                uint256 beforeCol=_balance(p.collateralToken);
                _safe(address(MORPHO),abi.encodeCall(ICYMorpho.withdrawCollateral,(p,a.withdraw,address(SAFE),address(this))));
                if(_balance(p.collateralToken)-beforeCol!=a.withdraw) revert Limit();
            }
            uint256 proceeds;
            if(a.sell!=0) proceeds=_swap(p.collateralToken,p.loanToken,a.sell,hops,a.deadline);
            else if(hops.length!=0) revert Invalid();
            if(proceeds<paid+a.minimum) revert Limit();
            result=proceeds-paid;
            _return(p.loanToken,result);
            _return(p.collateralToken,a.withdraw-a.sell);
        }
        emit Looped(a.id,a.up,a.flash,a.amount,a.withdraw,result);
    }

    function _swap(address from,address to,uint256 amount,Hop[] memory hops,uint256 deadline)
        private returns(uint256)
    {
        if(hops.length==0||hops[hops.length-1].tokenOut!=to) revert Invalid();
        for(uint256 i;i<hops.length;++i){
            Hop memory h=hops[i];
            if(from==h.tokenOut||h.minOut==0) revert Invalid();
            uint256 beforeIn=_balance(from);
            uint256 beforeOut=_balance(h.tokenOut);
            _approve(from,address(SWAPPER),amount);
            uint256 out=SWAPPER.swapExactInput(from,h.tokenOut,amount,h.minOut,address(this),deadline);
            _approve(from,address(SWAPPER),0);
            if(beforeIn-_balance(from)!=amount) revert Limit();
            amount=_balance(h.tokenOut)-beforeOut;
            if(amount<h.minOut||amount!=out) revert Limit();
            from=h.tokenOut;
        }
        return amount;
    }

    // Final live-state limit, not a sizing or forecasting function.
    function _checkLtv(bytes32 id,CYMarketParams memory p,uint256 maxLtv) private view {
        (,uint128 shares,uint128 col)=MORPHO.position(id,address(SAFE));
        if(shares==0) return;
        CYMarket memory m=MORPHO.market(id);
        // uint128 shares * (uint128 assets + 1) is bounded below 2**256.
        uint256 debt=1+(uint256(shares)*(uint256(m.totalBorrowAssets)+1)-1)/(uint256(m.totalBorrowShares)+1e6);
        uint256 value=_mulDiv(col,ICYOracle(p.oracle).price(),1e36);
        if(debt>_mulDiv(value,maxLtv,1e18)) revert Limit();
    }
    function _balance(address token) private view returns(uint256){return ICYToken(token).balanceOf(address(this));}
    function _safe(address to,bytes memory data) private returns(bytes memory result){
        bool ok;
        (ok,result)=SAFE.execTransactionFromModuleReturnData(to,0,data,0);
        if(!ok) revert Failed();
    }
    function _return(address token,uint256 amount) private {
        if(amount==0) return;
        uint256 beforeOut=ICYToken(token).balanceOf(address(SAFE));
        _token(token,abi.encodeCall(ICYToken.transfer,(address(SAFE),amount)));
        if(ICYToken(token).balanceOf(address(SAFE))-beforeOut!=amount) revert Limit();
    }
    function _approve(address token,address spender,uint256 amount) private {
        _token(token,abi.encodeCall(ICYToken.approve,(spender,0)));
        if(amount!=0) _token(token,abi.encodeCall(ICYToken.approve,(spender,amount)));
    }
    function _token(address token,bytes memory data) private {
        (bool ok,bytes memory ret)=token.call(data);
        if(!ok) revert Failed();
        _checkToken(ret);
    }
    function _checkToken(bytes memory ret) private pure {
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

}
