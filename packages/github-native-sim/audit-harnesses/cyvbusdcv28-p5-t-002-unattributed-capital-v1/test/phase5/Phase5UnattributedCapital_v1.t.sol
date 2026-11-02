// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;
import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Id,MarketParams,Market,Position} from "@morpho-blue/interfaces/IMorpho.sol";
import {YearnMorphoMarketChild_v2} from "contracts/YearnMorphoMarketChild_v2.sol";
import {ITokenizedStrategy} from "@tokenized-strategy/interfaces/ITokenizedStrategy.sol";

contract P5AprToken is ERC20 {
    constructor() ERC20("Audited vbUSDC","aVB") {}
    function decimals() public pure override returns(uint8){return 6;}
    function mint(address who,uint256 amount) external {_mint(who,amount);}
}
contract P5MorphoAccounting {
    ERC20 public immutable asset;
    uint128 internal supplyAssetBalance;
    uint128 internal supplyShareBalance;
    mapping(address=>uint128) internal shares;
    constructor(address a){asset=ERC20(a);}
    function idToMarketParams(Id) external view returns(MarketParams memory m) {
        m=MarketParams({loanToken:address(asset),collateralToken:address(0xC011),
            oracle:address(0x0),irm:address(0x0),lltv:8e17});
    }
    function market(Id) external view returns(Market memory m){
        m=Market({totalSupplyAssets:supplyAssetBalance,totalSupplyShares:supplyShareBalance,
            totalBorrowAssets:0,totalBorrowShares:0,lastUpdate:uint128(block.timestamp),fee:0});
    }
    function position(Id,address owner) external view returns(Position memory p){
        p=Position({supplyShares:shares[owner],borrowShares:0,collateral:0});
    }
    function supply(MarketParams calldata,uint256 assets,uint256 shareAmount,address beneficiary,bytes calldata)
      external returns(uint256 supplied,uint256 mintedShares){
        require(assets>0&&shareAmount==0,"SUPPLY_ONLY_ASSETS");
        require(asset.transferFrom(msg.sender,address(this),assets),"TRANSFER_FAILED");
        // Exact 1:1 identity for SharesMathLib.toAssetsDown's virtual conversion:
        // (assets*1e6)*(totalAssets+1)/(totalShares+1e6) == assets.
        mintedShares=assets*1e6;
        supplyAssetBalance+=uint128(assets);
        supplyShareBalance+=uint128(mintedShares);
        shares[beneficiary]+=uint128(mintedShares);
        return (assets,mintedShares);
    }
}
contract P5NoClaimMerkl {
    // A legitimate successful zero-reward claim. It is a fixture-specific
    // distributor, not evidence of Katana Merkl claim validity.
    function claim(address[] calldata,address[] calldata,uint256[] calldata,bytes32[][] calldata) external {}
}
/// @notice P5-T-002: real child deposit/claim/checkpoint code, explicit APR
/// donation contrast; neither fake Morpho nor Merkl proves production attack.
contract Phase5UnattributedCapitalV1 is Test {
    uint256 internal constant PIN_BLOCK=46766226;
    address internal constant YEARN_IMPL=0x310f5Db015E9d6E542fd41bd4542640790791e76;
    uint256 internal constant INITIAL_CAPITAL=100_000_000; // 100.000000 vbUSDC
    P5AprToken internal asset;
    P5AprToken internal reward;
    P5MorphoAccounting internal morpho;
    P5NoClaimMerkl internal merkl;
    YearnMorphoMarketChild_v2 internal child;
    function setUp() public {
        vm.createSelectFork(vm.envString("RPC_KATANA"),PIN_BLOCK);
        assertEq(block.chainid,747474);
        assertGt(YEARN_IMPL.code.length,0,"actual Yearn delegate absent");
        asset=new P5AprToken();
        reward=new P5AprToken();
        morpho=new P5MorphoAccounting(address(asset));
        merkl=new P5NoClaimMerkl();
        child=new YearnMorphoMarketChild_v2(address(asset),"APR accounting child",
          address(morpho),Id.wrap(bytes32(uint256(7))),address(this),address(reward),
          address(0xD00D),address(merkl));
        asset.mint(address(this),INITIAL_CAPITAL);
        asset.approve(address(child),INITIAL_CAPITAL);
        // Genuine Yearn TokenizedStrategy ERC4626 deposit through exact child.
        uint256 minted=ITokenizedStrategy(address(child)).deposit(INITIAL_CAPITAL,address(this));
        assertGt(minted,0,"master did not receive Yearn shares");
        child.recordCapitalFlow(INITIAL_CAPITAL,true); // normal master capital ledger
        assertEq(child.positionAssets(),INITIAL_CAPITAL,"Morpho mock incorrect asset identity");
        vm.warp(block.timestamp+1 days);
        _checkpoint();
        assertEq(child.lastKnownApr(),0,"baseline APR not neutral");
        assertEq(child.lastHarvestAssets(),INITIAL_CAPITAL);
    }
    function _checkpoint() internal {
        address[] memory users=new address[](1);
        address[] memory tokens=new address[](1);
        uint256[] memory amounts=new uint256[](1);
        bytes32[][] memory proofs=new bytes32[][](1);
        users[0]=address(child);tokens[0]=address(reward);amounts[0]=0;
        proofs[0]=new bytes32[](0);
        (uint256 delta,bool success)=child.claimRewardsToMaster(users,tokens,amounts,proofs);
        assertTrue(success,"zero reward claim did not reach checkpoint");
        assertEq(delta,0,"zero reward control minted reward unexpectedly");
    }
    function testFuzz_externalDonationInflatesAPRNotMasterInflow(uint96 randomDonation) public {
        uint256 donation=bound(uint256(randomDonation),1,100_000_000);
        vm.warp(block.timestamp+1 days);
        address donor=address(0xBAD);
        asset.mint(donor,donation);
        uint256 beforePrincipal=child.positionAssets();
        uint256 beforeInflows=child.inflows();
        vm.prank(donor);asset.transfer(address(child),donation);
        assertEq(child.positionAssets()-beforePrincipal,donation);
        assertEq(child.inflows(),beforeInflows,"donation was attributed as master capital");
        _checkpoint(); // actual claimRewardsToMaster -> checkpointAprAfterClaim
        int256 overstatedApr=child.lastKnownApr();
        assertGt(overstatedApr,0,"unattributed external capital did not raise APR");
        assertEq(child.lastHarvestAssets(),INITIAL_CAPITAL+donation);
    }
    function test_recordedMasterCapitalDoesNotInflateAPR() public {
        uint256 amount=25_000_000;
        vm.warp(block.timestamp+1 days);
        asset.mint(address(this),amount);
        asset.approve(address(child),amount);
        ITokenizedStrategy(address(child)).deposit(amount,address(this));
        child.recordCapitalFlow(amount,true);
        assertEq(child.inflows(),amount);
        _checkpoint();
        assertEq(child.lastKnownApr(),0,"recorded deposit incorrectly counted as yield");
    }
    function test_thirdPartyFundedDepositToMasterRaisesUnrecordedAPR() public {
        uint256 amount=25_000_000;
        vm.warp(block.timestamp+1 days);
        address donor=address(0xBEEF);
        asset.mint(donor,amount);
        vm.prank(donor);asset.approve(address(child),amount);
        uint256 beforeShares=ITokenizedStrategy(address(child)).balanceOf(address(this));
        vm.prank(donor);
        uint256 minted=ITokenizedStrategy(address(child)).deposit(amount,address(this));
        assertGt(minted,0);
        assertEq(ITokenizedStrategy(address(child)).balanceOf(address(this))-beforeShares,minted);
        assertEq(child.inflows(),0,"direct external deposit unexpectedly notified master");
        _checkpoint();
        assertGt(child.lastKnownApr(),0,"source APR not affected by unattributed third-party capital");
    }
    function test_unauthorizedCapitalFlowEntryReverts() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(YearnMorphoMarketChild_v2.WrongCaller.selector);
        child.recordCapitalFlow(100,true);
    }
}
