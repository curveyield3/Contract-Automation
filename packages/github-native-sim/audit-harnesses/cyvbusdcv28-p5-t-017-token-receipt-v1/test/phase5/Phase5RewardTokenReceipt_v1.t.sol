// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;
import "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Id,MarketParams} from "@morpho-blue/interfaces/IMorpho.sol";
import {YearnMorphoMarketChild_v2} from "contracts/YearnMorphoMarketChild_v2.sol";

contract P5ReceiptToken is ERC20 {
    uint16 internal immutable transferFeeBps;
    constructor(uint16 fee) ERC20("Audit KAT", "aKAT") {transferFeeBps=fee;}
    function mint(address to,uint256 amount) external {_mint(to,amount);}
    function _transfer(address from,address to,uint256 amount) internal override {
        uint256 fee=amount*transferFeeBps/10000;
        if(fee!=0)_burn(from,fee);
        super._transfer(from,to,amount-fee);
    }
}
contract P5ReceiptAsset is ERC20 {
    constructor() ERC20("Audit vbUSDC","aVBUSDC") {}
    function decimals() public pure override returns(uint8){return 6;}
}
contract P5ReceiptMorpho {
    address public immutable loanToken;
    constructor(address token){loanToken=token;}
    function idToMarketParams(Id) external view returns(MarketParams memory p){
        p=MarketParams({loanToken:loanToken,collateralToken:address(0xC011),
            oracle:address(0),irm:address(0),lltv:8e17});
    }
}
contract P5ReceiptMerkl {
    function claim(address[] calldata users,address[] calldata tokens,
      uint256[] calldata amounts,bytes32[][] calldata) external {
        for(uint256 i;i<users.length;i++){
            require(ERC20(tokens[i]).transfer(users[i],amounts[i]),"CLAIM_TRANSFER_FAILED");
        }
    }
}
contract P5ReceiptOracle {
    function twapMinimumOut(address,address,uint256) external pure returns(uint256){return 0;}
}
/// @notice P5-T-017: actual child claims and forwards reward ERC20;
/// compare reported nominal child->master KAT against ACTUAL master delta.
/// Fee-on-transfer KAT exists ONLY in isolated test, not admitted live Katana.
contract Phase5RewardTokenReceiptV1 is Test {
    P5ReceiptAsset internal asset;
    P5ReceiptMorpho internal morpho;
    P5ReceiptMerkl internal merkl;
    P5ReceiptOracle internal oracle;
    function setUp() public {
        vm.createSelectFork(vm.envString("RPC_KATANA"),46766226);
        assertEq(block.chainid,747474);
        assertGt(address(0x310f5Db015E9d6E542fd41bd4542640790791e76).code.length,0);
        asset=new P5ReceiptAsset();
        morpho=new P5ReceiptMorpho(address(asset));
        merkl=new P5ReceiptMerkl();
        oracle=new P5ReceiptOracle();
    }
    function _claim(uint16 fee,uint256 amount)
       internal returns(uint256 reported,uint256 actual,P5ReceiptToken kat) {
        kat=new P5ReceiptToken(fee);
        YearnMorphoMarketChild_v2 child=new YearnMorphoMarketChild_v2(
            address(asset),"Token receipt child",address(morpho),Id.wrap(bytes32(uint256(9))),
            address(this),address(kat),address(oracle),address(merkl));
        kat.mint(address(merkl),amount);
        address[] memory users=new address[](1);
        address[] memory tokens=new address[](1);
        uint256[] memory amounts=new uint256[](1);
        bytes32[][] memory proofs=new bytes32[][](1);
        users[0]=address(child);tokens[0]=address(kat);amounts[0]=amount;
        proofs[0]=new bytes32[](0);
        uint256 masterBefore=kat.balanceOf(address(this));
        bool ok;
        (reported,ok)=child.claimRewardsToMaster(users,tokens,amounts,proofs);
        assertTrue(ok,"Merkl fixture claim was rejected");
        actual=kat.balanceOf(address(this))-masterBefore;
        assertEq(kat.balanceOf(address(child)),0,"child retained KAT despite forward");
    }
    function test_standardKATActualMasterReceiptEqualsReported() public {
        (uint256 claimed,uint256 received,)=_claim(0,1000000);
        assertEq(claimed,1000000);
        assertEq(received,claimed,"canonical ERC20 forwarding mismatch");
    }
    function testFuzz_feeOnTransferKATUnderDeliversMaster(uint96 fuzzAmount) public {
        uint256 originalAmount=bound(uint256(fuzzAmount),1000,1e22);
        (uint256 claimed,uint256 received,)=_claim(100,originalAmount);
        // Merkl->child fee: floor(A/100). Child->master fee:
        // floor((A-floor(A/100))/100), so caller gets LESS than returned.
        uint256 firstFee=originalAmount/100;
        uint256 secondFee=(originalAmount-firstFee)/100;
        assertEq(claimed,originalAmount-firstFee,"wrong observed child receipt");
        assertEq(received,claimed-secondFee,"wrong actual master receipt");
        assertGt(claimed,received,"under-delivery not reachable");
    }
    function test_zeroClaimReturnsZeroWithoutInventedMasterCredit() public {
        (uint256 claimed,uint256 received,)=_claim(100,0);
        assertEq(claimed,0);
        assertEq(received,0);
    }
}
