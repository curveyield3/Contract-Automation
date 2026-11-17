// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Deliberately permissive test doubles. Untrusted pool/router functions ignore
// supplied minOut so only the REAL PoL Manager's output checks can reject losses.
interface IMockToken {
    function mint(address,uint256) external;
    function transferFrom(address,address,uint256) external returns(bool);
    function transfer(address,uint256) external returns(bool);
    function decimals() external view returns(uint8);
    function balanceOf(address) external view returns(uint256);
}
contract StressERC20V2 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    mapping(address=>uint256) public balanceOf;
    mapping(address=>mapping(address=>uint256)) public allowance;
    uint256 public totalSupply;
    constructor(string memory n,string memory s,uint8 d){name=n;symbol=s;decimals=d;}
    function mint(address a,uint256 v) external{balanceOf[a]+=v;totalSupply+=v;}
    function approve(address s,uint256 v) external returns(bool){allowance[msg.sender][s]=v;return true;}
    function transfer(address to,uint256 v) external returns(bool){
        require(balanceOf[msg.sender]>=v,"insufficient balance");
        balanceOf[msg.sender]-=v;balanceOf[to]+=v;return true;
    }
    function transferFrom(address f,address t,uint256 v) external returns(bool){
        require(balanceOf[f]>=v,"insufficient balance");
        if(msg.sender!=f){
            uint256 allowed=allowance[f][msg.sender];
            require(allowed>=v,"insufficient allowance");
            if(allowed!=type(uint256).max)allowance[f][msg.sender]=allowed-v;
        }
        balanceOf[f]-=v;balanceOf[t]+=v;return true;
    }
}

contract StressThreeCoinNGV2 {
    address[3] public tokens;
    address public immutable lpToken;
    uint256 public spotBps=10000;
    uint256 public constant N_COINS=3;
    constructor(address sdt,address cyvl,address usdc,address lp){
        tokens=[sdt,cyvl,usdc];lpToken=lp;
    }
    function coins(uint256 index) external view returns(address){return tokens[index];}
    function A() external pure returns(uint256){return 5000;}
    function get_virtual_price() external pure returns(uint256){return 1e18;}
    function price_oracle(uint256) external pure returns(uint256){return 1e18;}
    function stored_rates() external pure returns(uint256[] memory rates){
        rates=new uint256[](3);rates[0]=1e18;rates[1]=1e18;rates[2]=1e30;
    }
    function setSpotBps(uint256 bps) external {require(bps<=12000&&bps>0);spotBps=bps;}
    function add_liquidity(uint256[] calldata amounts,uint256) external returns(uint256 minted){
        require(amounts.length==3 && amounts[0]>0,"amounts");
        require(IMockToken(tokens[0]).transferFrom(msg.sender,address(this),amounts[0]),"transfer");
        minted=amounts[0]*spotBps/10000;
        IMockToken(lpToken).mint(msg.sender,minted);
    }
    function remove_liquidity_one_coin(uint256 lp,int128 index,uint256) external returns(uint256 out){
        require(index==0 && lp>0,"index");
        require(IMockToken(lpToken).transferFrom(msg.sender,address(this),lp),"transfer");
        out=lp*spotBps/10000;
        IMockToken(tokens[0]).mint(msg.sender,out);
    }
}

contract StressUniOraclePoolV2 {
    uint256 public spotBps=10000;
    function setSpotBps(uint256 bps) external {spotBps=bps;}
    function observe(uint32[] calldata secondsAgos)
        external pure returns(int56[] memory tickCumulatives,uint160[] memory secondsPerLiquidity){
        require(secondsAgos.length==2 && secondsAgos[0]==300 && secondsAgos[1]==0,"TWAP interval");
        tickCumulatives=new int56[](2);
        secondsPerLiquidity=new uint160[](2);
    }
}
contract StressUniFactoryV2 {
    address public immutable pool;
    constructor(address p){pool=p;}
    function getPool(address,address,uint24) external view returns(address){return pool;}
}

contract StressUniNFTV2 {
    struct Position {
        uint96 nonce;address operator;address token0;address token1;uint24 fee;
        int24 tickLower;int24 tickUpper;uint128 liquidity;
        uint256 feeGrowthInside0LastX128;uint256 feeGrowthInside1LastX128;
        uint128 tokensOwed0;uint128 tokensOwed1;
    }
    struct Increase {
        uint256 tokenId;uint256 amount0Desired;uint256 amount1Desired;
        uint256 amount0Min;uint256 amount1Min;uint256 deadline;
    }
    struct Decrease {
        uint256 tokenId;uint128 liquidity;uint256 amount0Min;uint256 amount1Min;uint256 deadline;
    }
    struct Collect {
        uint256 tokenId;address recipient;uint128 amount0Max;uint128 amount1Max;
    }
    uint256 public constant TOKEN_ID=7;
    address public immutable factory;
    address public nftOwner;
    Position private pos;
    uint128 public expectedLiquidity;
    uint256 public expectedWithdraw0;
    uint256 public expectedWithdraw1;
    uint256 public spotBps=10000;
    uint256 public lastDepositMin0;
    uint256 public lastDepositMin1;
    uint128 public lastWithdrawalLiquidity;
    uint256 public lastWithdrawalMin0;
    uint256 public lastWithdrawalMin1;
    constructor(address token0,address token1,address f,address holder){
        require(token0<token1,"sorted token addresses");
        factory=f;nftOwner=holder;
        pos.token0=token0;pos.token1=token1;
        pos.fee=3000;pos.tickLower=-600;pos.tickUpper=600;
        pos.liquidity=uint128(500e18);
    }
    function ownerOf(uint256 id) external view returns(address){
        require(id==TOKEN_ID,"not minted");return nftOwner;
    }
    function positions(uint256 id) external view returns(Position memory){
        require(id==TOKEN_ID,"not minted");return pos;
    }
    function safeTransferFrom(address from,address to,uint256 id) external {
        require(from==nftOwner && msg.sender==from && id==TOKEN_ID,"NFT owner");
        nftOwner=to;
        (bool ok,bytes memory data)=to.call(abi.encodeWithSignature(
            "onERC721Received(address,address,uint256,bytes)",msg.sender,from,id,bytes("")
        ));
        require(ok && data.length==32,"not ERC721 receiver");
    }
    function setSpotBps(uint256 bps) external{require(bps>0&&bps<=12000);spotBps=bps;}
    function setDepositReference(uint128 l) external{expectedLiquidity=l;}
    function setWithdrawalReference(uint256 a0,uint256 a1) external{
        expectedWithdraw0=a0;expectedWithdraw1=a1;
    }
    function increaseLiquidity(Increase calldata params)
        external returns(uint128 liquidity,uint256 amount0,uint256 amount1){
        require(params.tokenId==TOKEN_ID && nftOwner==msg.sender,"manager NFT custody");
        require(params.deadline>=block.timestamp,"deadline");
        lastDepositMin0=params.amount0Min;
        lastDepositMin1=params.amount1Min;
        // An untrusted position manager intentionally ignores the minimums.
        // The PoL Manager MUST reject insufficient returned liquidity itself.
        amount0=params.amount0Desired;amount1=params.amount1Desired;
        if(amount0!=0)require(IMockToken(pos.token0).transferFrom(msg.sender,address(this),amount0));
        if(amount1!=0)require(IMockToken(pos.token1).transferFrom(msg.sender,address(this),amount1));
        liquidity=uint128(uint256(expectedLiquidity)*spotBps/10000);
        pos.liquidity+=liquidity;
    }
    function decreaseLiquidity(Decrease calldata params)
        external returns(uint256 amount0,uint256 amount1){
        require(params.tokenId==TOKEN_ID && nftOwner==msg.sender,"manager NFT custody");
        require(params.deadline>=block.timestamp && params.liquidity<=pos.liquidity,"liquidity");
        lastWithdrawalLiquidity=params.liquidity;
        lastWithdrawalMin0=params.amount0Min;
        lastWithdrawalMin1=params.amount1Min;
        // Ignore minimums deliberately; prove the outer PoL Manager reverts.
        amount0=expectedWithdraw0*spotBps/10000;
        amount1=expectedWithdraw1*spotBps/10000;
        pos.liquidity-=params.liquidity;
        pos.tokensOwed0+=uint128(amount0);
        pos.tokensOwed1+=uint128(amount1);
    }
    function collect(Collect calldata c) external returns(uint256 a0,uint256 a1){
        require(c.tokenId==TOKEN_ID && nftOwner==msg.sender,"manager NFT custody");
        a0=uint256(pos.tokensOwed0)<c.amount0Max?pos.tokensOwed0:c.amount0Max;
        a1=uint256(pos.tokensOwed1)<c.amount1Max?pos.tokensOwed1:c.amount1Max;
        pos.tokensOwed0-=uint128(a0);
        pos.tokensOwed1-=uint128(a1);
        if(a0!=0)IMockToken(pos.token0).mint(c.recipient,a0);
        if(a1!=0)IMockToken(pos.token1).mint(c.recipient,a1);
    }
}

contract StressHistoricalRouterV2 {
    mapping(bytes32=>uint256) public spotBps;
    mapping(bytes32=>uint256) public reportedBps;
    uint256 public lastUserMin;
    address public lastRecipient;
    function key(address a,address b) public pure returns(bytes32){
        return keccak256(abi.encode(a,b));
    }
    function setSpotBps(address a,address b,uint256 bps) external{
        require(bps>0&&bps<=12000);spotBps[key(a,b)]=bps;
    }
    function setReportedBps(address a,address b,uint256 bps) external{
        require(bps>0&&bps<=12000);reportedBps[key(a,b)]=bps;
    }
    function _reference(address a,address b,uint256 amount) private view returns(uint256){
        uint8 from=IMockToken(a).decimals();
        uint8 to=IMockToken(b).decimals();
        return amount*(10**uint256(to))/(10**uint256(from));
    }
    function price_oracle(address,address) external pure returns(uint256){return 1e18;}
    function estimate_exact_output(address a,address b,uint256 amount) external view returns(uint256){
        return _reference(a,b,amount);
    }
    function swap(address a,address b,uint256 amount) external returns(uint256 received){
        return _execute(a,b,amount,msg.sender);
    }
    function swapExactInput(address a,address b,uint256 amount,uint256 userMin,address receiver,uint256 deadline)
        external returns(uint256 reported){
        require(deadline>=block.timestamp,"deadline");
        lastUserMin=userMin;
        lastRecipient=receiver;
        uint256 received=_execute(a,b,amount,receiver);
        uint256 pretend=reportedBps[key(a,b)];
        reported=pretend==0?received:_reference(a,b,amount)*pretend/10000;
        // Ignore userMin on purpose to confirm PoL Manager separately checks
        // the actual output balance delta and reported output.
    }
    function _execute(address a,address b,uint256 amount,address receiver) private returns(uint256 out){
        require(IMockToken(a).transferFrom(msg.sender,address(this),amount),"input");
        uint256 bps=spotBps[key(a,b)];
        if(bps==0)bps=10000;
        out=_reference(a,b,amount)*bps/10000;
        IMockToken(b).mint(receiver,out);
    }
}

contract Stress4626BasicV2 {
    address public immutable asset;
    uint8 public constant decimals=18;
    uint256 public totalSupply;
    mapping(address=>uint256) public balanceOf;
    constructor(address token){asset=token;}
    function convertToAssets(uint256 shares) external pure returns(uint256){return shares;}
    function convertToShares(uint256 assets) external pure returns(uint256){return assets;}
    function maxRedeem(address holder) external view returns(uint256){return balanceOf[holder];}
    function maxRedeem(address holder,uint256) external view returns(uint256){return balanceOf[holder];}
    function deposit(uint256 amount,address receiver) external returns(uint256){
        require(IMockToken(asset).transferFrom(msg.sender,address(this),amount));
        balanceOf[receiver]+=amount;totalSupply+=amount;return amount;
    }
    function redeem(uint256 shares,address receiver,address holder) public returns(uint256){
        require(holder==msg.sender&&balanceOf[holder]>=shares);
        balanceOf[holder]-=shares;totalSupply-=shares;
        require(IMockToken(asset).transfer(receiver,shares));return shares;
    }
    function redeem(uint256 shares,address receiver,address holder,uint256)
        external returns(uint256){return redeem(shares,receiver,holder);}
}
