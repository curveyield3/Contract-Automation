// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * @title CurveYield Morpho Position Module v11
 * @notice Guardian authority for Worker-built Morpho Bundler3 calls.
 * @dev CurveYield uses existing DeFi primitives for all execution. This module
 *      does not construct bundles or flash loans, size trades, inspect swap routes,
 *      keep token allowlists, or manage temporary allowances. It snapshots Worker-specified
 *      shared-contract balances and enforces the LLTV buffer on worsening LTV.
 *      The Safe is the Bundler initiator and retains position ownership.
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
    function accrueInterest(CYMarketParams calldata p) external;
    function position(bytes32 id,address owner) external view returns(uint256,uint128,uint128);
    function market(bytes32 id) external view returns(uint128,uint128,uint128,uint128,uint128,uint128);
}
interface ICYSafe {
    function execTransactionFromModuleReturnData(address to,uint256 value,bytes calldata data,uint8 operation)
        external returns(bool,bytes memory);
}
interface ICYOracle { function price() external view returns(uint256); }
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
    bool private transient locked;
    struct Balance {uint256 bundler; uint256 adapter;}
    uint256 private constant LTV_BUFFER=2e15; // 0.2 percentage points

    error Unauthorized();
    error Invalid();
    error Failed();
    error BalanceChanged();
    error LtvIncreased();
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

    /// @notice Forward the exact complete multicall calldata built by the Worker.
    /// @dev Only one flash callback level; no arbitrary Safe forwarding.
    function execute(bytes32 market,bytes calldata data,uint256 deadline,address[] calldata snapshotTokens) external{
        if(msg.sender!=address(SAFE)&&!isExecutor[msg.sender]) revert Unauthorized();
        if(locked||block.timestamp>deadline||market==RESERVED_MARKET||!marketAllowed[market]||
           data.length<4||bytes4(data[:4])!=ICYBundler.multicall.selector) revert Invalid();
        locked=true;
        CYMarketParams memory p=MORPHO.idToMarketParams(market);
        MORPHO.accrueInterest(p);
        (uint256 debtBefore,uint256 valueBefore)=_position(market,p.oracle);
        // The Worker supplies the transaction's asset list. No on-chain
        // discovery, deduplication, token eligibility or route validation.
        Balance[] memory beforeBalances=new Balance[](snapshotTokens.length);
        for(uint256 i;i<snapshotTokens.length;++i){
            ICYToken token=ICYToken(snapshotTokens[i]);
            beforeBalances[i]=Balance(token.balanceOf(BUNDLER),token.balanceOf(ADAPTER));
        }
        if(!_validate(abi.decode(data[4:],(CYCall[])),market,p.loanToken,p.collateralToken,false)) revert Invalid();
        _safe(BUNDLER,data);
        for(uint256 i;i<snapshotTokens.length;++i){
            ICYToken token=ICYToken(snapshotTokens[i]);
            Balance memory b=beforeBalances[i];
            if(token.balanceOf(BUNDLER)!=b.bundler||
               token.balanceOf(ADAPTER)!=b.adapter) revert BalanceChanged();
        }
        _guardLtv(market,p,debtBefore,valueBefore);
        emit Executed(market,msg.sender,keccak256(data));
        locked=false;
    }

    // Validate delegated authority only. All swap eligibility and execution
    // protection is authoritative at OmniSwapper, not this wrapper.
    function _validate(CYCall[] memory calls,bytes32 market,address loan,address collateral,bool nested)
        private returns(bool flashSeen)
    {
        for(uint256 i;i<calls.length;++i){
            CYCall memory c=calls[i];
            bytes memory d=c.data;
            if(c.value!=0||c.skipRevert||d.length<4) revert Invalid();
            bytes4 sig=bytes4(d);
            if(c.to==ADAPTER&&sig==ICYAdapter.morphoFlashLoan.selector){
                if(nested||flashSeen) revert Invalid();
                (address token,uint256 amount,bytes memory callback)=abi.decode(_args(d),(address,uint256,bytes));
                if((token!=loan&&token!=collateral)||amount==0||keccak256(callback)!=c.callbackHash) revert Invalid();
                _validate(abi.decode(callback,(CYCall[])),market,loan,collateral,true);
                flashSeen=true;
                continue;
            }
            if(c.callbackHash!=bytes32(0)) revert Invalid();
            if(c.to==ADAPTER){
                if(sig==ICYAdapter.erc20Transfer.selector||sig==ICYAdapter.erc20TransferFrom.selector){
                    if(d.length!=100) revert Invalid();
                    address recipient=_address(d,32);
                    address token=_address(d,0);
                    if(sig==ICYAdapter.erc20TransferFrom.selector){
                        uint256 amount=_word(d,64);
                        // Safe allowance authority is confined to the market's assets.
                        if((token!=loan&&token!=collateral)||amount==0||amount==type(uint256).max||
                           (recipient!=ADAPTER&&recipient!=BUNDLER)) revert Unauthorized();
                        _approveOnce(token,amount);
                    }else{
                        if(recipient!=address(SAFE)&&recipient!=BUNDLER) revert Unauthorized();
                    }
                    continue;
                }
                if(d.length<164||_marketId(d)!=market) revert Unauthorized();
                if(sig==ICYAdapter.morphoBorrow.selector){
                    if(d.length!=292) revert Invalid();
                    _receiver(_address(d,256));
                }else if(sig==ICYAdapter.morphoWithdrawCollateral.selector){
                    if(d.length!=228) revert Invalid();
                    _receiver(_address(d,192));
                }else if(sig==ICYAdapter.morphoRepay.selector){
                    if(d.length!=356||_address(d,256)!=address(SAFE)||
                       _word(d,288)!=320||_word(d,320)!=0) revert Invalid();
                }else if(sig==ICYAdapter.morphoSupplyCollateral.selector){
                    if(d.length!=292||_address(d,192)!=address(SAFE)||
                       _word(d,224)!=256||_word(d,256)!=0) revert Invalid();
                }else revert Unauthorized();
            }else if(c.to==SWAPPER){
                if(sig!=ICYSwapper.swapExactInput.selector||d.length!=196) revert Unauthorized();
                _receiver(_address(d,128));
            }else{
                // These calls originate from the public Bundler, never the Safe.
                // Only ERC20 approval to the fixed router or transfer to a custody endpoint.
                if(c.to==address(SAFE)||c.to==BUNDLER||c.to==address(MORPHO)||
                   c.to==address(this)||d.length!=68) revert Unauthorized();
                address recipient=_address(d,0);
                if(sig==ICYToken.approve.selector){
                    if(recipient!=SWAPPER||_word(d,32)!=type(uint256).max) revert Unauthorized();
                }else if(sig==ICYToken.transfer.selector) _receiver(recipient);
                else revert Unauthorized();
            }
        }
    }
    // Match Morpho's conservative health-check rounding and virtual shares.
    function _position(bytes32 market,address oracle) private view returns(uint256 debt,uint256 value){
        (,uint128 shares,uint128 collateral)=MORPHO.position(market,address(SAFE));
        if(shares!=0){
            (,,uint128 assets,uint128 totalShares,,)=MORPHO.market(market);
            // uint128 shares * (uint128 assets + 1) < 2**256.
            debt=1+(uint256(shares)*(uint256(assets)+1)-1)/(uint256(totalShares)+1e6);
        }
        value=uint256(collateral)*ICYOracle(oracle).price()/1e36;
    }
    function _guardLtv(bytes32 market,CYMarketParams memory p,uint256 debtBefore,uint256 valueBefore) private view{
        (uint256 debt,uint256 value)=_position(market,p.oracle);
        if(debt==0) return;
        uint256 limit=p.lltv>LTV_BUFFER?p.lltv-LTV_BUFFER:0;
        if(_productLe(debt,1e18,value,limit)) return;
        // Above the limit: allow unchanged or improved LTV, including a
        // partial deleverage. A previously debt-free position may not cross it.
        if(debtBefore==0||!_productLe(debt,valueBefore,debtBefore,value)) revert LtvIncreased();
    }
    // Compare exact 512-bit products without rounding a ratio or overflowing.
    function _productLe(uint256 a,uint256 b,uint256 c,uint256 d) private pure returns(bool ok){
        assembly ("memory-safe"){
            let l:=mul(a,b)
            let lm:=mulmod(a,b,not(0))
            let lh:=sub(sub(lm,l),lt(lm,l))
            let r:=mul(c,d)
            let rm:=mulmod(c,d,not(0))
            let rh:=sub(sub(rm,r),lt(rm,r))
            ok:=or(lt(lh,rh),and(eq(lh,rh),iszero(gt(l,r))))
        }
    }
    function _marketId(bytes memory d) private pure returns(bytes32 id){
        assembly ("memory-safe"){id:=keccak256(add(d,36),160)}
    }
    function _word(bytes memory d,uint256 offset) private pure returns(uint256 result){
        // Every caller first checks the complete canonical argument length.
        if(offset+36>d.length) revert Invalid();
        assembly ("memory-safe"){result:=mload(add(add(d,36),offset))}
    }
    function _address(bytes memory d,uint256 offset) private pure returns(address){
        uint256 w=_word(d,offset);
        if(w>type(uint160).max) revert Invalid();
        return address(uint160(w));
    }
    function _args(bytes memory d) private pure returns(bytes memory a){
        a=new bytes(d.length-4);
        assembly ("memory-safe"){mcopy(add(a,32),add(d,36),mload(a))}
    }
    function _receiver(address to) private view{
        if(to!=address(SAFE)&&to!=BUNDLER&&to!=ADAPTER) revert Unauthorized();
    }
    // Persistent approval to the existing initiator-scoped adapter, only when needed.
    // No seed parameters, temporary allowances, allowance restoration or reset calls.
    function _approveOnce(address token,uint256 required) private{
        if(ICYToken(token).allowance(address(SAFE),ADAPTER)>=required) return;
        bytes memory ret=_safe(token,abi.encodeCall(ICYToken.approve,(ADAPTER,type(uint256).max)));
        if(ret.length!=0&&!abi.decode(ret,(bool))) revert Failed();
    }
    function _safe(address to,bytes memory data) private returns(bytes memory ret){
        bool ok;(ok,ret)=SAFE.execTransactionFromModuleReturnData(to,0,data,0);
        if(!ok) revert Failed();
    }
}
