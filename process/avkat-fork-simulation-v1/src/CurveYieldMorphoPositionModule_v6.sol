// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * @title CurveYield Morpho Position Module v6
 * @notice Scoped Guardian authority for existing Morpho Bundler3 transactions.
 * @dev No financial calculations, flash callback, custody engine, position accounting,
 *      swap logic, or primary-module integration. Bundler3 and GeneralAdapter1 perform
 *      the transaction; OmniSwapper enforces its configured swap protections.
 *      The Safe remains the Bundler initiator and the owner of every position.
 */
struct CYMarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}
struct CYCall {
    address to;
    bytes data;
    uint256 value;
    bool skipRevert;
    bytes32 callbackHash;
}
interface ICYMorpho {
    function idToMarketParams(bytes32 id) external view returns(CYMarketParams memory);
}
interface ICYSafe {
    function execTransactionFromModuleReturnData(address to,uint256 value,bytes calldata data,uint8 operation)
        external returns(bool,bytes memory);
}
interface ICYToken {
    function balanceOf(address owner) external view returns(uint256);
    function allowance(address owner,address spender) external view returns(uint256);
    function approve(address spender,uint256 amount) external returns(bool);
    function transfer(address receiver,uint256 amount) external returns(bool);
}
interface ICYBundler {
    function multicall(CYCall[] calldata calls) external payable;
}
interface ICYAdapter {
    function BUNDLER3() external view returns(address);
    function MORPHO() external view returns(address);
    function morphoFlashLoan(address token,uint256 amount,bytes calldata data) external;
    function morphoBorrow(CYMarketParams calldata p,uint256 assets,uint256 shares,uint256 minSharePriceE27,address receiver) external;
    function morphoRepay(CYMarketParams calldata p,uint256 assets,uint256 shares,uint256 maxSharePriceE27,address owner,bytes calldata data) external;
    function morphoSupplyCollateral(CYMarketParams calldata p,uint256 assets,address owner,bytes calldata data) external;
    function morphoWithdrawCollateral(CYMarketParams calldata p,uint256 assets,address receiver) external;
    function erc20Transfer(address token,address receiver,uint256 amount) external;
    function erc20TransferFrom(address token,address receiver,uint256 amount) external;
}
interface ICYSwapper {
    function swapExactInput(address from,address to,uint256 amount,uint256 minimum,address receiver,uint256 deadline)
        external returns(uint256);
}
contract CurveYieldMorphoPositionModule {
    ICYSafe public immutable SAFE;
    ICYMorpho public immutable MORPHO;
    address public immutable BUNDLER;
    address public immutable ADAPTER;
    address public immutable SWAPPER;
    bytes32 public immutable RESERVED_MARKET;
    mapping(address=>bool) public isExecutor;
    mapping(bytes32=>bool) public marketAllowed;
    mapping(address=>bool) public routeTokenAllowed;
    bool private transient locked;

    struct Scope {
        bytes32 market;
        address flashToken;
        uint256 flashAmount;
        address seedToken;
        uint256 seedAmount;
        uint256 deadline;
        address[] tokens; // every token touched by the bundle, for scope and residue checks
    }
    error Unauthorized();
    error Invalid();
    error Failed();
    event ExecutorSet(address indexed executor,bool enabled);
    event MarketSet(bytes32 indexed market,bool enabled);
    event RouteTokenSet(address indexed token,bool enabled);
    event Executed(bytes32 indexed market,address indexed executor,bytes32 bundleHash);

    modifier onlySafe(){if(msg.sender!=address(SAFE)) revert Unauthorized();_;}

    constructor(address safe,address morpho,address bundler,address adapter,address swapper,bytes32 reservedMarket){
        if(safe.code.length==0||morpho.code.length==0||bundler.code.length==0||
           adapter.code.length==0||swapper.code.length==0||
           ICYAdapter(adapter).BUNDLER3()!=bundler||ICYAdapter(adapter).MORPHO()!=morpho) revert Invalid();
        SAFE=ICYSafe(safe); MORPHO=ICYMorpho(morpho); BUNDLER=bundler; ADAPTER=adapter; SWAPPER=swapper;
        RESERVED_MARKET=reservedMarket;
    }
    function setExecutor(address executor,bool enabled) external onlySafe{
        isExecutor[executor]=enabled;emit ExecutorSet(executor,enabled);
    }
    function setMarket(bytes32 id,bool enabled) external onlySafe{
        if(id==bytes32(0)||id==RESERVED_MARKET) revert Invalid();
        if(enabled){
            CYMarketParams memory p=MORPHO.idToMarketParams(id);
            if(p.loanToken==p.collateralToken||p.loanToken.code.length==0||
               p.collateralToken.code.length==0||keccak256(abi.encode(p))!=id) revert Invalid();
        }
        marketAllowed[id]=enabled;emit MarketSet(id,enabled);
    }
    function setRouteToken(address token,bool enabled) external onlySafe{
        if(enabled&&token.code.length==0) revert Invalid();
        routeTokenAllowed[token]=enabled;emit RouteTokenSet(token,enabled);
    }

    /// @notice Forward Worker-authored flash callback and settlement calls via the Safe.
    /// @dev Only the existing adapter, router and scoped ERC20 methods can be reached.
    ///      The adapter owns the flash callback and all lending logic. No skipRevert,
    ///      nested callback, arbitrary receiver, arbitrary target or Safe delegatecall.
    function execute(Scope calldata s,CYCall[] calldata during,CYCall[] calldata afterCalls) external{
        if(msg.sender!=address(SAFE)&&!isExecutor[msg.sender]) revert Unauthorized();
        if(locked||block.timestamp>s.deadline||s.flashAmount==0||during.length==0||
           s.market==RESERVED_MARKET||!marketAllowed[s.market]) revert Invalid();
        locked=true;
        CYMarketParams memory p=MORPHO.idToMarketParams(s.market);
        if(s.flashToken!=p.loanToken&&s.flashToken!=p.collateralToken) revert Invalid();
        if(s.seedAmount==type(uint256).max||
           (s.seedAmount==0?s.seedToken!=address(0):(s.seedToken!=p.loanToken&&s.seedToken!=p.collateralToken))) revert Invalid();
        _tokenIn(s,p.loanToken);_tokenIn(s,p.collateralToken);
        uint256[] memory pre=new uint256[](s.tokens.length*2);
        for(uint256 i;i<s.tokens.length;++i){
            address t=s.tokens[i];
            if(t!=p.loanToken&&t!=p.collateralToken&&!routeTokenAllowed[t]) revert Unauthorized();
            pre[2*i]=ICYToken(t).balanceOf(BUNDLER);
            pre[2*i+1]=ICYToken(t).balanceOf(ADAPTER);
        }
        _validate(s,during);
        _validate(s,afterCalls);
        uint256 prior;
        if(s.seedAmount!=0){
            prior=ICYToken(s.seedToken).allowance(address(SAFE),ADAPTER);
            _seedApproval(s.seedToken,s.seedAmount);
        }
        bytes memory callback=abi.encode(during);
        CYCall[] memory bundle=new CYCall[](afterCalls.length+1);
        bundle[0]=CYCall(ADAPTER,abi.encodeCall(ICYAdapter.morphoFlashLoan,
            (s.flashToken,s.flashAmount,callback)),0,false,keccak256(callback));
        for(uint256 i;i<afterCalls.length;++i) bundle[i+1]=afterCalls[i];
        bytes memory data=abi.encodeCall(ICYBundler.multicall,(bundle));
        _safe(BUNDLER,data);
        if(s.seedAmount!=0) _seedApproval(s.seedToken,prior);
        for(uint256 i;i<s.tokens.length;++i){
            address t=s.tokens[i];
            if(ICYToken(t).balanceOf(BUNDLER)!=pre[2*i]||
               ICYToken(t).balanceOf(ADAPTER)!=pre[2*i+1]) revert Invalid();
        }
        emit Executed(s.market,msg.sender,keccak256(data));
        locked=false;
    }

    function _validate(Scope calldata s,CYCall[] calldata calls) private view{
        for(uint256 i;i<calls.length;++i){
            CYCall calldata c=calls[i];
            if(c.value!=0||c.skipRevert||c.callbackHash!=bytes32(0)||c.data.length<4) revert Invalid();
            bytes4 sig=bytes4(c.data[:4]);
            bytes calldata args=c.data[4:];
            if(c.to==ADAPTER){
                if(sig==ICYAdapter.morphoBorrow.selector){
                    (CYMarketParams memory p,,, ,address receiver)=abi.decode(args,(CYMarketParams,uint256,uint256,uint256,address));
                    _market(s,p);_receiver(receiver);
                }else if(sig==ICYAdapter.morphoRepay.selector){
                    (CYMarketParams memory p,,,,address owner,bytes memory nested)=abi.decode(args,(CYMarketParams,uint256,uint256,uint256,address,bytes));
                    _market(s,p);if(owner!=address(SAFE)||nested.length!=0) revert Invalid();
                }else if(sig==ICYAdapter.morphoSupplyCollateral.selector){
                    (CYMarketParams memory p,,address owner,bytes memory nested)=abi.decode(args,(CYMarketParams,uint256,address,bytes));
                    _market(s,p);if(owner!=address(SAFE)||nested.length!=0) revert Invalid();
                }else if(sig==ICYAdapter.morphoWithdrawCollateral.selector){
                    (CYMarketParams memory p,,address receiver)=abi.decode(args,(CYMarketParams,uint256,address));
                    _market(s,p);_receiver(receiver);
                }else if(sig==ICYAdapter.erc20Transfer.selector){
                    (address t,address receiver,)=abi.decode(args,(address,address,uint256));
                    _tokenIn(s,t);_receiver(receiver);
                    if(receiver==ADAPTER) revert Invalid();
                }else if(sig==ICYAdapter.erc20TransferFrom.selector){
                    (address t,address receiver,uint256 amount)=abi.decode(args,(address,address,uint256));
                    if(t!=s.seedToken||amount==0||amount>s.seedAmount||
                       (receiver!=ADAPTER&&receiver!=BUNDLER)) revert Invalid();
                }else revert Unauthorized();
            }else if(c.to==SWAPPER){
                if(sig!=ICYSwapper.swapExactInput.selector) revert Unauthorized();
                (address from,address to,,,address receiver,)=abi.decode(args,(address,address,uint256,uint256,address,uint256));
                _tokenIn(s,from);_tokenIn(s,to);_receiver(receiver);
            }else{
                _tokenIn(s,c.to);
                if(sig==ICYToken.approve.selector){
                    (address spender,)=abi.decode(args,(address,uint256));
                    if(spender!=SWAPPER) revert Unauthorized();
                }else if(sig==ICYToken.transfer.selector){
                    (address receiver,)=abi.decode(args,(address,uint256));
                    _receiver(receiver);
                }else revert Unauthorized();
            }
        }
    }
    function _market(Scope calldata s,CYMarketParams memory p) private pure{
        if(keccak256(abi.encode(p))!=s.market) revert Unauthorized();
    }
    function _tokenIn(Scope calldata s,address t) private pure{
        for(uint256 i;i<s.tokens.length;++i) if(s.tokens[i]==t) return;
        revert Unauthorized();
    }
    function _receiver(address to) private view{
        if(to!=address(SAFE)&&to!=BUNDLER&&to!=ADAPTER) revert Unauthorized();
    }
    function _seedApproval(address token,uint256 amount) private{
        _approve(token,0);
        if(amount!=0) _approve(token,amount);
    }
    function _approve(address token,uint256 amount) private{
        bytes memory ret=_safe(token,abi.encodeCall(ICYToken.approve,(ADAPTER,amount)));
        if(ret.length!=0&&!abi.decode(ret,(bool))) revert Failed();
    }
    function _safe(address to,bytes memory data) private returns(bytes memory ret){
        bool ok;(ok,ret)=SAFE.execTransactionFromModuleReturnData(to,0,data,0);
        if(!ok) revert Failed();
    }
}
