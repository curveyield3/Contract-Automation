// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import "../../../.omni-v8-contracts/CurveYieldOmniAdapterV8.sol";
import "../../../.omni-v8-upstream/src/VaultV2.sol";

// The parent is the exact upstream Morpho VaultV2, not a test double.
// Market fixtures implement the protocol's called ABI and state/accounting.
contract HarnessToken {
    uint8 public constant decimals=18;
    uint256 public totalSupply;
    mapping(address=>uint256) public balanceOf;
    mapping(address=>mapping(address=>uint256)) public allowance;
    function mint(address to,uint256 n) external {balanceOf[to]+=n;totalSupply+=n;}
    function burn(address from,uint256 n) external {balanceOf[from]-=n;totalSupply-=n;}
    function approve(address who,uint256 n) external returns(bool){allowance[msg.sender][who]=n;return true;}
    function transfer(address to,uint256 n) external returns(bool){balanceOf[msg.sender]-=n;balanceOf[to]+=n;return true;}
    function transferFrom(address from,address to,uint256 n) external returns(bool){
        if(msg.sender!=from){uint256 a=allowance[from][msg.sender];if(a!=type(uint256).max)allowance[from][msg.sender]=a-n;}
        balanceOf[from]-=n;balanceOf[to]+=n;return true;
    }
}
contract HarnessShare is HarnessToken {
    HarnessToken public immutable asset;
    constructor(HarnessToken t){asset=t;}
    function deposit(uint256 n,address to) external returns(uint256){asset.transferFrom(msg.sender,address(this),n);this.mint(to,n);return n;}
    function withdraw(uint256 n,address to,address owner) external returns(uint256){require(owner==msg.sender);this.burn(owner,n);asset.transfer(to,n);return n;}
    function redeem(uint256 shares,address to,address owner) external returns(uint256){require(owner==msg.sender);this.burn(owner,shares);asset.transfer(to,shares);return shares;}
    function previewRedeem(uint256 n) external pure returns(uint256){return n;}
}
contract HarnessYearn is HarnessToken {
    HarnessToken public immutable token;
    uint256 public pricePerShare=1e18;
    constructor(HarnessToken t){token=t;}
    function deposit(uint256 n,address to) external returns(uint256 shares){
        shares=n*1e18/pricePerShare;token.transferFrom(msg.sender,address(this),n);this.mint(to,shares);
    }
    function withdraw(uint256 shares,address to,uint256 maxLoss) external returns(uint256 n){
        require(maxLoss<=10000);n=shares*pricePerShare/1e18;this.burn(msg.sender,shares);token.transfer(to,n);
    }
    function harvest(uint256 n) external{token.mint(address(this),n);pricePerShare=token.balanceOf(address(this))*1e18/totalSupply;}
}
contract HarnessBeefy is HarnessToken{
    HarnessToken public immutable want;
    constructor(HarnessToken t){want=t;}
    function getPricePerFullShare() external pure returns(uint256){return 1e18;}
    function deposit(uint256 n) external {want.transferFrom(msg.sender,address(this),n);this.mint(msg.sender,n);}
    function withdraw(uint256 n) external {this.burn(msg.sender,n);want.transfer(msg.sender,n);}
}
contract HarnessComet {
    HarnessToken public immutable baseToken;
    mapping(address=>uint256) public balanceOf;
    constructor(HarnessToken t){baseToken=t;}
    function supply(address token,uint256 n) external {require(token==address(baseToken));baseToken.transferFrom(msg.sender,address(this),n);balanceOf[msg.sender]+=n;}
    function withdraw(address token,uint256 n) external {require(token==address(baseToken));balanceOf[msg.sender]-=n;baseToken.transfer(msg.sender,n);}
}
contract HarnessAToken is HarnessToken {
    address public immutable POOL;
    address public immutable UNDERLYING_ASSET_ADDRESS;
    constructor(address p,address u){POOL=p;UNDERLYING_ASSET_ADDRESS=u;}
}
contract HarnessAave3 {
    HarnessToken public immutable base;
    HarnessAToken public immutable aToken;
    constructor(HarnessToken a){base=a;aToken=new HarnessAToken(address(this),address(a));}
    function getReserveData(address token) external view returns(ICYV8AaveV3.ReserveData memory r){require(token==address(base));r.aTokenAddress=address(aToken);}
    function supply(address token,uint256 n,address to,uint16) external {require(token==address(base));base.transferFrom(msg.sender,address(this),n);aToken.mint(to,n);}
    function withdraw(address token,uint256 n,address to) external returns(uint256){require(token==address(base));aToken.burn(msg.sender,n);base.transfer(to,n);return n;}
}
contract HarnessAave4 {
    HarnessToken public immutable token;
    mapping(uint256=>mapping(address=>uint256)) public supplied;
    constructor(HarnessToken t){token=t;}
    function getReserve(uint256 id) external view returns(ICYV8AaveSpoke.Reserve memory r){require(id==5);r.underlying=address(token);}
    function getUserSuppliedAssets(uint256 id,address who) external view returns(uint256){return supplied[id][who];}
    function supply(uint256 id,uint256 n,address who) external returns(uint256,uint256){
        require(id==5);token.transferFrom(msg.sender,address(this),n);supplied[id][who]+=n;return(n,n);
    }
    function withdraw(uint256 id,uint256 n,address who) external returns(uint256,uint256){
        require(id==5);supplied[id][who]-=n;token.transfer(msg.sender,n);return(n,n);
    }
}
contract HarnessMorpho {
    HarnessToken public immutable token;
    bytes32 public immutable marketId;
    uint128 public supplyAssets=1000e18;
    uint128 public supplyShares=1000e18;
    mapping(address=>uint256) public balances;
    constructor(HarnessToken t){
        token=t;
        ICYV8Morpho.MarketParams memory p=ICYV8Morpho.MarketParams(address(t),address(0),address(0),address(0),0);
        marketId=keccak256(abi.encode(p));
    }
    function market(bytes32 id) external view returns(ICYV8Morpho.Market memory m){
        require(id==marketId);m.totalSupplyAssets=supplyAssets;m.totalSupplyShares=supplyShares;m.lastUpdate=uint128(block.timestamp);
    }
    function idToMarketParams(bytes32 id) external view returns(ICYV8Morpho.MarketParams memory){
        require(id==marketId);return ICYV8Morpho.MarketParams(address(token),address(0),address(0),address(0),0);
    }
    function position(bytes32 id,address who) external view returns(ICYV8Morpho.Position memory p){require(id==marketId);p.supplyShares=balances[who];}
    function supply(ICYV8Morpho.MarketParams calldata p,uint256 n,uint256,address who,bytes calldata) external returns(uint256,uint256){
        require(keccak256(abi.encode(p))==marketId);token.transferFrom(msg.sender,address(this),n);balances[who]+=n;supplyAssets+=uint128(n);supplyShares+=uint128(n);return(n,n);
    }
    function withdraw(ICYV8Morpho.MarketParams calldata p,uint256 n,uint256,address who,address receiver) external returns(uint256,uint256){
        require(keccak256(abi.encode(p))==marketId);balances[who]-=n;supplyAssets-=uint128(n);supplyShares-=uint128(n);token.transfer(receiver,n);return(n,n);
    }
}
contract HarnessLiquity {
    HarnessToken public immutable boldToken;
    mapping(address=>uint256) public principal;
    mapping(address=>uint256) public yieldGain;
    constructor(HarnessToken t){boldToken=t;}
    function getCompoundedBoldDeposit(address who) external view returns(uint256){return principal[who];}
    function getDepositorYieldGainWithPending(address who) external view returns(uint256){return yieldGain[who];}
    function provideToSP(uint256 n,bool claim) external {
        require(!claim);boldToken.transferFrom(msg.sender,address(this),n);principal[msg.sender]+=n;
    }
    function withdrawFromSP(uint256 n,bool claim) external {
        require(claim);principal[msg.sender]-=n;uint256 r=yieldGain[msg.sender];yieldGain[msg.sender]=0;boldToken.transfer(msg.sender,n+r);
    }
    function accrue(address to,uint256 n) external {boldToken.mint(address(this),n);yieldGain[to]+=n;}
}
contract HarnessIsolationFactory {
    mapping(address=>address) public getVaultByAccount;
    function ensure(address who) external returns(address){address v=getVaultByAccount[who];if(v==address(0)){v=address(new HarnessIsolationAccount());getVaultByAccount[who]=v;}return v;}
}
contract HarnessIsolationAccount {}
contract HarnessDolomiteMargin {
    mapping(uint256=>address) public getMarketTokenAddress;
    mapping(bytes32=>uint256) public balances;
    function register(uint256 id,address token) external{getMarketTokenAddress[id]=token;}
    function key(address who,uint256 account,uint256 market) public pure returns(bytes32){return keccak256(abi.encode(who,account,market));}
    function add(address who,uint256 acc,uint256 id,uint256 n) external{balances[key(who,acc,id)]+=n;}
    function sub(address who,uint256 acc,uint256 id,uint256 n) external{balances[key(who,acc,id)]-=n;}
    function getAccountWei(ICYV8Dolomite.Account calldata a,uint256 id) external view returns(ICYV8Dolomite.SignedWei memory w){w.sign=true;w.value=balances[key(a.owner,a.number,id)];}
}
contract HarnessDolomiteRouter {
    HarnessDolomiteMargin public immutable DOLOMITE_MARGIN;
    constructor(HarnessDolomiteMargin m){DOLOMITE_MARGIN=m;}
    function depositWei(uint256 isolation,uint256 account,uint256 market,uint256 n,uint8) external {
        HarnessToken(DOLOMITE_MARGIN.getMarketTokenAddress(market)).transferFrom(msg.sender,address(this),n);
        address owner=msg.sender;
        if(isolation!=0)owner=HarnessIsolationFactory(DOLOMITE_MARGIN.getMarketTokenAddress(isolation)).ensure(msg.sender);
        DOLOMITE_MARGIN.add(owner,account,market,n);
    }
    function withdrawWei(uint256 isolation,uint256 account,uint256 market,uint256 n,uint8) external {
        address owner=msg.sender;
        if(isolation!=0)owner=HarnessIsolationFactory(DOLOMITE_MARGIN.getMarketTokenAddress(isolation)).getVaultByAccount(msg.sender);
        DOLOMITE_MARGIN.sub(owner,account,market,n);
        HarnessToken(DOLOMITE_MARGIN.getMarketTokenAddress(market)).transfer(msg.sender,n);
    }
}
contract OmniAdapterV8CompatibilityTest {
    HarnessToken internal token;
    VaultV2 internal vault;
    CurveYieldOmniAdapterV8 internal adapter;
    function setUp() public {
        token=new HarnessToken();
        vault=new VaultV2(address(this),address(token));
        vault.setCurator(address(this));
        adapter=new CurveYieldOmniAdapterV8(address(vault));
        _timelock(abi.encodeCall(vault.setIsAllocator,(address(this),true)));
        vault.setIsAllocator(address(this),true);
        _timelock(abi.encodeCall(vault.addAdapter,(address(adapter))));
        vault.addAdapter(address(adapter));
        token.mint(address(this),10000e18);
        token.approve(address(vault),type(uint256).max);
        require(vault.deposit(1000e18,address(this))!=0,"VAULT_DEPOSIT");
        require(vault.totalAssets()==1000e18,"VAULT_INITIAL_ASSETS");
    }
    function _timelock(bytes memory data) internal{vault.submit(data);}
    function _data(uint8 mode,address target,bytes32 id,address aux,uint256 minAmount,bytes memory extra) internal pure returns(bytes memory){
        return abi.encode(mode,target,id,aux,minAmount,extra);
    }
    function _register(uint8 mode,address target,bytes32 id,address aux) internal returns(bytes32 key){
        key=adapter.keyOf(mode,target,id,aux);
        bytes memory idData=adapter.idData(mode,target,id,aux);
        require(keccak256(idData)==key,"CAP_ID");
        _timelock(abi.encodeCall(vault.increaseAbsoluteCap,(idData,1_000_000e18)));
        vault.increaseAbsoluteCap(idData,1_000_000e18);
        _timelock(abi.encodeCall(vault.increaseRelativeCap,(idData,1e18)));
        vault.increaseRelativeCap(idData,1e18);
        require(vault.absoluteCap(key)==1_000_000e18 && vault.relativeCap(key)==1e18,"CAP_READS");
    }
    function _exercise(uint8 mode,address target,bytes32 id,address aux,bytes memory enterExtra,bytes memory exitExtra) internal{
        bytes32 key=_register(mode,target,id,aux);
        require(adapter.positionAssets(mode,target,id,aux)==0 && adapter.realAssets()==0 && adapter.marketCount()==0,"INIT_VIEWS");
        vault.allocate(address(adapter),_data(mode,target,id,aux,0,enterExtra),100e18);
        uint256 invested=adapter.positionAssets(mode,target,id,aux);
        require(invested>0 && adapter.realAssets()==invested,"DEPOSIT_VIEWS");
        require(adapter.marketCount()==1,"MARKET_COUNT");
        (bytes32 observed,)=adapter.marketAt(0);
        require(observed==key,"MARKET_ID");
        require(vault.allocation(key)==invested,"MORPHO_CAP_DELTA_ALLOCATE");
        (uint256 reported,,)=vault.accrueInterestView();
        require(reported!=0 && vault.totalAssets()!=0,"MORPHO_TOTAL_ASSETS_READS");
        vault.accrueInterest();
        uint256 beforeBalance=token.balanceOf(address(vault));
        vault.deallocate(address(adapter),_data(mode,target,id,aux,30e18,exitExtra),30e18);
        require(token.balanceOf(address(vault))==beforeBalance+30e18,"MORPHO_PULL");
        require(vault.allocation(key)==adapter.positionAssets(mode,target,id,aux),"MORPHO_CAP_DELTA_DEALLOCATE");
        require(adapter.realAssets()==adapter.positionAssets(mode,target,id,aux),"REAL_ASSETS");
        require(vault.totalAssets()!=0,"TOTAL_ASSETS_AFTER");
        require(vault.withdraw(1e18,address(this),address(this))!=0,"MORPHO_WITHDRAW");
    }
    function testERC4626() public{HarnessShare p=new HarnessShare(token);_exercise(1,address(p),0,address(0),"","");}
    function testBeefyV7() public{HarnessBeefy p=new HarnessBeefy(token);_exercise(2,address(p),0,address(0),"","");}
    function testAaveV3Spark() public{HarnessAave3 p=new HarnessAave3(token);_exercise(3,address(p),0,address(0),"","");}
    function testCompoundIII() public{HarnessComet p=new HarnessComet(token);_exercise(4,address(p),0,address(0),"","");}
    function testAaveV4Spoke() public{HarnessAave4 p=new HarnessAave4(token);_exercise(6,address(p),bytes32(uint256(5)),address(0),"","");}
    function testMorphoBlue() public{
        HarnessMorpho p=new HarnessMorpho(token);
        bytes memory param=abi.encode(ICYV8Morpho.MarketParams(address(token),address(0),address(0),address(0),0));
        _exercise(5,address(p),p.marketId(),address(0),param,param);
    }
    function testYearnV2() public{HarnessYearn p=new HarnessYearn(token);_exercise(8,address(p),0,address(0),"",abi.encode(uint256(0)));}
    function testLiquityBold() public{HarnessLiquity p=new HarnessLiquity(token);_exercise(9,address(p),0,address(0),"","");}
    function testLiquityYieldReturn() public{
        HarnessLiquity p=new HarnessLiquity(token);bytes32 key=_register(9,address(p),0,address(0));
        vault.allocate(address(adapter),_data(9,address(p),0,address(0),0,""),100e18);
        p.accrue(address(adapter),20e18);
        require(adapter.realAssets()==120e18,"YIELD_READ");
        vault.deallocate(address(adapter),_data(9,address(p),0,address(0),40e18,""),40e18);
        require(adapter.realAssets()==80e18 && adapter.positionAssets(9,address(p),0,address(0))==vault.allocation(key),"YIELD_CREDIT");
    }
    function testDolomiteNormal() public{
        HarnessDolomiteMargin m=new HarnessDolomiteMargin();HarnessDolomiteRouter p=new HarnessDolomiteRouter(m);
        m.register(3,address(token));_exercise(7,address(p),bytes32(uint256(3)),address(m),"","");
    }
    function testDolomiteIsolation() public{
        HarnessDolomiteMargin m=new HarnessDolomiteMargin();HarnessDolomiteRouter p=new HarnessDolomiteRouter(m);HarnessIsolationFactory f=new HarnessIsolationFactory();
        m.register(3,address(token));m.register(19,address(f));
        bytes memory extra=abi.encode(uint256(19),uint256(150),uint256(3));
        _exercise(10,address(p),keccak256(extra),address(m),extra,extra);
    }
    function testOnlyVaultMayCallCallbacks() public{
        HarnessShare p=new HarnessShare(token);
        (bool ok,)=address(adapter).call(abi.encodeWithSelector(adapter.allocate.selector,
            _data(1,address(p),0,address(0),0,""),uint256(1),bytes4(0),address(this)));
        require(!ok,"UNAUTHORIZED_ALLOCATION");
        (ok,)=address(adapter).call(abi.encodeWithSelector(adapter.deallocate.selector,
            _data(1,address(p),0,address(0),0,""),uint256(1),bytes4(0),address(this)));
        require(!ok,"UNAUTHORIZED_DEALLOCATION");
    }
}
