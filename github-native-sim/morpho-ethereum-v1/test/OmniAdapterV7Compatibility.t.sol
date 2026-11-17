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
contract OmniAdapterV7CompatibilityTest {
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
}
