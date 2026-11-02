// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;
import "forge-std/Test.sol";

interface IERC20TwapAudit {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}
interface IRouterTwapAudit {
    function owner() external view returns (address);
    function setRoute(address, address, bytes calldata) external;
    function setRouteFeeBps(address, address, uint16) external;
    function setRouteTwapGuard(address, address, uint32, uint16) external;
    function routeFor(address, address) external view returns (bytes memory);
    function twapMinimumOut(address, address, uint256) external view returns (uint256);
    function swapExactInput(address, address, uint256, uint256, address, uint256) external returns (uint256);
}

/// @notice Phase-5 P5-T-011: actual router path, actual pool observations, dust-range
/// rounding and observed output. Fork-only Safe pranking is an owner-configured
/// fixture, never evidence that arbitrary public users control owner calls.
contract Phase5TwapMultihopRoundingV1 is Test {
    address constant ROUTER=0x01F9894f92ea9224fECc8C35482E20a05De13582;
    address constant SAFE=0x47623C62f281807D615eeb4A2CEee9d97F9D3C49;
    address constant AVKAT=0x7231dbaCdFc968E07656D12389AB20De82FbfCeB;
    address constant KAT=0x7F1f4b4b29f5058fA32CC7a97141b8D7e5ABDC2d;
    address constant VBUSDC=0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36;
    bytes32 constant ROUTER_HASH=0xf0034d07ee5a12b9ee09736b473875342b0d38b7a96aec9b85b23d71b3b98cf4;
    uint256 constant PIN_BLOCK=46766226;
    IRouterTwapAudit router=IRouterTwapAudit(ROUTER);

    function setUp() public {
        // Exact, immutable Phase-0 source/fork anchor. Do not mutate production.
        vm.createSelectFork(vm.envString("RPC_KATANA"), PIN_BLOCK);
        assertEq(block.chainid,747474,"wrong Katana fork");
        assertEq(ROUTER.codehash,ROUTER_HASH,"deployed router differs from admitted v17 component");
        assertEq(router.owner(),SAFE,"Safe owner identity differs from admitted deployment");
        // Both 0.05% pools are source-confirmed to exist at PIN_BLOCK. Configure
        // the actual owner-reachable AVKAT -> KAT -> vbUSDC route on fork only.
        bytes memory path=abi.encodePacked(AVKAT,uint24(500),KAT,uint24(500),VBUSDC);
        vm.prank(SAFE);router.setRoute(AVKAT,VBUSDC,path);
        vm.prank(SAFE);router.setRouteFeeBps(AVKAT,VBUSDC,0);
        vm.prank(SAFE);router.setRouteTwapGuard(AVKAT,VBUSDC,900,330);
        assertEq(keccak256(router.routeFor(AVKAT,VBUSDC)),keccak256(path),"multihop route not installed");
    }

    function test_unauthorizedRouteAndZeroInputCannotBypass() public {
        vm.prank(address(0xBADD));
        vm.expectRevert(bytes("NOT_OWNER"));
        router.setRouteTwapGuard(AVKAT,VBUSDC,900,0);
        vm.expectRevert(bytes("ZERO_INPUT"));
        router.twapMinimumOut(AVKAT,VBUSDC,0);
    }

    function testFuzz_TwapFloorIsMonotonic(uint128 arbitrary) public {
        // Fuzzes actual two-pool OracleLibrary and per-hop fees; positive
        // boundaries include the smallest token unit and quote-floor threshold.
        uint256 a=bound(uint256(arbitrary),1,1e18);
        uint256 low=router.twapMinimumOut(AVKAT,VBUSDC,a);
        uint256 high=router.twapMinimumOut(AVKAT,VBUSDC,a+1);
        assertGe(high,low,"per-hop quote floor decreased for larger input");
    }

    function test_actualDustExecutionCannotEscapeOutputOracle() public {
        // Find the exact first positive TWAP floor in native AVKAT wei units,
        // avoiding an assumed 18->6 decimal conversion or fabricated tick.
        uint256 upper=1;
        while (upper<=1e22 && router.twapMinimumOut(AVKAT,VBUSDC,upper)==0) upper*=2;
        assertLe(upper,1e22,"TWAP observation unavailable or floor never positive");
        uint256 low=0,high=upper;
        while (high-low>1) {
            uint256 mid=low+(high-low)/2;
            if (router.twapMinimumOut(AVKAT,VBUSDC,mid)==0) low=mid;
            else high=mid;
        }
        assertEq(router.twapMinimumOut(AVKAT,VBUSDC,low),0,"invalid floor boundary");
        assertGt(router.twapMinimumOut(AVKAT,VBUSDC,high),0,"invalid positive boundary");

        // Real exact-input swap, not a quote-only control. Revert each local
        // branch to the same block/reserves/balances/allowances and timestamp.
        uint256[8] memory nearBoundary=[
            low,low>1?low-1:1,low/2+1,low/4+1,
            low>100?low-100:1,low>10000?low-10000:1,
            low>1e9?low-1e9:1,low>1e12?low-1e12:1
        ];
        bool executedPositive=false;
        for(uint256 i=0;i<nearBoundary.length;i++) {
            uint256 amount=nearBoundary[i];
            if(amount==0||router.twapMinimumOut(AVKAT,VBUSDC,amount)!=0)continue;
            uint256 snap=vm.snapshot();
            deal(AVKAT,address(this),amount);
            assertTrue(IERC20TwapAudit(AVKAT).approve(ROUTER,amount),"approve failed");
            uint256 beforeOut=IERC20TwapAudit(VBUSDC).balanceOf(address(this));
            try router.swapExactInput(AVKAT,VBUSDC,amount,0,address(this),block.timestamp+1)
              returns(uint256 nominal) {
                uint256 received=IERC20TwapAudit(VBUSDC).balanceOf(address(this))-beforeOut;
                assertEq(received,nominal,"recipient did not actually get reported net");
                if(received>0)executedPositive=true;
            } catch {
                // An actual reverted dust swap is not evidence of a bypass.
            }
            assertTrue(vm.revertTo(snap),"snapshot reset failed");
        }
        // Reaching this assertion proves a viable token payout with zero
        // enforceable TWAP floor, not merely that a view quote rounds to zero.
        assertFalse(executedPositive,"P4-TWAP-MULTIHOP-PRICE-ROUNDING: nonzero payout at zero TWAP floor");
    }
}
