// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Audit-only exact-source test fixture. The Vyper creation bytecode is pinned to
// PHASE0_EXECUTION_BUILD_ARTIFACTS_v2.json's BoostHubStaking.vy artifact, not a
// Solidity port of its vulnerable logic. No production source is modified.
interface VmBoostV9 {
    function readFile(string calldata path) external view returns (string memory);
    function parseBytes(string calldata value) external pure returns (bytes memory);
    function prank(address caller) external;
    function startPrank(address caller) external;
    function stopPrank() external;
    function warp(uint256 time) external;
    function expectRevert() external;
}
interface IBoostVyperV22 {
    function deposit(uint256,address) external;
    function withdraw(uint256) external;
    function claim_reward(address) external;
    function claim_rewards() external;
    function checkpoint(address) external;
    function checkpoint_ramp(uint256) external returns (bool);
    function add_external_reward(address) external;
    function deposit_reward_token(address,uint256) external;
    function balanceOf(address) external view returns (uint256);
    function staked_balance(address) external view returns(uint256);
    function claimable_reward(address,address) external view returns(uint256);
    function reward_count() external view returns(uint256);
}
contract BoostV9BehaviorTokenV1 {
    mapping(address=>uint256) public balanceOf;
    mapping(address=>mapping(address=>uint256)) public allowance;
    address public falseSender;
    address public revertSender;
    bool public falseReturn;
    bool public revertReturn;
    function mint(address to,uint256 n) external {balanceOf[to]+=n;}
    function setBehavior(address sender,bool falseResult,bool throwResult) external {
        falseSender=sender; revertSender=sender; falseReturn=falseResult; revertReturn=throwResult;
    }
    function approve(address to,uint256 n) external returns(bool) {allowance[msg.sender][to]=n; return true;}
    function transfer(address to,uint256 n) external returns(bool) {
        if(revertReturn&&msg.sender==revertSender) revert("TOKEN_TRANSFER_REVERT");
        if(falseReturn&&msg.sender==falseSender) return false;
        require(balanceOf[msg.sender]>=n,"TOKEN_BAL");
        balanceOf[msg.sender]-=n; balanceOf[to]+=n; return true;
    }
    function transferFrom(address from,address to,uint256 n) external returns(bool) {
        require(balanceOf[from]>=n,"TOKEN_BAL");
        require(allowance[from][msg.sender]>=n,"TOKEN_ALLOW");
        allowance[from][msg.sender]-=n;
        balanceOf[from]-=n; balanceOf[to]+=n; return true;
    }
}
contract BoostV9VyperHubStubV1 {
    struct PoolView {
        address asset; address gauge; bool active; uint256 totalStaked;
        address[] rewardTokens; address depositor; bool depositorLocked;
        bytes4 checkpointSelector; uint16 platformFeeBps;
        address platformFeeRecipient; bool feeConfigSet;
        uint256[] accRewardPerShare;
    }
    BoostV9BehaviorTokenV1 public immutable lp;
    address public staking;
    address[] private configuredRewards;
    mapping(address=>uint256) public principal;
    uint256 public totalStaked;
    constructor(address token) {lp=BoostV9BehaviorTokenV1(token);}
    function setStaking(address newStaking) external {require(staking==address(0),"STAKING_SET");staking=newStaking;}
    function setRewards(address[] memory values) external {
        require(values.length<=8,"REWARDS_BOUND");
        delete configuredRewards;
        for(uint256 i;i<values.length;i++)configuredRewards.push(values[i]);
    }
    function poolInfo(uint256 pid) external view returns(PoolView memory v) {
        require(pid==0,"PID");
        v.asset=address(lp);v.gauge=address(this);v.active=true;v.totalStaked=totalStaked;
        v.rewardTokens=configuredRewards;v.depositor=staking;
        v.checkpointSelector=bytes4(0);v.platformFeeBps=0;v.platformFeeRecipient=address(this);
        v.feeConfigSet=true;v.accRewardPerShare=new uint256[](configuredRewards.length);
    }
    function deposit(uint256 pid,uint256 amount) external {
        require(pid==0&&msg.sender==staking,"DEPOSITOR");
        require(lp.transferFrom(msg.sender,address(this),amount),"FUND");
        principal[msg.sender]+=amount;totalStaked+=amount;
    }
    function withdraw(uint256 pid,uint256 amount) external {
        require(pid==0&&principal[msg.sender]>=amount,"PRINCIPAL");
        principal[msg.sender]-=amount;totalStaked-=amount;
        require(lp.transfer(msg.sender,amount),"HUB_PAYOUT");
    }
    function harvest(uint256) external pure {}
    function claim(uint256,address[] calldata,address) external pure returns(address[] memory,uint256[] memory){
        return(new address[](0),new uint256[](0));
    }
}
contract BoostHubV9VyperP5TargetsV1 {
    VmBoostV9 constant vm=VmBoostV9(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant USER=address(0xBEE1);
    // This relative location is installed by the existing audit-harness manifest.
    string constant VYPER_BYTECODE="test/phase5/BoostHubStaking_v22.creation.hex";
    function _staking(BoostV9BehaviorTokenV1 lp,BoostV9VyperHubStubV1 hub,address[8] memory configured)
        internal returns(IBoostVyperV22 staking) {
        bytes memory sourceCode=vm.parseBytes(vm.readFile(VYPER_BYTECODE));
        bytes memory init=bytes.concat(sourceCode,abi.encode(
            address(lp),address(hub),uint256(0),address(this),configured,
            address(this),uint256(0),address(this)
        ));
        address deployed;
        assembly {deployed:=create(0,add(init,32),mload(init))}
        require(deployed!=address(0),"EXACT_VYPER_DEPLOY_FAILED");
        staking=IBoostVyperV22(deployed);
        hub.setStaking(deployed);
    }
    function _base() internal returns(BoostV9BehaviorTokenV1 lp,BoostV9VyperHubStubV1 hub,IBoostVyperV22 staking){
        lp=new BoostV9BehaviorTokenV1();
        hub=new BoostV9VyperHubStubV1(address(lp));
        address[8] memory noRewards;
        staking=_staking(lp,hub,noRewards);
    }
    function _stake(BoostV9BehaviorTokenV1 lp,IBoostVyperV22 staking,uint256 amount) internal {
        lp.mint(USER,amount);
        vm.startPrank(USER);
        lp.approve(address(staking),amount);
        staking.deposit(amount,USER);
        vm.stopPrank();
        require(staking.staked_balance(USER)==amount,"EXACT_STAKE_NOT_RECORDED");
    }
    function _mature(IBoostVyperV22 staking) internal {
        vm.warp(block.timestamp+46 days);
        bool current;
        for(uint256 i;i<20;i++){
            current=staking.checkpoint_ramp(16);
            if(current)break;
        }
        require(current,"RAMP_CATCHUP_NOT_COMPLETE");
    }
    function _rewardFixture(uint96 amount) internal returns(
        BoostV9BehaviorTokenV1 reward,IBoostVyperV22 staking,uint256 eligible
    ){
        (BoostV9BehaviorTokenV1 lp,,IBoostVyperV22 st)=_base();
        staking=st;
        _stake(lp,staking,1e18);
        _mature(staking);
        reward=new BoostV9BehaviorTokenV1();
        staking.add_external_reward(address(reward));
        uint256 funded=uint256(amount)%1e21+1e12;
        reward.mint(address(this),funded);
        reward.approve(address(staking),funded);
        staking.deposit_reward_token(address(reward),funded);
        vm.prank(USER);staking.checkpoint(USER);
        eligible=staking.claimable_reward(USER,address(reward));
        require(eligible>0,"REWARD_NOT_ACCRUED");
    }
    function testFuzz_P5T001_ActualVyperRewardClaimFalseReturn(uint96 amount) public {
        (BoostV9BehaviorTokenV1 reward,IBoostVyperV22 st,uint256 accrued)=_rewardFixture(amount);
        uint256 preUser=reward.balanceOf(USER);
        reward.setBehavior(address(st),true,false);
        vm.prank(USER);st.claim_reward(address(reward));
        require(st.claimable_reward(USER,address(reward))==0,"CLAIM_NOT_DEBITED");
        require(reward.balanceOf(USER)==preUser,"FALSE_TRANSFER_DELIVERED");
        require(reward.balanceOf(address(st))>=accrued,"MISSING_STAKING_REWARD");
    }
    function testFuzz_P5T001_ActualVyperRevertingRewardRollback(uint96 amount) public {
        (BoostV9BehaviorTokenV1 reward,IBoostVyperV22 st,uint256 accrued)=_rewardFixture(amount);
        reward.setBehavior(address(st),false,true);
        vm.expectRevert();
        vm.prank(USER);st.claim_reward(address(reward));
        require(st.claimable_reward(USER,address(reward))==accrued,"REVERT_DID_NOT_PRESERVE_CLAIM");
    }
    function testFuzz_P5T001_ActualVyperStandardRewardDelivery(uint96 amount) public {
        (BoostV9BehaviorTokenV1 reward,IBoostVyperV22 st,uint256 accrued)=_rewardFixture(amount);
        uint256 before=reward.balanceOf(USER);
        vm.prank(USER);st.claim_reward(address(reward));
        require(reward.balanceOf(USER)-before==accrued,"STANDARD_PAYOUT_DELTA");
        require(st.claimable_reward(USER,address(reward))==0,"STANDARD_CLAIM_NOT_CLEARED");
    }
    function testFuzz_P5T002_ActualVyperLPFalseReturn(uint96 amount) public {
        (BoostV9BehaviorTokenV1 lp,BoostV9VyperHubStubV1 hub,IBoostVyperV22 st)=_base();
        uint256 n=uint256(amount)%1e21+1;
        _stake(lp,st,n);
        uint256 oldUser=lp.balanceOf(USER);
        lp.setBehavior(address(st),true,false);
        vm.prank(USER);st.withdraw(n);
        require(st.staked_balance(USER)==0,"WITHDRAW_NOT_DEBITED");
        require(hub.principal(address(st))==0,"HUB_PRINCIPAL_NOT_DEBITED");
        require(lp.balanceOf(USER)==oldUser,"FALSE_LP_TRANSFER_PAID");
        require(lp.balanceOf(address(st))>=n,"LP_NOT_STRANDED");
    }
    function testFuzz_P5T002_ActualVyperStandardLPReturn(uint96 amount) public {
        (BoostV9BehaviorTokenV1 lp,,IBoostVyperV22 st)=_base();
        uint256 n=uint256(amount)%1e21+1;
        _stake(lp,st,n);
        vm.prank(USER);st.withdraw(n);
        require(st.staked_balance(USER)==0,"STANDARD_STAKE_NOT_DEBITED");
        require(lp.balanceOf(USER)==n,"STANDARD_LP_NOT_RETURNED");
    }
    function testFuzz_P5T002_ActualVyperLPRevertRollback(uint96 amount) public {
        (BoostV9BehaviorTokenV1 lp,,IBoostVyperV22 st)=_base();
        uint256 n=uint256(amount)%1e21+1;
        _stake(lp,st,n);
        lp.setBehavior(address(st),false,true);
        vm.expectRevert();
        vm.prank(USER);st.withdraw(n);
        require(st.staked_balance(USER)==n,"REVERT_BURNED_PRINCIPAL");
    }
    function test_P5T003_VyperTotalEightSlotsBoundary() public {
        BoostV9BehaviorTokenV1 lp=new BoostV9BehaviorTokenV1();
        BoostV9VyperHubStubV1 hub=new BoostV9VyperHubStubV1(address(lp));
        address[8] memory configured;
        address[] memory seven=new address[](7);
        for(uint256 i;i<8;i++){
            BoostV9BehaviorTokenV1 reward=new BoostV9BehaviorTokenV1();
            configured[i]=address(reward);
            if(i<7)seven[i]=address(reward);
        }
        hub.setRewards(seven);
        address[8] memory permitted;
        for(uint256 i;i<7;i++)permitted[i]=configured[i];
        IBoostVyperV22 st=_staking(lp,hub,permitted);
        require(st.reward_count()==8,"PRINCIPAL_PLUS_SEVEN_BOUND");
        BoostV9VyperHubStubV1 excessiveHub=new BoostV9VyperHubStubV1(address(lp));
        address[] memory eight=new address[](8);
        for(uint256 i;i<8;i++)eight[i]=configured[i];
        excessiveHub.setRewards(eight);
        bytes memory sourceCode=vm.parseBytes(vm.readFile(VYPER_BYTECODE));
        bytes memory init=bytes.concat(sourceCode,abi.encode(
            address(lp),address(excessiveHub),uint256(0),address(this),configured,
            address(this),uint256(0),address(this)
        ));
        address excess;
        assembly{excess:=create(0,add(init,32),mload(init))}
        require(excess==address(0),"EIGHT_EXTRA_REWARDS_WRONGLY_ALLOWED");
    }
}
