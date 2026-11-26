// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * @title CurveYield Morpho Position Module v7
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
    function routeFor(address from,address to) external view returns(bytes memory);
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
    bool private transient locked;

    struct Scope {
        bytes32 market;
        address flashToken;
        uint256 flashAmount;
        address seedToken;
        uint256 seedAmount;
        uint256 deadline;
        address[] tokens; // ordered route assets, including both market assets; no persistent token registry
    }
    error Unauthorized();
    error Invalid();
    error Failed();
    event ExecutorSet(address indexed executor,bool enabled);
    event MarketSet(bytes32 indexed market,bool enabled);
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

    /// @notice Forward Worker-authored flash callback and settlement calls via the Safe.
    /// @dev Only the existing adapter, router and scoped ERC20 methods can be reached.
    ///      The adapter owns the flash callback and all lending logic. No skipRevert,
    ///      nested callback, arbitrary receiver, arbitrary target or Safe delegatecall.
    ///      OmniSwapper approval is max uint, reused by the Worker when already present.
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
            if(t.code.length==0) revert Invalid();
            // Use the router's authoritative configured routes, not a secondary token registry.
            // Start with either market token; every intermediary must connect to the preceding token.
            if(i==0){if(t!=p.loanToken&&t!=p.collateralToken) revert Unauthorized();}
            else{
                address prev=s.tokens[i-1];
                if(prev==t||(ICYSwapper(SWAPPER).routeFor(prev,t).length==0&&
                   ICYSwapper(SWAPPER).routeFor(t,prev).length==0)) revert Unauthorized();
            }
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

    // Inspect fixed ABI heads directly. Market tuples are five static words.
    // Canonical lengths and empty callback tails keep nested calls out of scope.
    function _validate(Scope calldata s,CYCall[] calldata calls) private view{
        for(uint256 i;i<calls.length;++i){
            CYCall calldata c=calls[i];
            if(c.value!=0||c.skipRevert||c.callbackHash!=bytes32(0)||c.data.length<4) revert Invalid();
            bytes4 sig=bytes4(c.data[:4]);
            bytes calldata a=c.data[4:];
            if(c.to==ADAPTER){
                if(sig==ICYAdapter.erc20Transfer.selector||sig==ICYAdapter.erc20TransferFrom.selector){
                    if(a.length!=96) revert Invalid();
                    address token=_address(a,0);
                    address receiver=_address(a,32);
                    _tokenIn(s,token);
                    if(sig==ICYAdapter.erc20TransferFrom.selector){
                        uint256 amount=_word(a,64);
                        if(token!=s.seedToken||amount==0||amount>s.seedAmount||
                           (receiver!=ADAPTER&&receiver!=BUNDLER)) revert Unauthorized();
                    }else{
                        _receiver(receiver);
                        if(receiver==ADAPTER) revert Invalid();
                    }
                    continue;
                }
                if(a.length<160||keccak256(a[:160])!=s.market) revert Unauthorized();
                if(sig==ICYAdapter.morphoBorrow.selector){
                    if(a.length!=288) revert Invalid();
                    _receiver(_address(a,256));
                }else if(sig==ICYAdapter.morphoWithdrawCollateral.selector){
                    if(a.length!=224) revert Invalid();
                    _receiver(_address(a,192));
                }else if(sig==ICYAdapter.morphoRepay.selector){
                    if(a.length!=352||_address(a,256)!=address(SAFE)||
                       _word(a,288)!=320||_word(a,320)!=0) revert Invalid();
                }else if(sig==ICYAdapter.morphoSupplyCollateral.selector){
                    if(a.length!=288||_address(a,192)!=address(SAFE)||
                       _word(a,224)!=256||_word(a,256)!=0) revert Invalid();
                }else revert Unauthorized();
            }else if(c.to==SWAPPER){
                if(sig!=ICYSwapper.swapExactInput.selector||a.length!=192) revert Unauthorized();
                _tokenIn(s,_address(a,0));_tokenIn(s,_address(a,32));
                _receiver(_address(a,128));
            }else{
                _tokenIn(s,c.to);
                if(a.length!=64) revert Invalid();
                address target=_address(a,0);
                if(sig==ICYToken.approve.selector){
                    // Worker only includes this call when approval is needed.
                    // Bundler3 is the payer; leave its maximum router allowance intact.
                    if(target!=SWAPPER||_word(a,32)!=type(uint256).max) revert Unauthorized();
                }else if(sig==ICYToken.transfer.selector) _receiver(target);
                else revert Unauthorized();
            }
        }
    }
    function _word(bytes calldata a,uint256 offset) private pure returns(uint256 result){
        if(offset+32>a.length) revert Invalid();
        assembly ("memory-safe"){result:=calldataload(add(a.offset,offset))}
    }
    function _address(bytes calldata a,uint256 offset) private pure returns(address){
        uint256 w=_word(a,offset);
        if(w>type(uint160).max) revert Invalid();
        return address(uint160(w));
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
