// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

contract StressToken is ERC20 {
    uint8 private immutable _dec;
    constructor(string memory n, string memory s, uint8 d) ERC20(n,s) {_dec=d;}
    function decimals() public view override returns(uint8){return _dec;}
    function mint(address to,uint256 amount) external {_mint(to,amount);}
}
contract StressUSDC is ERC20 {
    constructor() ERC20("USDC","USDC") {}
    function decimals() public pure override returns(uint8){return 6;}
    function mint(address to,uint256 amount) external {_mint(to,amount);}
}
contract StressSDT is ERC20 {
    constructor() ERC20("SDT","SDT") {}
    function mint(address to,uint256 amount) external {_mint(to,amount);}
}
contract StressCRV {
    uint256 public rate=10e18;
    function setRate(uint256 v) external {rate=v;}
}
interface IStressBoost {
    function delegatedOut(address who) external view returns(uint256);
    function boost(address who,uint256 amount,uint256 until,address recipient) external;
    function delegableBalance(address who) external view returns(uint256);
    function isOperator(address who,address operator) external view returns(bool);
}
contract StressVLSDT is ERC20 {
    using SafeERC20 for IERC20;
    IERC20 public immutable sdt;
    address public boost;
    uint256 public nextUnstake=1;
    struct Request { address holder; uint256 value; }
    mapping(uint256=>Request) public requests;
    mapping(uint256=>uint256) public historicalSupply;
    constructor(address token) ERC20("vlSDT","vlSDT") {sdt=IERC20(token);}
    function setBoost(address b) external { boost=b; }
    function setHistoricalSupply(uint256 epoch,uint256 supply) external {historicalSupply[epoch]=supply;}
    function totalSupplyAt(uint256 epoch) external view returns(uint256) {
        uint256 s=historicalSupply[epoch]; return s==0?totalSupply():s;
    }
    function stake(uint256 amount,address recipient) external {
        sdt.safeTransferFrom(msg.sender,address(this),amount);
        _mint(recipient,amount);
    }
    function unstake(uint256 amount) external returns(uint256 id){
        require(amount+IStressBoost(boost).delegatedOut(msg.sender)<=balanceOf(msg.sender),"vlSDT still delegated");
        _burn(msg.sender,amount);
        id=nextUnstake++;
        requests[id]=Request(msg.sender,amount);
    }
    function withdraw(uint256 id,address recipient) external {
        require(requests[id].holder==msg.sender,"request owner");
        uint256 value=requests[id].value;delete requests[id];sdt.safeTransfer(recipient,value);
    }
    function withdrawEarly(uint256 id,address recipient) external {this.withdraw(id,recipient);}
}
contract StressVlBoost {
    struct Entry {address delegator;address recipient;uint256 amount;uint256 expiry;}
    Entry[] public entries;
    address public immutable vlsdt;
    mapping(address=>mapping(address=>bool)) public operators;
    bool public failBoost;
    constructor(address v){vlsdt=v;}
    function setFailBoost(bool f) external {failBoost=f;}
    function setOperator(address operator,bool allowed) external {operators[msg.sender][operator]=allowed;}
    function isOperator(address who,address operator) external view returns(bool){return operators[who][operator];}
    function delegatedOut(address who) public view returns(uint256 used){
        for(uint256 i;i<entries.length;i++){Entry memory e=entries[i];if(e.delegator==who && e.expiry>block.timestamp) used+=e.amount;}
    }
    function delegableBalance(address who) public view returns(uint256){
        uint256 bal=IERC20(vlsdt).balanceOf(who);uint256 d=delegatedOut(who);return bal>d?bal-d:0;
    }
    function boost(address who,uint256 amount,uint256 end,address recipient) external {
        require(!failBoost,"forced-boost-failure");
        require(msg.sender==who || operators[who][msg.sender],"operator");
        require(recipient!=who && recipient!=address(0),"recipient");
        uint256 expiry=end/(7 days)*(7 days);
        require(expiry>block.timestamp,"expired");
        require(amount>0 && amount<=delegableBalance(who),"free boost");
        entries.push(Entry(who,recipient,amount,expiry));
    }
    function entryCount() external view returns(uint256){return entries.length;}
}
contract StressDistributor {
    address public immutable REWARD_TOKEN;
    uint256 public lastTokenTime;
    mapping(uint256=>uint256) public tokensPerEpoch;
    constructor(address t){REWARD_TOKEN=t;}
    function setEpoch(uint256 epoch,uint256 reward,uint256 checkpoint) external {
        tokensPerEpoch[epoch]=reward;lastTokenTime=checkpoint;
    }
    function claim(address,address) external pure returns(uint256){return 0;}
}
contract StressStakeDaoRouter {
    function execute(bytes[] calldata calls) external pure returns(bytes[] memory out){out=new bytes[](calls.length);}
}
contract StressAladdin {
    uint256 public constant WEEK=7 days;
    struct RewardData {uint128 balance;uint128 timestamp;}
    RewardData public lastSDTReward;
    mapping(uint256=>uint256) public weeklyRewards;
    mapping(address=>mapping(uint256=>uint256)) public historyBoosts;
    IStressBoost public registry;
    bool public failClaim;
    bool public failBoost;
    function setRegistry(address b) external{registry=IStressBoost(b);}
    function setHistory(uint256 epoch,uint256 r,uint256 power,uint256 checkpoint) external {
        weeklyRewards[epoch]=r;historyBoosts[address(0)][epoch]=power;
        lastSDTReward=RewardData(0,uint128(checkpoint));
    }
    function setFailClaim(bool v) external {failClaim=v;}
    function setFailBoost(bool v) external {failBoost=v;}
    function boost(uint256 amount,uint256 end,address) external {
        require(!failBoost,"aladdin failure");
        registry.boost(msg.sender,amount,end,address(0x12345));
    }
    function claim(address,address) external view returns(uint256){
        require(!failClaim,"aladdin claim failure");return 0;
    }
}
contract StressMarketplace {
    using SafeERC20 for IERC20;
    uint256 public feeBps;
    address public immutable boost;
    uint256 public nextID=1;
    address public feeReceiver;
    struct SellListing {
        address seller;uint96 pricePerWeek;address paymentToken;uint32 maxDuration;uint64 expiry;
        uint128 amount;uint128 filled;uint32 minDuration;
    }
    struct BuyOffer {
        address buyer;uint96 pricePerWeek;address paymentToken;uint32 duration;uint64 expiry;
        address recipient;uint128 amount;uint128 filled;
    }
    mapping(uint256=>SellListing) public listings;
    mapping(uint256=>BuyOffer) private offers;
    mapping(address=>uint256) public committedBalance;
    bool public failSettle;
    constructor(address b,address feeTo){boost=b;feeReceiver=feeTo;}
    function setFee(uint256 f) external {feeBps=f;}
    function setFail(bool v) external {failSettle=v;}
    function getOffer(uint256 id) external view returns(BuyOffer memory){return offers[id];}
    function getListing(uint256 id) external view returns(SellListing memory){return listings[id];}
    function createOffer(uint128 amount,uint96 pricePerWeek,uint32 duration,address token,uint64 expiry,address recipient) external returns(uint256 id){
        require(expiry>block.timestamp,"expiry");id=nextID++;
        offers[id]=BuyOffer(msg.sender,pricePerWeek,token,duration,expiry,recipient,amount,0);
    }
    function createListing(uint256 amount,uint256 pricePerWeek,uint256 minDuration,uint256 maxDuration,address token,uint256 expiry) external returns(uint256 id){
        require(IStressBoost(boost).isOperator(msg.sender,address(this)),"market operator");
        require(amount<=IStressBoost(boost).delegableBalance(msg.sender)-committedBalance[msg.sender],"listing capacity");
        id=nextID++;
        listings[id]=SellListing(msg.sender,uint96(pricePerWeek),token,uint32(maxDuration),uint64(expiry),uint128(amount),0,uint32(minDuration));
        committedBalance[msg.sender]+=amount;
    }
    function updateListing(uint256 id,uint256 amount,uint256 price) external {
        SellListing storage l=listings[id];require(l.seller==msg.sender,"seller");
        require(amount>=l.filled,"filled");
        uint256 old=l.amount-l.filled;
        require(amount-l.filled<=IStressBoost(boost).delegableBalance(msg.sender)-committedBalance[msg.sender]+old,"capacity");
        committedBalance[msg.sender]=committedBalance[msg.sender]-old+(amount-l.filled);
        l.amount=uint128(amount);l.pricePerWeek=uint96(price);
    }
    function cancelListing(uint256 id) external{
        SellListing storage l=listings[id];require(l.seller==msg.sender,"seller");
        committedBalance[msg.sender]-=l.amount-l.filled;delete listings[id];
    }
    function acceptOffer(uint256 id,uint256 amount,uint256 minTotal,uint256 maxDuration) external {
        require(!failSettle,"market failed");
        BuyOffer storage o=offers[id];
        require(o.buyer!=address(0) && o.expiry>block.timestamp,"offer expired");
        require(amount>0 && uint256(o.filled)+amount<=o.amount,"fill");
        uint256 end=((block.timestamp+o.duration*7 days+7 days-1)/(7 days))*(7 days);
        require(maxDuration==0 || end-block.timestamp<=maxDuration,"duration");
        uint256 price=amount*o.pricePerWeek*(end-block.timestamp)/(7 days)/1e18;
        require(price>=minTotal,"slippage");
        uint256 fee=price*feeBps/10000;
        IERC20(o.paymentToken).safeTransferFrom(o.buyer,msg.sender,price-fee);
        if(fee!=0) IERC20(o.paymentToken).safeTransferFrom(o.buyer,feeReceiver,fee);
        IStressBoost(boost).boost(msg.sender,amount,end,o.recipient);
        o.filled+=uint128(amount);
    }
    function fillListing(uint256 id,uint256 amount,uint256 duration,address recipient) external {
        SellListing storage l=listings[id];
        require(l.seller!=address(0) && (l.expiry==0||l.expiry>block.timestamp),"expired listing");
        require(duration>=l.minDuration && duration<=l.maxDuration && amount>0 && amount<=l.amount-l.filled,"terms");
        uint256 end=((block.timestamp+duration*7 days+7 days-1)/(7 days))*(7 days);
        require(end-block.timestamp<=l.maxDuration*7 days,"effective duration");
        uint256 price=amount*l.pricePerWeek*(end-block.timestamp)/(7 days)/1e18;
        uint256 fee=price*feeBps/10000;
        IERC20(l.paymentToken).safeTransferFrom(msg.sender,l.seller,price-fee);
        if(fee!=0)IERC20(l.paymentToken).safeTransferFrom(msg.sender,feeReceiver,fee);
        IStressBoost(boost).boost(l.seller,amount,end,recipient);
        l.filled+=uint128(amount);committedBalance[l.seller]-=amount;
    }
}
contract StressOmniRouter {
    using SafeERC20 for IERC20;
    mapping(bytes32=>uint256) public rates;
    bool public failSwap;
    function key(address a,address b) internal pure returns(bytes32){return keccak256(abi.encode(a,b));}
    function setRate(address a,address b,uint256 outPerRawInScaled1e18) external {rates[key(a,b)]=outPerRawInScaled1e18;}
    function setFail(bool v) external {failSwap=v;}
    function swap(address a,address b,uint256 amount) external returns(uint256 output){
        require(!failSwap,"router fail");
        uint256 rate=rates[key(a,b)];
        require(rate>0,"no route");
        output=amount*rate/1e18;
        require(output>0,"zero output");
        IERC20(a).safeTransferFrom(msg.sender,address(this),amount);
        IERC20(b).safeTransfer(msg.sender,output);
    }
    function routeLength(address a,address b) external view returns(uint256){return rates[key(a,b)]>0?1:0;}
    function price_oracle(address a,address b) external view returns(uint256){return rates[key(a,b)];}
    function guardedMinOut(address a,address b,uint256 amount) external view returns(uint256){return amount*rates[key(a,b)]/1e18;}
    function swapExactInput(address a,address b,uint256 amount,uint256 min,address recipient,uint256 deadline) external returns(uint256 output){
        require(!failSwap && deadline>=block.timestamp,"router fail");
        uint256 rate=rates[key(a,b)];require(rate>0,"no route");
        output=amount*rate/1e18;require(output>=min && output>0,"min out");
        IERC20(a).safeTransferFrom(msg.sender,address(this),amount);
        StressUSDC(b).mint(recipient,output);
    }
}
contract StressGaugeController {
    int128 public gaugeType=0;
    uint256 public relativeWeight=1e18;
    uint256 public bias=100e18;
    function setWeights(uint256 w,uint256 b) external {relativeWeight=w;bias=b;}
    function gauge_types(address) external view returns(int128){return gaugeType;}
    function gauge_relative_weight(address,uint256) external view returns(uint256){return relativeWeight;}
    function gauge_relative_weight_write(address,uint256) external view returns(uint256){return relativeWeight;}
    function points_weight(address,uint256) external view returns(uint256,uint256){return(bias,0);}
}
contract StressVoteMarket {
    using SafeERC20 for IERC20;
    struct Bounty {
        address gauge;address manager;address rewardToken;uint8 numberOfPeriods;
        uint256 endTimestamp;uint256 maxRewardPerVote;uint256 totalRewardAmount;address[] blacklist;
    }
    address public gaugeController;
    uint256 public nextId=1;
    mapping(uint256=>Bounty) private bounties;
    mapping(uint256=>uint256) public claimed;
    bool public failCreate;
    constructor(address g){gaugeController=g;}
    function setFailCreate(bool v) external{failCreate=v;}
    function getCurrentPeriod() public view returns(uint256){return block.timestamp/(7 days)*(7 days);}
    function getPeriodsLeft(uint256 id) external view returns(uint256){
        uint256 end=bounties[id].endTimestamp;uint256 nowWeek=getCurrentPeriod();
        return end>nowWeek?(end-nowWeek)/(7 days):0;
    }
    function getBounty(uint256 id) external view returns(Bounty memory){return bounties[id];}
    function createBounty(address gauge,address manager,address token,uint8 periods,uint256 maxPrice,uint256 reward,address[] calldata blacklist,bool) external returns(uint256 id){
        require(!failCreate,"market fail");
        id=nextId++;
        IERC20(token).safeTransferFrom(msg.sender,address(this),reward);
        bounties[id]=Bounty(gauge,manager,token,periods,getCurrentPeriod()+(uint256(periods)+1)*7 days,maxPrice,reward,blacklist);
    }
    function increaseBountyDuration(uint256 id,uint8 periods,uint256 reward,uint256 maxPrice) external {
        Bounty storage b=bounties[id];require(b.manager==msg.sender,"manager");
        IERC20(b.rewardToken).safeTransferFrom(msg.sender,address(this),reward);
        b.numberOfPeriods+=periods;b.totalRewardAmount+=reward;b.endTimestamp+=uint256(periods)*7 days;b.maxRewardPerVote=maxPrice;
    }
    function updateBountyPeriod(uint256) external {}
    function claimSimulated(uint256 id,address recipient,uint256 amount) external {
        Bounty storage b=bounties[id];
        require(amount+claimed[id]<=b.totalRewardAmount,"overclaim");
        claimed[id]+=amount;IERC20(b.rewardToken).safeTransfer(recipient,amount);
    }
    function closeBounty(uint256 id) external{
        Bounty storage b=bounties[id];
        require(b.manager!=address(0),"closed");
        require(getCurrentPeriod()>=b.endTimestamp,"not expired");
        address manager=b.manager;b.manager=address(0);
        IERC20(b.rewardToken).safeTransfer(manager,b.totalRewardAmount-claimed[id]);
    }
}

contract Stress4626 is ERC4626 {
    uint256 public totalBorrows;
    bool public failRedeem;
    constructor(IERC20 token) ERC20("Stress Vault Shares","svShares") ERC4626(token) {}
    function setBorrowed(uint256 amount) external {totalBorrows=amount;}
    function setFailRedeem(bool value) external {failRedeem=value;}
    function cash() external view returns(uint256) {return IERC20(asset()).balanceOf(address(this));}
    function redeem(uint256 shares,address receiver,address owner,uint256) external returns(uint256) {
        return redeem(shares,receiver,owner);
    }
    function redeem(uint256 shares,address receiver,address owner)
        public override returns(uint256 assets) {
        require(!failRedeem,"forced vault redeem fail");
        return super.redeem(shares,receiver,owner);
    }
    function maxRedeem(address who,uint256) external view returns(uint256){return maxRedeem(who);}
}
contract StressCurvePrice {
    address[3] public coinsList;
    uint256 public price=95e16;
    constructor(address c0,address c1,address c2){coinsList=[c0,c1,c2];}
    function coins(uint256 i) external view returns(address){return coinsList[i];}
    function price_oracle(uint256) external view returns(uint256){return price;}
    function setPrice(uint256 p) external {price=p;}
}
contract StressVaultStrategy {
    using SafeERC20 for IERC20;
    address public immutable want;
    address public immutable vault;
    bool public failStrict;
    bool public failInstant;
    uint256 public estimated;
    uint256 public nextRequest=1;
    struct Req {uint256 assets;uint256 unlock;bool closed;}
    mapping(uint256=>Req) public requests;
    constructor(address v,address a){vault=v;want=a;}
    modifier onlyVault(){require(msg.sender==vault,"only vault");_;}
    function setEstimated(uint256 amount) external {estimated=amount;}
    function setFailStrict(bool v) external {failStrict=v;}
    function setFailInstant(bool v) external {failInstant=v;}
    function balanceOf() external view returns(uint256){return IERC20(want).balanceOf(address(this));}
    function estimatedUnharvestedWant() external view returns(uint256){return estimated;}
    function estimatedTokenAprBps() external pure returns(uint256){return 0;}
    function beforeDeposit() external view onlyVault {}
    function beforeDepositStrict() external view onlyVault {require(!failStrict,"forced strict harvest failure");}
    function beforeWithdraw() external view onlyVault {}
    function beforeWithdrawStrict() external view onlyVault {require(!failStrict,"forced strict harvest failure");}
    function deposit() external onlyVault {}
    function withdrawInstant(uint256 amount) external onlyVault returns(uint256 received){
        require(!failInstant,"forced instant withdraw failure");
        uint256 bal=IERC20(want).balanceOf(address(this));
        received=amount<bal?amount:bal;
        IERC20(want).safeTransfer(vault,received);
    }
    function requestWithdrawal(uint256 amount) external onlyVault returns(uint256 id,uint256 unlock){
        require(amount<=IERC20(want).balanceOf(address(this)),"not funded");
        id=nextRequest++;unlock=block.timestamp+7 days;
        requests[id]=Req(amount,unlock,false);
    }
    function completeWithdrawal(uint256 id) external onlyVault returns(uint256 received){
        Req storage r=requests[id];
        require(!r.closed && r.assets>0 && block.timestamp>=r.unlock,"request not ready");
        r.closed=true;received=r.assets;
        IERC20(want).safeTransfer(vault,received);
    }
    function withdrawPendingInstant(uint256 id) external onlyVault returns(uint256 received){
        Req storage r=requests[id];
        require(!r.closed && r.assets>0,"request already closed");
        r.closed=true;received=r.assets;
        IERC20(want).safeTransfer(vault,received);
    }
}
