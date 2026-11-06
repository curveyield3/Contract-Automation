// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
// Phase 5 conditional vault short-withdrawal proof. Exact admitted vault source,
// real share ERC20 + _burn + fee math. Peripheral strategy remains an explicitly
// adversarial local dependency, NOT proof that deployed gauge returns short.
import {BeefyVaultV7FixedV2} from "../../beefy/contracts/beefy/BeefyVaultV7FixedV2.sol";
import {IStrategyBoostHubV1} from "../../beefy/contracts/beefy/interfaces/IStrategyBoostHubV1.sol";
import "./BoostHubV9VyperP5Targets_v1.t.sol";
interface VmVaultV9 {
    function prank(address) external;
    function expectRevert() external;
}
contract BoostV9PartialStrategyV1 {
    BoostV9BehaviorTokenV1 public immutable wantToken;
    address private boundVault;
    uint256 public maxPayout;
    bool public revertWithdraw;
    constructor(address want_) { wantToken=BoostV9BehaviorTokenV1(want_); maxPayout=type(uint256).max; }
    // Constructor check of the ACTUAL vault invokes vault() from the under-
    // construction vault. Subsequent calls use the bound vault set on deposit.
    function vault() external view returns (address) {
        return boundVault==address(0)?msg.sender:boundVault;
    }
    function want() external view returns(address) {return address(wantToken);}
    function balanceOf() external view returns(uint256) {return wantToken.balanceOf(address(this));}
    function beforeDeposit() external {}
    function deposit() external {
        if(boundVault==address(0))boundVault=msg.sender;
        require(msg.sender==boundVault,"VAULT_REQUIRED");
    }
    function configure(uint256 cap,bool revert_) external {maxPayout=cap;revertWithdraw=revert_;}
    function withdraw(uint256 requested) external {
        require(msg.sender==boundVault,"ONLY_VAULT");
        if(revertWithdraw)revert("WITHDRAW_BLOCKED");
        uint256 b=wantToken.balanceOf(address(this));
        uint256 sent=requested<maxPayout?requested:maxPayout;
        if(sent>b)sent=b;
        require(wantToken.transfer(msg.sender,sent),"WANT_TRANSFER");
    }
}
contract BoostHubV9VaultP5TargetsV1 {
    VmVaultV9 constant vm=VmVaultV9(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant ALICE=address(0xA11CE);
    address constant BOB=address(0xB0B);
    address constant NEW_USER=address(0xC0DE);
    function _fixture() internal returns (
        BeefyVaultV7FixedV2 vault,BoostV9PartialStrategyV1 strategy,BoostV9BehaviorTokenV1 want
    ) {
        want=new BoostV9BehaviorTokenV1();
        strategy=new BoostV9PartialStrategyV1(address(want));
        vault=new BeefyVaultV7FixedV2(IStrategyBoostHubV1(address(strategy)),"BoostVaultP5","bvP5",0,address(this));
    }
    function _deposit(
        BeefyVaultV7FixedV2 vault,BoostV9BehaviorTokenV1 want,address actor,uint256 n
    ) internal {
        want.mint(actor,n);
        vm.prank(actor);want.approve(address(vault),n);
        vm.prank(actor);vault.deposit(n);
        require(vault.balanceOf(actor)>0,"SHARES_NOT_MINTED");
    }
    function testFuzz_P5T007_PartialWithdrawalTransfersResidualToRemainingOwner(uint96 raw) public {
        (BeefyVaultV7FixedV2 v,BoostV9PartialStrategyV1 s,BoostV9BehaviorTokenV1 w)=_fixture();
        uint256 n=uint256(raw)%1e21+100;
        _deposit(v,w,ALICE,n);
        _deposit(v,w,BOB,n);
        uint256 q=v.balanceOf(ALICE);
        uint256 expectedGross=v.balance()*q/v.totalSupply();
        uint256 paid=expectedGross/5;
        s.configure(paid,false);
        uint256 beforeBobClaim=v.balance()*v.balanceOf(BOB)/v.totalSupply();
        vm.prank(ALICE);v.withdraw(q);
        require(v.balanceOf(ALICE)==0,"ALICE_SHARES_NOT_BURNED");
        require(w.balanceOf(ALICE)==paid,"ALICE_PAYMENT_NOT_CAPPED");
        require(s.balanceOf()==2*n-paid,"RESIDUAL_NOT_RECOVERABLE");
        uint256 afterBobClaim=v.balance()*v.balanceOf(BOB)/v.totalSupply();
        require(afterBobClaim-beforeBobClaim==expectedGross-paid,"OTHER_HOLDER_NOT_SUBSIDIZED");
    }
    function testFuzz_P5T007_ZeroShareSupplyLeavesRecoverableStrategyAssets(uint96 raw) public {
        (BeefyVaultV7FixedV2 v,BoostV9PartialStrategyV1 s,BoostV9BehaviorTokenV1 w)=_fixture();
        uint256 n=uint256(raw)%1e21+100;
        _deposit(v,w,ALICE,n);
        uint256 paid=n/5;
        s.configure(paid,false);
        vm.prank(ALICE);v.withdraw(v.balanceOf(ALICE));
        require(v.totalSupply()==0,"TERMINAL_SHARES_NOT_BURNED");
        require(w.balanceOf(ALICE)==paid,"TERMINAL_UNEXPECTED_PAYMENT");
        require(s.balanceOf()==n-paid,"TERMINAL_VALUE_NOT_PRESENT");
        uint256 inherited=n-paid;
        _deposit(v,w,NEW_USER,100);
        require(v.totalSupply()==100,"NEW_SHARES_NOT_MINTED");
        require(v.balance()>=inherited+100,"ASSETS_NOT_LEFT_FOR_NEW_SHARES");
        require(v.balance()*v.balanceOf(NEW_USER)/v.totalSupply()>=inherited+100,"NEW_USER_NOT_ENTITLED_TO_RESIDUAL");
    }
    function testFuzz_P5T007_FullWithdrawalControl(uint96 raw) public {
        (BeefyVaultV7FixedV2 v,,BoostV9BehaviorTokenV1 w)=_fixture();
        uint256 n=uint256(raw)%1e21+100;
        _deposit(v,w,ALICE,n);
        vm.prank(ALICE);v.withdraw(v.balanceOf(ALICE));
        require(v.totalSupply()==0,"CONTROL_SUPPLY");
        require(w.balanceOf(ALICE)==n,"CONTROL_FULL_PAYOUT");
        require(v.balance()==0,"CONTROL_RESIDUAL");
    }
    function testFuzz_P5T007_RevertingStrategyPreservesShares(uint96 raw) public {
        (BeefyVaultV7FixedV2 v,BoostV9PartialStrategyV1 s,BoostV9BehaviorTokenV1 w)=_fixture();
        uint256 n=uint256(raw)%1e21+100;
        _deposit(v,w,ALICE,n);
        uint256 q=v.balanceOf(ALICE);
        s.configure(0,true);
        vm.expectRevert();
        vm.prank(ALICE);v.withdraw(q);
        require(v.balanceOf(ALICE)==q,"REVERT_DID_NOT_RESTORE_SHARES");
        require(v.balance()==n,"REVERT_DID_NOT_RESTORE_BACKING");
    }
}
