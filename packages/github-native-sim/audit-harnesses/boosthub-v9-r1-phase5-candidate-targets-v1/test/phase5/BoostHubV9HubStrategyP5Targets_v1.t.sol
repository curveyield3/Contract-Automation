// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
// Audit-only; original imported BoostHub and Beefy strategy are unchanged.
import {BoostHub} from "../../contracts/BoostHub.sol";
import {BaseAllToWantBoostHubV5} from "../../beefy/contracts/beefy/BaseAllToWantBoostHubV5.sol";
import {StrategyConvexBoostHubStakingV5} from "../../beefy/contracts/beefy/StrategyConvexBoostHubStakingV5.sol";
import "./BoostHubV9VyperP5Targets_v1.t.sol";
interface VmHubV9 {
    function prank(address who) external;
    function expectRevert() external;
}
contract BoostV9DummyDistributorV1 {}
contract BoostV9GaugeP5V1 {
    BoostV9BehaviorTokenV1 immutable token;
    BoostV9BehaviorTokenV1 immutable reward;
    mapping(address=>uint256) public balanceOf;
    uint256 public totalSupply;
    uint256 public pending;
    bool public dropOnFinalWithdraw;
    constructor(address lp,address rewardToken) {
        token=BoostV9BehaviorTokenV1(lp);
        reward=BoostV9BehaviorTokenV1(rewardToken);
    }
    function staking_token() external view returns(address) {return address(token);}
    function reward_tokens(uint256 n) external view returns(address) {return n==0?address(reward):address(0);}
    function setDropOnFinalWithdraw(bool enabled) external {dropOnFinalWithdraw=enabled;}
    function accrue(uint256 amount) external {reward.mint(address(this),amount);pending+=amount;}
    function claimable_reward(address,address token_) external view returns(uint256){
        return token_==address(reward)?pending:0;
    }
    function deposit(uint256 amount,address receiver) external {
        require(token.transferFrom(msg.sender,address(this),amount),"GAUGE_DEPOSIT");
        balanceOf[receiver]+=amount;totalSupply+=amount;
    }
    function withdraw(uint256 amount,bool) external {
        balanceOf[msg.sender]-=amount;totalSupply-=amount;
        require(token.transfer(msg.sender,amount),"GAUGE_WITHDRAW");
        if(dropOnFinalWithdraw&&totalSupply==0)pending=0;
    }
    function claim_rewards(address user,address receiver) external {
        require(user==msg.sender,"CLAIM_USER");
        uint256 amount=pending;pending=0;
        if(amount>0)require(reward.transfer(receiver,amount),"REWARD_TRANSFER");
    }
}
contract BoostV9StakingCallbackV1 {
    BoostV9BehaviorTokenV1 public immutable want;
    address public strategy;
    mapping(address=>uint256) public balanceOf;
    bool public reenter;
    bool private entered;
    uint256 public claimCalls;
    uint256 public rewardEach;
    constructor(address token) {want=BoostV9BehaviorTokenV1(token);}
    function lp_token() external view returns(address) {return address(want);}
    function reward_count() external pure returns(uint256) {return 1;}
    function reward_tokens(uint256 index) external view returns(address) {return index==0?address(want):address(0);}
    function reward_disabled(address) external pure returns(bool) {return false;}
    function setStrategy(address s) external {require(strategy==address(0),"BOUND");strategy=s;}
    function configure(uint256 gross,bool nested) external {
        require(strategy!=address(0),"UNBOUND");
        rewardEach=gross;reenter=nested;entered=false;claimCalls=0;
    }
    function deposit(uint256 amount,address beneficiary) external {
        require(beneficiary==msg.sender,"BENEFICIARY");
        require(want.transferFrom(msg.sender,address(this),amount),"STAKE_TRANSFER");
        balanceOf[beneficiary]+=amount;
    }
    function withdraw(uint256 amount) external {
        balanceOf[msg.sender]-=amount;
        require(want.transfer(msg.sender,amount),"STAKE_EXIT");
    }
    function harvest() external {}
    function claim_rewards() external {
        claimCalls++;
        if(reenter&&!entered){
            entered=true;
            StrategyConvexBoostHubStakingV5(strategy).harvest(address(0xA11CE));
        }
        want.mint(msg.sender,rewardEach);
    }
}
contract BoostHubV9HubStrategyP5TargetsV1 {
    VmHubV9 constant vm=VmHubV9(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant OUTSIDER=address(0xBAD001);
    function _hubFixture() internal returns(
        BoostHub hub, BoostV9GaugeP5V1 gauge,
        BoostV9BehaviorTokenV1 lp, BoostV9BehaviorTokenV1 reward
    ){
        lp=new BoostV9BehaviorTokenV1();
        reward=new BoostV9BehaviorTokenV1();
        gauge=new BoostV9GaugeP5V1(address(lp),address(reward));
        BoostV9DummyDistributorV1 distributor=new BoostV9DummyDistributorV1();
        hub=new BoostHub(address(this),address(0),address(distributor));
        address[] memory a=new address[](1);a[0]=address(lp);
        address[] memory g=new address[](1);g[0]=address(gauge);
        address[][] memory t=new address[][](1);t[0]=new address[](1);t[0][0]=address(reward);
        hub.addPoolsBatch(a,g,t);
        uint256[] memory ids=new uint256[](1);ids[0]=0;
        address[] memory depositors=new address[](1);depositors[0]=address(this);
        bool[] memory locks=new bool[](1);locks[0]=true;
        bytes4[] memory selectors=new bytes4[](1);
        BoostHub.FeeConfig[] memory fees=new BoostHub.FeeConfig[](1);
        fees[0]=BoostHub.FeeConfig({platformFeeBps:0,platformFeeRecipient:address(0)});
        bool[] memory active=new bool[](1);active[0]=true;
        hub.setDepositors(ids,depositors,locks,selectors,fees,active);
        hub.executeTransactions(); // Queue must be applied before reward harvest.
    }
    function _stakeHub(BoostHub hub,BoostV9BehaviorTokenV1 lp,uint256 amount) internal {
        lp.mint(address(this),amount);
        lp.approve(address(hub),amount);
        hub.deposit(0,amount);
    }
    function testFuzz_P5T005_ActualHubLastWithdrawUnharvestedGauge(uint96 raw) public {
        (BoostHub hub,BoostV9GaugeP5V1 gauge,BoostV9BehaviorTokenV1 lp,BoostV9BehaviorTokenV1 reward)=_hubFixture();
        uint256 principal=uint256(raw)%1e21+1e12;
        _stakeHub(hub,lp,principal);
        uint256 accrued=principal/3;
        gauge.accrue(accrued);
        gauge.setDropOnFinalWithdraw(true);
        require(gauge.claimable_reward(address(hub),address(reward))==accrued,"GAUGE_SETUP");
        hub.withdraw(0,principal);
        require(gauge.pending()==0,"GAUGE_RETAINED_HARVEST");
        require(reward.balanceOf(address(hub))==0,"HUB_UNEXPECTED_HARVEST");
        (address[] memory t,uint256[] memory amounts)=hub.harvest(0);
        require(t.length==1&&amounts[0]==0,"ZERO_STAKE_HARVEST_DID_NOT_SKIP");
        require(reward.balanceOf(address(hub))==0,"UNEXPECTED_REWARD_RECOVERY");
        require(lp.balanceOf(address(this))==principal,"PRINCIPAL_EXIT_FAILED");
    }
    function testFuzz_P5T005_ControlHarvestBeforeFinalWithdraw(uint96 raw) public {
        (BoostHub hub,BoostV9GaugeP5V1 gauge,BoostV9BehaviorTokenV1 lp,BoostV9BehaviorTokenV1 reward)=_hubFixture();
        uint256 principal=uint256(raw)%1e21+1e12;
        _stakeHub(hub,lp,principal);
        uint256 accrued=principal/3;
        gauge.accrue(accrued);
        gauge.setDropOnFinalWithdraw(true);
        (,uint256[] memory amounts)=hub.harvest(0);
        require(amounts.length==1&&amounts[0]==accrued,"CONTROL_HARVEST_NOT_REALIZED");
        hub.withdraw(0,principal);
        require(reward.balanceOf(address(hub))==accrued,"CONTROL_REWARD_NOT_BACKED");
    }
    function testFuzz_P5T005_RecoveryIfGaugePersistsClaim(uint96 raw) public {
        (BoostHub hub,BoostV9GaugeP5V1 gauge,BoostV9BehaviorTokenV1 lp,BoostV9BehaviorTokenV1 reward)=_hubFixture();
        uint256 principal=uint256(raw)%1e21+1e12;
        _stakeHub(hub,lp,principal);
        uint256 accrued=principal/3;
        gauge.accrue(accrued);
        gauge.setDropOnFinalWithdraw(false);
        hub.withdraw(0,principal);
        require(gauge.pending()==accrued,"GAUGE_DID_NOT_RETAIN");
        hub.harvest(0);
        require(gauge.pending()==accrued,"ZERO_SUPPLY_HARVEST_CHANGED_GAUGE");
        lp.approve(address(hub),principal);
        hub.deposit(0,principal);
        // On re-deposit, _harvest is invoked while totalStaked is zero; a later
        // harvest can collect the surviving gauge reward.
        hub.harvest(0);
        require(reward.balanceOf(address(hub))==accrued,"RECOVERY_UNAVAILABLE");
    }
    function test_P5T006_ActualHubDepositorAndOwnerGuards() public {
        (BoostHub hub,,BoostV9BehaviorTokenV1 lp,)=_hubFixture();
        lp.mint(OUTSIDER,1e18);
        vm.prank(OUTSIDER);lp.approve(address(hub),1e18);
        vm.expectRevert();
        vm.prank(OUTSIDER);hub.deposit(0,1e18);
        vm.expectRevert();
        vm.prank(OUTSIDER);hub.addPoolsBatch(new address[](0),new address[](0),new address[][](0));
        _stakeHub(hub,lp,1e18);
        vm.expectRevert();
        vm.prank(OUTSIDER);hub.withdraw(0,1e18);
        require(hub.poolDepositor(0)==address(this),"DEPOSITOR_AUTH_BROKEN");
    }
    function _strategyFixture() internal returns(
        StrategyConvexBoostHubStakingV5 strategy,
        BoostV9StakingCallbackV1 staking,BoostV9BehaviorTokenV1 want
    ) {
        want=new BoostV9BehaviorTokenV1();
        staking=new BoostV9StakingCallbackV1(address(want));
        BaseAllToWantBoostHubV5.Addresses memory addresses_=BaseAllToWantBoostHubV5.Addresses({
            want:address(want),vault:address(this),swapper:address(0x7007),adminFeeReceiver:address(0xA11C0)
        });
        BaseAllToWantBoostHubV5.FeeSettings memory fees=BaseAllToWantBoostHubV5.FeeSettings({
            totalPerformanceFeeBps:1000,callShareBps:10000,adminShareBps:0
        });
        strategy=new StrategyConvexBoostHubStakingV5(address(staking),addresses_,fees,1 days,0);
        staking.setStrategy(address(strategy));
    }
    function testFuzz_P5T004_ActualStrategyNestedClaimAccounting(uint96 raw) public {
        (StrategyConvexBoostHubStakingV5 strategy,BoostV9StakingCallbackV1 staking,BoostV9BehaviorTokenV1 want)=_strategyFixture();
        uint256 amount=uint256(raw)%1e21+1e15;
        staking.configure(amount,true);
        strategy.harvest(address(this));
        require(staking.claimCalls()==2,"NESTED_HARVEST_NOT_REACHED");
        uint256 expectedFee=2*(amount*1000/10000);
        uint256 paid=want.balanceOf(address(this))+want.balanceOf(address(0xA11CE));
        require(paid==expectedFee,"FEE_DIVERTED_OR_DOUBLE_CHARGED");
        require(staking.balanceOf(address(strategy))+paid==2*amount,"WANT_VALUE_NOT_CONSERVED");
        require(strategy.totalLocked()<=2*amount-expectedFee,"PROFIT_LOCK_EXCEEDS_NET_YIELD");
    }
    function testFuzz_P5T004_ControlSingleHarvestAndNoCallback(uint96 raw) public {
        (StrategyConvexBoostHubStakingV5 strategy,BoostV9StakingCallbackV1 staking,BoostV9BehaviorTokenV1 want)=_strategyFixture();
        uint256 amount=uint256(raw)%1e21+1e15;
        staking.configure(amount,false);
        strategy.harvest(address(this));
        require(staking.claimCalls()==1,"CONTROL_NONRECURSIVE");
        uint256 fee=amount*1000/10000;
        require(want.balanceOf(address(this))==fee,"CONTROL_FEE");
        require(staking.balanceOf(address(strategy))+fee==amount,"CONTROL_ASSET");
    }
}
