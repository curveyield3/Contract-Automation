// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;
import "forge-std/Test.sol";

interface IERC20P5Price {
    function balanceOf(address) external view returns (uint256);
    function approve(address,uint256) external returns (bool);
}
interface IRouterP5Price {
    function owner() external view returns(address);
    function setRoute(address,address,bytes calldata) external;
    function setRouteFeeBps(address,address,uint16) external;
    function setRouteTwapGuard(address,address,uint32,uint16) external;
    function twapMinimumOut(address,address,uint256) external view returns(uint256);
    function swapExactInput(address,address,uint256,uint256,address,uint256) external returns(uint256);
    function routeTwapGuard(address,address) external view returns(uint32,uint16,bool);
}
/// @notice P5-T-010. Real Katana V3 swap and adversarial preceding spot trade.
/// A guarded but adverse execution is distinct from a below-minimum bypass.
/// Both comparison branches use the identical original fork and real callbacks.
contract Phase5RouterPriceThresholdV1 is Test {
    address constant ROUTER=0x01F9894f92ea9224fECc8C35482E20a05De13582;
    address constant KAT=0x7F1f4b4b29f5058fA32CC7a97141b8D7e5ABDC2d;
    address constant VBUSDC=0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36;
    address constant SAFE=0x47623C62f281807D615eeb4A2CEee9d97F9D3C49;
    bytes32 constant ROUTER_HASH=0xf0034d07ee5a12b9ee09736b473875342b0d38b7a96aec9b85b23d71b3b98cf4;
    uint256 constant PIN_BLOCK=46766226;
    uint256 constant KEEPER_AMOUNT=1e18;
    IRouterP5Price router=IRouterP5Price(ROUTER);
    function setUp() public {
        vm.createSelectFork(vm.envString("RPC_KATANA"),PIN_BLOCK);
        assertEq(block.chainid,747474,"wrong chain");
        assertEq(ROUTER.codehash,ROUTER_HASH,"router runtime mismatch");
        assertEq(router.owner(),SAFE,"router Safe owner mismatch");
        vm.prank(SAFE);router.setRoute(KAT,VBUSDC,abi.encodePacked(KAT,uint24(500),VBUSDC));
        vm.prank(SAFE);router.setRouteFeeBps(KAT,VBUSDC,0);
        vm.prank(SAFE);router.setRouteTwapGuard(KAT,VBUSDC,900,330);
        (uint32 window,uint16 deviation,bool enabled)=router.routeTwapGuard(KAT,VBUSDC);
        assertTrue(enabled);assertEq(window,900);assertEq(deviation,330);
    }
    function _fundAndApprove(address payer,uint256 amount) internal {
        deal(KAT,payer,amount);
        vm.prank(payer);
        assertTrue(IERC20P5Price(KAT).approve(ROUTER,amount),"KAT approval failed");
    }
    function _realSwap(address payer,uint256 amount,uint256 userMinimum) internal returns(uint256 received) {
        uint256 beforeBal=IERC20P5Price(VBUSDC).balanceOf(payer);
        uint256 katBefore=IERC20P5Price(KAT).balanceOf(payer);
        vm.prank(payer);
        uint256 reported=router.swapExactInput(KAT,VBUSDC,amount,userMinimum,payer,block.timestamp+100);
        received=IERC20P5Price(VBUSDC).balanceOf(payer)-beforeBal;
        assertEq(received,reported,"nominal net differs from actual recipient receipt");
        assertEq(katBefore-IERC20P5Price(KAT).balanceOf(payer),amount,"KAT input debit mismatch");
    }
    function test_realSwapEnforcesExactTwapNetFloor() public {
        uint256 minNet=router.twapMinimumOut(KAT,VBUSDC,KEEPER_AMOUNT);
        assertGt(minNet,0,"positive-value pool oracle unexpectedly returned zero");
        _fundAndApprove(address(this),KEEPER_AMOUNT);
        uint256 received=_realSwap(address(this),KEEPER_AMOUNT,0);
        assertGe(received,minNet,"real transfer below TWAP floor");
        emit log_named_uint("twap_min_vbusdc_base_units",minNet);
        emit log_named_uint("actual_vbusdc_base_units",received);
    }
    function test_excessiveCallerMinimumAtomicRollback() public {
        _fundAndApprove(address(this),KEEPER_AMOUNT);
        uint256 beforeK=IERC20P5Price(KAT).balanceOf(address(this));
        uint256 beforeV=IERC20P5Price(VBUSDC).balanceOf(address(this));
        vm.expectRevert(bytes("TOO_LITTLE_NET"));
        router.swapExactInput(KAT,VBUSDC,KEEPER_AMOUNT,type(uint256).max,address(this),block.timestamp+100);
        assertEq(IERC20P5Price(KAT).balanceOf(address(this)),beforeK,"KAT consumed after reverted swap");
        assertEq(IERC20P5Price(VBUSDC).balanceOf(address(this)),beforeV,"vbUSDC credited after reverted swap");
    }
    function test_spotPressureDoesNotBypassTwapFloor() public {
        uint256 snapshot=vm.snapshot();
        uint256 lower=router.twapMinimumOut(KAT,VBUSDC,KEEPER_AMOUNT);
        _fundAndApprove(address(this),KEEPER_AMOUNT);
        uint256 baseline=_realSwap(address(this),KEEPER_AMOUNT,0);
        assertTrue(vm.revertTo(snapshot),"baseline snapshot not restored");
        // The attacker makes a REAL trade through the same V3 pool, not a mock tick.
        address attacker=address(0xBEEF);
        _fundAndApprove(attacker,KEEPER_AMOUNT);
        uint256 attackReceived=_realSwap(attacker,KEEPER_AMOUNT,0);
        assertGt(attackReceived,0,"adversarial spot trade did not reach the pool");
        _fundAndApprove(address(this),KEEPER_AMOUNT);
        uint256 afterKat=IERC20P5Price(KAT).balanceOf(address(this));
        uint256 afterV=IERC20P5Price(VBUSDC).balanceOf(address(this));
        try router.swapExactInput(KAT,VBUSDC,KEEPER_AMOUNT,0,address(this),block.timestamp+100)
          returns(uint256 observed) {
            uint256 actual=IERC20P5Price(VBUSDC).balanceOf(address(this))-afterV;
            assertEq(actual,observed,"claimed output not received");
            assertEq(afterKat-IERC20P5Price(KAT).balanceOf(address(this)),KEEPER_AMOUNT);
            assertGe(actual,lower,"spot trade bypassed TWAP minimum");
            emit log_named_uint("baseline_net_vbusdc",baseline);
            emit log_named_uint("after_spot_pressure_vbusdc",actual);
            if(actual<baseline)emit log_named_uint("slippage_inside_guard_vbusdc",baseline-actual);
        } catch {
            // A below-bound swap reverts the attempted keeper trade, including
            // all token debits, rather than letting the keeper receive too little.
            assertEq(IERC20P5Price(KAT).balanceOf(address(this)),afterKat,"KAT debit survived reverted keeper swap");
            assertEq(IERC20P5Price(VBUSDC).balanceOf(address(this)),afterV,"unexpected vbUSDC after revert");
            emit log_string("keeper swap rejected after genuine price pressure");
        }
    }
    function testFuzz_configuredRealTwapQuoteMonotonic(uint128 randomAmount) public {
        uint256 amount=bound(uint256(randomAmount),1,1e24);
        uint256 lo=router.twapMinimumOut(KAT,VBUSDC,amount);
        uint256 hi=router.twapMinimumOut(KAT,VBUSDC,amount+1);
        assertGe(hi,lo,"actual V3 TWAP quote unexpectedly decreased");
    }
}
