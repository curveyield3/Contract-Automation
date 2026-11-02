// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;
import "forge-std/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Id, MarketParams } from "@morpho-blue/interfaces/IMorpho.sol";
import { YearnMorphoMarketChild_v2 } from "contracts/YearnMorphoMarketChild_v2.sol";

contract AllowanceAuditToken is ERC20 {
    constructor() ERC20("Audit vbUSDC", "aVBUSDC") {}
    function decimals() public pure override returns (uint8) {return 6;}
    function mint(address to, uint256 amount) external {_mint(to,amount);}
}
/// @dev Dependency chosen at child deployment. This code is NOT admitted as
/// actual Katana Morpho or evidence of a compromised deployed Morpho.
contract AllowanceAuditMorpho {
    ERC20 public immutable underlying;
    address public immutable marketLoanToken;
    bool public immutable rogue;
    constructor(address actualToken,address reportedLoanToken,bool isRogue) {
        underlying=ERC20(actualToken);marketLoanToken=reportedLoanToken;rogue=isRogue;
    }
    function idToMarketParams(Id) external view returns (MarketParams memory m) {
        m=MarketParams({loanToken:marketLoanToken,collateralToken:address(0xCA11),
            oracle:address(0x0),irm:address(0x0),lltv:800000000000000000});
    }
    function drain(address victim,address recipient,uint256 amount) external {
        require(rogue,"HONEST_DEPENDENCY_CANNOT_DRAIN");
        require(underlying.transferFrom(victim,recipient,amount),"TRANSFER_FAILED");
    }
}
/// @notice P5-T-020: exact child.constructor() unlimited allowance custody risk.
/// No production write; witness requires deploying a child with a rogue Morpho.
contract Phase5MorphoAllowanceV1 is Test {
    uint256 internal constant PIN_BLOCK=46766226;
    address internal constant KAT=0x7F1f4b4b29f5058fA32CC7a97141b8D7e5ABDC2d;
    address internal constant ROUTER=0x01F9894f92ea9224fECc8C35482E20a05De13582;
    address internal constant DISTRIBUTOR=0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae;
    address internal constant YEARN_TOKENIZED=0x310f5Db015E9d6E542fd41bd4542640790791e76;
    Id internal constant TEST_MARKET=Id.wrap(bytes32(uint256(42)));
    AllowanceAuditToken internal token;
    AllowanceAuditMorpho internal honest;
    AllowanceAuditMorpho internal rogue;

    function setUp() public {
        vm.createSelectFork(vm.envString("RPC_KATANA"),PIN_BLOCK);
        assertEq(block.chainid,747474,"Katana pin mismatch");
        assertGt(YEARN_TOKENIZED.code.length,0,"Yearn delegate unavailable");
        token=new AllowanceAuditToken();
        honest=new AllowanceAuditMorpho(address(token),address(token),false);
        rogue=new AllowanceAuditMorpho(address(token),address(token),true);
    }
    function _child(AllowanceAuditMorpho venue) internal returns (YearnMorphoMarketChild_v2) {
        return new YearnMorphoMarketChild_v2(
            address(token),"Audit Morpho Child",address(venue),TEST_MARKET,
            address(this),KAT,ROUTER,DISTRIBUTOR
        );
    }
    function test_unapprovedOutsiderCannotSpendChildAndHonestVenueCannotDrain() public {
        YearnMorphoMarketChild_v2 child=_child(honest);
        uint256 amount=100000000;
        token.mint(address(child),amount);
        address outsider=address(0xBAD);
        assertEq(token.allowance(address(child),address(honest)),type(uint256).max);
        assertEq(token.allowance(address(child),outsider),0);
        vm.prank(outsider);
        vm.expectRevert();
        token.transferFrom(address(child),outsider,amount);
        vm.prank(outsider);
        vm.expectRevert(bytes("HONEST_DEPENDENCY_CANNOT_DRAIN"));
        honest.drain(address(child),outsider,amount);
        assertEq(token.balanceOf(address(child)),amount);
        assertEq(token.balanceOf(outsider),0);
    }
    function test_wrongMarketLoanTokenRejectedAtomically() public {
        AllowanceAuditMorpho invalid=new AllowanceAuditMorpho(address(token),address(0xDEAD),true);
        vm.expectRevert(YearnMorphoMarketChild_v2.InvalidConfiguration.selector);
        _child(invalid);
    }
    function testFuzz_rogueSelectedMorphoCanConsumeLooseCapital(uint96 input) public {
        uint256 amount=bound(uint256(input),1,1000000000);
        YearnMorphoMarketChild_v2 child=_child(rogue);
        token.mint(address(child),amount);
        address attacker=address(0xBEEF);
        uint256 victimBefore=token.balanceOf(address(child));
        uint256 attackerBefore=token.balanceOf(attacker);
        assertEq(victimBefore,amount);
        assertEq(token.allowance(address(child),address(rogue)),type(uint256).max);
        vm.prank(attacker);
        rogue.drain(address(child),attacker,amount);
        assertEq(victimBefore-token.balanceOf(address(child)),amount,
            "wrong amount consumed via approved rogue dependency");
        assertEq(token.balanceOf(attacker)-attackerBefore,amount,
            "attacker did not actually receive asset");
        // This demonstrates only an attacker-selected dependency in the
        // deployer's constructor trust model, NOT malicious real Morpho.
    }
}
