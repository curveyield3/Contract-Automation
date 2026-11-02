// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;
import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Id,MarketParams} from "@morpho-blue/interfaces/IMorpho.sol";
import {ITokenizedStrategy} from "@tokenized-strategy/interfaces/ITokenizedStrategy.sol";
import {YearnMorphoMarketChild_v2} from "contracts/YearnMorphoMarketChild_v2.sol";

contract P5YearnIdentityToken is ERC20 {
    constructor() ERC20("Audit vbUSDC","vbAudit") {}
    function decimals() public pure override returns(uint8){return 6;}
}
contract P5YearnIdentityMarket {
    address public immutable token;
    constructor(address a){token=a;}
    function idToMarketParams(Id) external view returns(MarketParams memory m){
        m=MarketParams({loanToken:token,collateralToken:address(0xCCC),
            oracle:address(0),irm:address(0),lltv:800000000000000000});
    }
}
/// @notice P5-T-016. Exact admitted BaseStrategy hardcoded delegate.
/// The STOP-bytecode case is fork-local negative integration control ONLY.
/// Real TokenizedStrategy is explorer verified, not a currently compromised proxy.
contract Phase5YearnIdentityV1 is Test {
    address internal constant YEARNTOKENIZED=0x310f5Db015E9d6E542fd41bd4542640790791e76;
    bytes32 internal constant LIVE_HASH=0xeeac59408774487f10a4b7a253b03b9307dd50c835f9e56f64e64b21f3b812b4;
    address internal constant KAT=0x7F1f4b4b29f5058fA32CC7a97141b8D7e5ABDC2d;
    address internal constant ROUTER=0x01F9894f92ea9224fECc8C35482E20a05De13582;
    address internal constant MERKL=0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae;
    P5YearnIdentityToken internal token;
    P5YearnIdentityMarket internal morpho;
    function setUp() public {
        vm.createSelectFork(vm.envString("RPC_KATANA"),46766226);
        assertEq(block.chainid,747474);
        assertEq(YEARNTOKENIZED.codehash,LIVE_HASH,"Yearn runtime not authenticated");
        token=new P5YearnIdentityToken();
        morpho=new P5YearnIdentityMarket(address(token));
    }
    function _newChild() internal returns(YearnMorphoMarketChild_v2) {
        return new YearnMorphoMarketChild_v2(address(token),"Yearn identity child",
            address(morpho),Id.wrap(bytes32(uint256(3))),address(this),
            KAT,ROUTER,MERKL);
    }
    function test_liveDelegateInitializesRealStrategyRolesAndAsset() public {
        YearnMorphoMarketChild_v2 child=_newChild();
        assertEq(ITokenizedStrategy(address(child)).management(),address(this),
            "official delegate failed strategy initialization");
        assertEq(ITokenizedStrategy(address(child)).asset(),address(token),
            "delegate returned wrong underlying asset");
        assertEq(ITokenizedStrategy(address(child)).keeper(),address(this),
            "delegate initialized wrong keeper");
    }
    function test_externalOnlySelfCannotCallYearnEmergencyCallback() public {
        YearnMorphoMarketChild_v2 child=_newChild();
        vm.prank(address(0xBAD));
        vm.expectRevert(bytes("!self"));
        child.shutdownWithdraw(1);
    }
    function test_forkOnlyWrongCodeCannotEstablishValidManagement() public {
        // Mutates ONLY the isolated fork; no ability to change the real fixed
        // live implementation is alleged or implied.
        vm.etch(YEARNTOKENIZED,hex"00");
        assertTrue(YEARNTOKENIZED.codehash!=LIVE_HASH,"negative control did not replace code");
        try new YearnMorphoMarketChild_v2(address(token),"wrong code child",
            address(morpho),Id.wrap(bytes32(uint256(3))),address(this),
            KAT,ROUTER,MERKL) returns(YearnMorphoMarketChild_v2 child) {
            (bool success,bytes memory data)=address(child).staticcall(abi.encodeWithSignature("management()"));
            assertTrue(!success||data.length!=32,
                "a STOP-only delegate fabricated a well-formed management address");
        } catch {
            // A guarded construction revert is also an acceptable fail-closed
            // response to a deliberately poisoned implementation address.
        }
    }
    function testFuzz_unprivilegedActorCannotCallOnlySelf(uint96 raw) public {
        YearnMorphoMarketChild_v2 child=_newChild();
        uint256 amount=bound(uint256(raw),1,1000000000);
        vm.prank(address(0xBAD));
        vm.expectRevert(bytes("!self"));
        child.shutdownWithdraw(amount);
    }
}
