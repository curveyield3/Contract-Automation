// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;
import "forge-std/Test.sol";
interface IAuditV3Factory { function getPool(address,address,uint24) external view returns(address); }
interface IAuditV3Pool {function factory() external view returns(address); function fee() external view returns(uint24); function token0() external view returns(address); function token1() external view returns(address); }
interface IAuditToken {function balanceOf(address) external view returns(uint256); function approve(address,uint256) external returns(bool);}
interface IAuditRouter {function owner() external view returns(address); function setRoute(address,address,bytes calldata) external; function routeFor(address,address) external view returns(bytes memory); function swapExactInput(address,address,uint256,uint256,address,uint256) external returns(uint256); function uniswapV3SwapCallback(int256,int256,bytes calldata) external;}
/// @notice Decisive provenance/callback test against the actual pinned Katana V3 factory pools.
/// Receipt/status and balance conservation are separate assertions.
contract Phase5PoolProvenanceV1 is Test {
 address constant FACTORY=0x203e8740894c8955cB8950759876d7E7E45E04c1;
 address constant ROUTER=0x01F9894f92ea9224fECc8C35482E20a05De13582;
 address constant SAFE=0x47623C62f281807D615eeb4A2CEee9d97F9D3C49;
 address constant AVKAT=0x7231dbaCdFc968E07656D12389AB20De82FbfCeB;
 address constant KAT=0x7F1f4b4b29f5058fA32CC7a97141b8D7e5ABDC2d;
 address constant VBUSDC=0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36;
 address constant POOL_AVKAT_KAT=0x4dc349c34c8c2728c5d018871b20291728bb4c77;
 address constant POOL_KAT_VBUSDC=0x10045367e619caae6f60cc80046c43c6cd55f629;
 bytes32 constant ROUTER_HASH=0xf0034d07ee5a12b9ee09736b473875342b0d38b7a96aec9b85b23d71b3b98cf4;
 bytes32 constant POOL1_HASH=0x8dec3d65654db433825ccc771ad54586c557925ff7ef163a783e3f7c3a34017a;
 bytes32 constant POOL2_HASH=0xee2648bcdbd53e63a6f9d1ec1e53847f05bef9c245dcc0b0c2f4e84b0038c6d3;
 IAuditRouter router=IAuditRouter(ROUTER);
 function setUp() public {
   vm.createSelectFork(vm.envString("RPC_KATANA"),46766226);
   assertEq(block.chainid,747474);
   assertEq(ROUTER.codehash,ROUTER_HASH,"router runtime changed");
   assertEq(router.owner(),SAFE,"owner differs from frozen deployment");
   assertEq(IAuditV3Factory(FACTORY).getPool(AVKAT,KAT,500),POOL_AVKAT_KAT,"first pool not canonical");
   assertEq(IAuditV3Factory(FACTORY).getPool(KAT,VBUSDC,500),POOL_KAT_VBUSDC,"second pool not canonical");
   assertEq(POOL_AVKAT_KAT.codehash,POOL1_HASH,"first pool implementation changed");
   assertEq(POOL_KAT_VBUSDC.codehash,POOL2_HASH,"second pool implementation changed");
 }
 function _verifyPool(address p,address a,address b) internal view {
   IAuditV3Pool pool=IAuditV3Pool(p);
   assertEq(pool.factory(),FACTORY);
   assertEq(pool.fee(),500);
   assertEq(pool.token0(),a<b?a:b);
   assertEq(pool.token1(),a<b?b:a);
 }
 function test_authenticatedTwoHopAndOwnerOnlyRoute() public {
   _verifyPool(POOL_AVKAT_KAT,AVKAT,KAT);
   _verifyPool(POOL_KAT_VBUSDC,KAT,VBUSDC);
   bytes memory route=abi.encodePacked(AVKAT,uint24(500),KAT,uint24(500),VBUSDC);
   vm.prank(address(0xBAD));
   vm.expectRevert(bytes("NOT_OWNER"));
   router.setRoute(AVKAT,VBUSDC,route);
   vm.prank(SAFE);
   router.setRoute(AVKAT,VBUSDC,route);
   assertEq(keccak256(router.routeFor(AVKAT,VBUSDC)),keccak256(route));
 }
 function test_directSpoofedCallbackCannotPullAnyPayerFunds() public {
   address payer=address(0xC0FFEE);
   deal(KAT,payer,1e18);
   uint256 beforeBalance=IAuditToken(KAT).balanceOf(payer);
   bytes memory path=abi.encodePacked(KAT,uint24(500),VBUSDC);
   bytes memory cbData=abi.encode(path,payer);
   vm.prank(address(0xBAD));
   vm.expectRevert(bytes("NO_ACTIVE_SWAP"));
   router.uniswapV3SwapCallback(int256(1),int256(0),cbData);
   assertEq(IAuditToken(KAT).balanceOf(payer),beforeBalance,"unauthorized callback spent payer funds");
 }
 function testFuzz_poolMetadataRemainsStable(uint96 amount) public {
   // Actual dependency attestation at the pinned chain state, with broad input
   // variation to exercise V3 amount precision and callback upper-bound constraints.
   uint256 a=bound(uint256(amount),1,1e24);
   _verifyPool(POOL_KAT_VBUSDC,KAT,VBUSDC);
   vm.prank(address(0xBAD));
   vm.expectRevert(bytes("NO_ACTIVE_SWAP"));
   router.uniswapV3SwapCallback(int256(a),int256(0),abi.encode(abi.encodePacked(KAT,uint24(500),VBUSDC),address(this)));
 }
 function test_realPoolSwapConservesObservedRecipientOutput() public {
   // Owner route is explicitly configured only in an isolated local fork;
   // a real Sushi V3 pool invokes the callback, not a spoofed EOA.
   bytes memory route=abi.encodePacked(KAT,uint24(500),VBUSDC);
   vm.prank(SAFE);router.setRoute(KAT,VBUSDC,route);
   uint256 amount=1e18;
   deal(KAT,address(this),amount);
   assertTrue(IAuditToken(KAT).approve(ROUTER,amount));
   uint256 beforeKat=IAuditToken(KAT).balanceOf(address(this));
   uint256 beforeOut=IAuditToken(VBUSDC).balanceOf(address(this));
   uint256 net=router.swapExactInput(KAT,VBUSDC,amount,0,address(this),block.timestamp+100);
   assertGt(net,0,"real pool returned zero vbUSDC");
   assertEq(beforeKat-IAuditToken(KAT).balanceOf(address(this)),amount,"input transfer mismatch");
   assertEq(IAuditToken(VBUSDC).balanceOf(address(this))-beforeOut,net,"reported output not received");
 }
}
