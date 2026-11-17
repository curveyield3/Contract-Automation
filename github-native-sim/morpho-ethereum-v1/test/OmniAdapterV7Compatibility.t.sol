// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import "../CurveYieldOmniAdapterV7.sol";

contract TokenV7Fixture {
    uint8 public constant decimals=18;
    uint256 public totalSupply;
    mapping(address=>uint256) public balanceOf;
    mapping(address=>mapping(address=>uint256)) public allowance;
    function mint(address to,uint256 n) public {balanceOf[to]+=n;totalSupply+=n;}
    function burn(address from,uint256 n) public {balanceOf[from]-=n;totalSupply-=n;}
    function transfer(address to,uint256 n) public returns(bool){balanceOf[msg.sender]-=n;balanceOf[to]+=n;return true;}
    function approve(address to,uint256 n) public returns(bool){allowance[msg.sender][to]=n;return true;}
    function transferFrom(address from,address to,uint256 n) public returns(bool){
        if(msg.sender!=from){uint256 a=allowance[from][msg.sender];if(a!=type(uint256).max)allowance[from][msg.sender]=a-n;}
        balanceOf[from]-=n;balanceOf[to]+=n;return true;
    }
}
interface IAdapterV7Callback {
    function allocate(bytes calldata,uint256,bytes4,address) external returns(bytes32[] memory,int256);
    function deallocate(bytes calldata,uint256,bytes4,address) external returns(bytes32[] memory,int256);
}
contract ParentV7Fixture {
    TokenV7Fixture public immutable asset;
    address public adapter;
    mapping(bytes32=>uint256) public allocation;
    mapping(bytes32=>uint256) public caps;
    constructor(TokenV7Fixture t){asset=t;}
    function setAdapter(address a) external {require(adapter==address(0));adapter=a;asset.approve(a,type(uint256).max);}
    function setCap(bytes32 id,uint256 n) external {caps[id]=n;}
    function allocate(bytes calldata d,uint256 n) external {
        asset.transfer(adapter,n);
        (bytes32[] memory ids,int256 delta)=IAdapterV7Callback(adapter).allocate(d,n,msg.sig,msg.sender);
        require(ids.length==1);
        int256 next=int256(allocation[ids[0]])+delta;
        require(next>=0&&uint256(next)<=caps[ids[0]],'CAP');
        allocation[ids[0]]=uint256(next);
    }
    function deallocate(bytes calldata d,uint256 n) external {
        (bytes32[] memory ids,int256 delta)=IAdapterV7Callback(adapter).deallocate(d,n,msg.sig,msg.sender);
        require(ids.length==1);
        int256 next=int256(allocation[ids[0]])+delta;
        require(next>=0,'NEGATIVE_ALLOCATION');
        allocation[ids[0]]=uint256(next);
        asset.transferFrom(adapter,address(this),n);
    }
}
contract ERC4626V7Fixture is TokenV7Fixture {
    TokenV7Fixture public immutable asset;
    constructor(TokenV7Fixture a){asset=a;}
    function deposit(uint256 n,address to) external returns(uint256){asset.transferFrom(msg.sender,address(this),n);mint(to,n);return n;}
    function withdraw(uint256 n,address to,address from) external returns(uint256){burn(from,n);asset.transfer(to,n);return n;}
    function previewRedeem(uint256 n) external pure returns(uint256){return n;}
}
contract YearnV2Fixture is TokenV7Fixture {
    TokenV7Fixture public immutable token;
    uint256 public pricePerShare=1e18;
    constructor(TokenV7Fixture a){token=a;}
    function deposit(uint256 n,address to) external returns(uint256){
        uint256 shares=n*1e18/pricePerShare;token.transferFrom(msg.sender,address(this),n);mint(to,shares);return shares;
    }
    function withdraw(uint256 shares,address to,uint256 maxLossBps) external returns(uint256){
        require(maxLossBps<=10000);uint256 n=shares*pricePerShare/1e18;burn(msg.sender,shares);token.transfer(to,n);return n;
    }
    function harvest(uint256 n) external {token.mint(address(this),n);pricePerShare=token.balanceOf(address(this))*1e18/totalSupply;}
}
contract CapV7Fixture is TokenV7Fixture {
    TokenV7Fixture public immutable reserve;
    constructor(TokenV7Fixture a){reserve=a;}
    function assets() external view returns(address[] memory out){out=new address[](1);out[0]=address(reserve);}
    function getBurnAmount(address,address a,uint256 shares) external view returns(uint256,uint256){
        require(a==address(reserve));return(shares*99/100,shares/100);
    }
    function mint(address a,uint256 n,uint256 min,address to,uint256 deadline) external returns(uint256 result){
        require(a==address(reserve)&&deadline>=block.timestamp);
        result=n*995/1000;require(result>=min);reserve.transferFrom(msg.sender,address(this),n);
        mint(to,result);
    }
    function burn(address a,uint256 shares,uint256 min,address to,uint256 deadline) external returns(uint256 n){
        require(a==address(reserve)&&deadline>=block.timestamp);
        n=shares*99/100;require(n>=min);burn(msg.sender,shares);reserve.transfer(to,n);
    }
}
contract LiquityV7Fixture {
    TokenV7Fixture public immutable boldToken;
    mapping(address=>uint256) public deposits;
    constructor(TokenV7Fixture a){boldToken=a;}
    function getCompoundedBoldDeposit(address a) external view returns(uint256){return deposits[a];}
    function getDepositorYieldGainWithPending(address) external pure returns(uint256){return 0;}
    function provideToSP(uint256 n,bool claim) external {require(!claim);boldToken.transferFrom(msg.sender,address(this),n);deposits[msg.sender]+=n;}
    function withdrawFromSP(uint256 n,bool claim) external {require(claim);deposits[msg.sender]-=n;boldToken.transfer(msg.sender,n);}
}

contract BeefyV7Fixture is TokenV7Fixture {
    TokenV7Fixture public immutable want;
    constructor(TokenV7Fixture a){want=a;}
    function getPricePerFullShare() external pure returns(uint256){return 1e18;}
    function deposit(uint256 n) external {want.transferFrom(msg.sender,address(this),n);mint(msg.sender,n);}
    function withdraw(uint256 shares) external {burn(msg.sender,shares);want.transfer(msg.sender,shares);}
}
contract CompoundV7Fixture {
    TokenV7Fixture public immutable baseToken;
    mapping(address=>uint256) public balanceOf;
    constructor(TokenV7Fixture a){baseToken=a;}
    function supply(address a,uint256 n) external {require(a==address(baseToken));baseToken.transferFrom(msg.sender,address(this),n);balanceOf[msg.sender]+=n;}
    function withdraw(address a,uint256 n) external {require(a==address(baseToken));balanceOf[msg.sender]-=n;baseToken.transfer(msg.sender,n);}
}
contract ATokenV7Fixture is TokenV7Fixture {
    address public immutable POOL;
    address public immutable UNDERLYING_ASSET_ADDRESS;
    constructor(address p,address a){POOL=p;UNDERLYING_ASSET_ADDRESS=a;}
}
contract AaveV3Fixture {
    TokenV7Fixture public immutable base;
    ATokenV7Fixture public immutable aToken;
    constructor(TokenV7Fixture a){base=a;aToken=new ATokenV7Fixture(address(this),address(a));}
    function getReserveData(address a) external view returns(ICYV7AaveV3.ReserveData memory r){require(a==address(base));r.aTokenAddress=address(aToken);}
    function supply(address a,uint256 n,address to,uint16) external {require(a==address(base));base.transferFrom(msg.sender,address(this),n);aToken.mint(to,n);}
    function withdraw(address a,uint256 n,address to) external returns(uint256){require(a==address(base));aToken.burn(msg.sender,n);base.transfer(to,n);return n;}
}
contract AaveV4Fixture {
    TokenV7Fixture public immutable underlying;
    mapping(uint256=>mapping(address=>uint256)) public supplied;
    constructor(TokenV7Fixture a){underlying=a;}
    function getReserve(uint256 id) external view returns(ICYV7AaveSpoke.Reserve memory r){require(id==5);r.underlying=address(underlying);}
    function getUserSuppliedAssets(uint256 id,address user) external view returns(uint256){return supplied[id][user];}
    function supply(uint256 id,uint256 n,address to) external returns(uint256,uint256){require(id==5);underlying.transferFrom(msg.sender,address(this),n);supplied[id][to]+=n;return(n,n);}
    function withdraw(uint256 id,uint256 n,address from) external returns(uint256,uint256){require(id==5);supplied[id][from]-=n;underlying.transfer(msg.sender,n);return(n,n);}
}
contract MorphoBlueV7Fixture {
    TokenV7Fixture public immutable underlying;
    ICYV7Morpho.MarketParams private mParams;
    bytes32 public immutable marketId;
    uint128 public supplyAssets=uint128(1000e18);
    uint128 public supplyShares=uint128(1000e18);
    mapping(address=>uint256) public positions;
    constructor(TokenV7Fixture a){
        underlying=a;mParams=ICYV7Morpho.MarketParams(address(a),address(0),address(0),address(0),0);
        marketId=keccak256(abi.encode(mParams));
    }
    function params() external view returns(ICYV7Morpho.MarketParams memory){return mParams;}
    function market(bytes32 id) external view returns(ICYV7Morpho.Market memory m){
        require(id==marketId);m.totalSupplyAssets=supplyAssets;m.totalSupplyShares=supplyShares;m.lastUpdate=uint128(block.timestamp);
    }
    function idToMarketParams(bytes32 id) external view returns(ICYV7Morpho.MarketParams memory){require(id==marketId);return mParams;}
    function position(bytes32 id,address a) external view returns(ICYV7Morpho.Position memory p){require(id==marketId);p.supplyShares=positions[a];}
    function supply(ICYV7Morpho.MarketParams calldata p,uint256 n,uint256,address to,bytes calldata) external returns(uint256,uint256){
        require(keccak256(abi.encode(p))==marketId);underlying.transferFrom(msg.sender,address(this),n);
        positions[to]+=n;supplyAssets+=uint128(n);supplyShares+=uint128(n);return(n,n);
    }
    function withdraw(ICYV7Morpho.MarketParams calldata p,uint256 n,uint256,address from,address to) external returns(uint256,uint256){
        require(keccak256(abi.encode(p))==marketId);positions[from]-=n;
        supplyAssets-=uint128(n);supplyShares-=uint128(n);underlying.transfer(to,n);return(n,n);
    }
}
contract DolomiteIsolationVaultV7Fixture {}
contract DolomiteIsolationFactoryV7Fixture {
    mapping(address=>address) public getVaultByAccount;
    function ensure(address who) external returns(address result) {
        result=getVaultByAccount[who];
        if(result==address(0)){result=address(new DolomiteIsolationVaultV7Fixture());getVaultByAccount[who]=result;}
    }
}
contract DolomiteMarginV7Fixture {
    mapping(uint256=>address) public getMarketTokenAddress;
    mapping(bytes32=>uint256) public holdings;
    function register(uint256 market,address t) external {getMarketTokenAddress[market]=t;}
    function slot(address who,uint256 account,uint256 market) public pure returns(bytes32){return keccak256(abi.encode(who,account,market));}
    function add(address who,uint256 account,uint256 market,uint256 n) external {holdings[slot(who,account,market)]+=n;}
    function take(address who,uint256 account,uint256 market,uint256 n) external {holdings[slot(who,account,market)]-=n;}
    function getAccountWei(ICYV7Dolomite.Account calldata who,uint256 market) external view returns(ICYV7Dolomite.SignedWei memory r) {
        r.sign=true;r.value=holdings[slot(who.owner,who.number,market)];
    }
}
contract DolomiteRouterV7Fixture {
    DolomiteMarginV7Fixture public immutable DOLOMITE_MARGIN;
    constructor(DolomiteMarginV7Fixture m){DOLOMITE_MARGIN=m;}
    function _owner(uint256 iso) private returns(address who) {
        who=msg.sender;
        if(iso!=0)who=DolomiteIsolationFactoryV7Fixture(DOLOMITE_MARGIN.getMarketTokenAddress(iso)).ensure(msg.sender);
    }
    function _account(uint256 iso) private view returns(address who) {
        who=msg.sender;
        if(iso!=0)who=DolomiteIsolationFactoryV7Fixture(DOLOMITE_MARGIN.getMarketTokenAddress(iso)).getVaultByAccount(msg.sender);
    }
    function depositWei(uint256 iso,uint256 account,uint256 market,uint256 n,uint8) external {
        TokenV7Fixture(DOLOMITE_MARGIN.getMarketTokenAddress(market)).transferFrom(msg.sender,address(this),n);
        DOLOMITE_MARGIN.add(_owner(iso),account,market,n);
    }
    function withdrawWei(uint256 iso,uint256 account,uint256 market,uint256 n,uint8) external {
        DOLOMITE_MARGIN.take(_account(iso),account,market,n);
        TokenV7Fixture(DOLOMITE_MARGIN.getMarketTokenAddress(market)).transfer(msg.sender,n);
    }
}

interface VmV7Fixture {
    function prank(address who) external;
    function deal(address who,uint256 value) external;
}
contract VaultFactoryV7Fixture {
    mapping(address=>bool) public isVaultV2;
    function allow(address vault) external {isVaultV2[vault]=true;}
}
contract OmniAdapterV7CompatibilityTest {
    VmV7Fixture private constant vm=VmV7Fixture(address(uint160(uint256(keccak256('hevm cheat code')))));
    address private constant SAFE=0x47623C62f281807D615eeb4A2CEee9d97F9D3C49;
    TokenV7Fixture token;
    ParentV7Fixture parent;
    CurveYieldOmniAdapterV7 adapter;
    function setUp() public {
        token=new TokenV7Fixture();
        parent=new ParentV7Fixture(token);
        adapter=new CurveYieldOmniAdapterV7(address(parent));
        parent.setAdapter(address(adapter));
        token.mint(address(parent),1000000e18);
    }
    function data(uint8 mode,address venue,uint256 minimum,bytes memory extra) private pure returns(bytes memory){
        return abi.encode(mode,venue,bytes32(0),address(0),minimum,extra);
    }
    function setCap(uint8 mode,address venue) private {
        parent.setCap(adapter.keyOf(mode,venue,0,address(0)),type(uint256).max);
    }
    function matchCap(uint8 mode,address venue) private view {
        require(parent.allocation(adapter.keyOf(mode,venue,0,address(0)))==adapter.positionAssets(mode,venue,0,address(0)),'CAP_DELTA');
    }
    function testERC4626ValuationAndExit() public {
        ERC4626V7Fixture x=new ERC4626V7Fixture(token);setCap(1,address(x));
        parent.allocate(data(1,address(x),50e18,''),100e18);
        matchCap(1,address(x));
        parent.deallocate(data(1,address(x),60e18,''),60e18);
        matchCap(1,address(x));
        require(adapter.realAssets()==40e18);
    }
    function testYearnV2NonERC4626WithAppreciation() public {
        YearnV2Fixture x=new YearnV2Fixture(token);setCap(8,address(x));
        parent.allocate(data(8,address(x),100e18,''),100e18);
        x.harvest(100e18);
        require(adapter.realAssets()==200e18,'YEARN_REAL_ASSETS');
        parent.deallocate(data(8,address(x),80e18,abi.encode(uint256(0))),80e18);
        matchCap(8,address(x));
        require(adapter.realAssets()==120e18,'YEARN_REMAINDER');
    }
    function testCapNativeMintBurnAndCredit() public {
        CapV7Fixture x=new CapV7Fixture(token);setCap(10,address(x));
        parent.allocate(data(10,address(x),990e18,''),1000e18);
        uint256 beforeAssets=adapter.realAssets();
        require(beforeAssets<1000e18&&beforeAssets>900e18,'CAP_FEE_VALUATION');
        parent.deallocate(data(10,address(x),98e18,abi.encode(uint256(100e18))),98e18);
        matchCap(10,address(x));
    }
    function testLiquityUnderlyingOnly() public {
        LiquityV7Fixture x=new LiquityV7Fixture(token);setCap(9,address(x));
        parent.allocate(data(9,address(x),0,''),100e18);
        parent.deallocate(data(9,address(x),40e18,''),40e18);
        matchCap(9,address(x));
    }
    function testUnauthorizedExternalCallerReverts() public {
        ERC4626V7Fixture x=new ERC4626V7Fixture(token);
        try adapter.allocate(data(1,address(x),0,''),100e18,0x00000000,address(this)){
            revert('BAD_UNAUTHORIZED_ACCESS');
        }catch{}
    }

    function testBeefyV7SharesAndExit() public {
        BeefyV7Fixture x=new BeefyV7Fixture(token);setCap(2,address(x));
        parent.allocate(data(2,address(x),0,''),100e18);
        parent.deallocate(data(2,address(x),20e18,''),20e18);
        matchCap(2,address(x));
    }
    function testCompoundIIISupplyWithdraw() public {
        CompoundV7Fixture x=new CompoundV7Fixture(token);setCap(4,address(x));
        parent.allocate(data(4,address(x),0,''),100e18);
        parent.deallocate(data(4,address(x),25e18,''),25e18);
        matchCap(4,address(x));
    }
    function testAaveV3ATokenBalanceAndWithdraw() public {
        AaveV3Fixture x=new AaveV3Fixture(token);setCap(3,address(x));
        parent.allocate(data(3,address(x),0,''),100e18);
        parent.deallocate(data(3,address(x),25e18,''),25e18);
        matchCap(3,address(x));
    }
    function testAaveV4SpokeReserveAndExit() public {
        AaveV4Fixture x=new AaveV4Fixture(token);
        bytes32 market=bytes32(uint256(5));
        parent.setCap(adapter.keyOf(6,address(x),market,address(0)),type(uint256).max);
        bytes memory d=abi.encode(uint8(6),address(x),market,address(0),uint256(0),bytes(''));
        parent.allocate(d,100e18);
        parent.deallocate(d,20e18);
        require(parent.allocation(adapter.keyOf(6,address(x),market,address(0)))==
           adapter.positionAssets(6,address(x),market,address(0)),'V4_CAP_DELTA');
    }
    function testMorphoBlueShareAccounting() public {
        MorphoBlueV7Fixture x=new MorphoBlueV7Fixture(token);
        bytes32 market=x.marketId();
        parent.setCap(adapter.keyOf(5,address(x),market,address(0)),type(uint256).max);
        bytes memory extra=abi.encode(x.params());
        bytes memory d=abi.encode(uint8(5),address(x),market,address(0),uint256(0),extra);
        parent.allocate(d,100e18);
        parent.deallocate(d,25e18);
        require(parent.allocation(adapter.keyOf(5,address(x),market,address(0)))==
            adapter.positionAssets(5,address(x),market,address(0)),'MORPHO_CAP_DELTA');
    }
    function testDolomiteNormalAndIsolatedAccounts() public {
        DolomiteMarginV7Fixture margin=new DolomiteMarginV7Fixture();
        DolomiteRouterV7Fixture router=new DolomiteRouterV7Fixture(margin);
        DolomiteIsolationFactoryV7Fixture factory=new DolomiteIsolationFactoryV7Fixture();
        margin.register(3,address(token));margin.register(19,address(factory));
        bytes32 market=bytes32(uint256(3));
        parent.setCap(adapter.keyOf(7,address(router),market,address(margin)),type(uint256).max);
        bytes memory standard=abi.encode(uint8(7),address(router),market,address(margin),uint256(0),bytes(''));
        parent.allocate(standard,100e18);
        parent.deallocate(standard,30e18);
        require(parent.allocation(adapter.keyOf(7,address(router),market,address(margin)))==
            adapter.positionAssets(7,address(router),market,address(margin)),'DOLOMITE_NORMAL_DELTA');
        bytes memory extra=abi.encode(uint256(19),uint256(150),uint256(3));
        bytes32 isolatedMarketId=keccak256(extra);
        parent.setCap(adapter.keyOf(11,address(router),isolatedMarketId,address(margin)),type(uint256).max);
        bytes memory isolated=abi.encode(uint8(11),address(router),isolatedMarketId,address(margin),uint256(0),extra);
        parent.allocate(isolated,100e18);
        parent.deallocate(isolated,30e18);
        require(parent.allocation(adapter.keyOf(11,address(router),isolatedMarketId,address(margin)))==
            adapter.positionAssets(11,address(router),isolatedMarketId,address(margin)),'DOLOMITE_ISOLATED_DELTA');
    }


    function testNativeFeeDeployerCapAndOwner() public {
        VaultFactoryV7Fixture factory=new VaultFactoryV7Fixture();
        factory.allow(address(parent));
        CurveYieldOmniAdapterDeployerV7 d=new CurveYieldOmniAdapterDeployerV7(address(factory),1 ether);
        require(d.owner()==SAFE&&d.feeRecipient()==SAFE,'SAFE_OWNER_RECIPIENT');
        require(d.maximumCreationFee()==1 ether&&d.creationFee()==0,'NATIVE_FEE_CAP');
        try d.setCreationFee(1) {revert('WRONG_OWNER_ACCEPTED');}catch {}
        vm.prank(SAFE);
        try d.setCreationFee(1 ether+1){revert('FEE_OVER_CAP_ACCEPTED');}catch {}
        vm.prank(SAFE);
        d.setCreationFee(1 ether);
        vm.deal(address(this),3 ether);
        uint256 beforeSafe=SAFE.balance;
        try d.createAdapter{value:1 ether}(address(0x1234)) {revert('INVALID_VAULT_ACCEPTED');}catch {}
        try d.createAdapter(address(parent)) {revert('WRONG_FEE_ACCEPTED');}catch {}
        address created=d.createAdapter{value:1 ether}(address(parent));
        require(created.code.length!=0&&d.adapterOf(address(parent))==created,'ADAPTER_CREATED');
        require(SAFE.balance==beforeSafe+1 ether,'NATIVE_FEE_TRANSFER');
        try d.createAdapter{value:1 ether}(address(parent)) {revert('DUPLICATE_ACCEPTED');}catch {}
    }

}
