pragma solidity =0.5.12;

// DAI source-bound audit controls. This suite ATTACHES to the existing
// Ethereum deployed address on a pinned local mutable Anvil fork. It NEVER
// deploys Dai or sends transactions to mainnet.
interface VmForkDAI {
    function prank(address) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
}
interface ILiveDai {
    function wards(address) external view returns (uint256);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function PERMIT_TYPEHASH() external view returns (bytes32);
    function balanceOf(address) external view returns (uint256);
    function allowance(address,address) external view returns (uint256);
    function nonces(address) external view returns (uint256);
    function rely(address) external;
    function deny(address) external;
    function mint(address,uint256) external;
    function burn(address,uint256) external;
    function transfer(address,uint256) external returns(bool);
    function transferFrom(address,address,uint256) external returns(bool);
    function approve(address,uint256) external returns(bool);
    function permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32) external;
}
contract DAILiveForkSecurityV1 {
    VmForkDAI constant vm = VmForkDAI(address(uint160(uint256(keccak256("hevm cheat code")))));
    ILiveDai constant D = ILiveDai(0x6B175474E89094C44Da98b954EedeAC495271d0F);
    address constant WARD = 0x9759A6Ac90977b93B58547b4A71c78317f391A28;
    address constant ALICE = address(0xA11ce);
    address constant BOB = address(0xB0B);
    address constant CAROL = address(0xCA401);
    address constant ATTACKER = address(0xBEEF);
    uint256 constant HOLDER_PK = 0xA110CE;
    uint256 constant OTHER_PK = 0xBADF00D;
    uint256 constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function setUp() public {
        require(D.wards(WARD) == 1, "PIN_OR_WARD_INCORRECT");
        require(D.decimals() == 18, "DECIMALS_DRIFT");
    }

    function _invoke(address from, bytes memory callData) internal returns (bool) {
        vm.prank(from);
        (bool ok,) = address(D).call(callData);
        return ok;
    }

    function _digest(address holder,address spender,uint nonce,uint expiry,bool allowed,bytes32 domain)
      internal view returns(bytes32) {
        bytes32 structHash = keccak256(abi.encode(D.PERMIT_TYPEHASH(), holder, spender, nonce, expiry, allowed));
        return keccak256(abi.encodePacked(bytes2(0x1901),domain,structHash));
    }

    function test_prop_BOB_0001_wardPermissionMatrix() public {
        require(!_invoke(ATTACKER,abi.encodeWithSignature("mint(address,uint256)",ALICE,1)), "ATTACKER_MINTED");
        require(!_invoke(ATTACKER,abi.encodeWithSignature("rely(address)",ATTACKER)), "ATTACKER_RELIED");
        require(!_invoke(ATTACKER,abi.encodeWithSignature("deny(address)",WARD)), "ATTACKER_DENIED");
        require(_invoke(WARD,abi.encodeWithSignature("rely(address)",ATTACKER)), "WARD_RELY_FAILED");
        require(D.wards(ATTACKER)==1, "RELY_NOT_APPLIED");
        require(_invoke(ATTACKER,abi.encodeWithSignature("mint(address,uint256)",ALICE,1)), "NEW_WARD_MINT_FAILED");
        require(_invoke(WARD,abi.encodeWithSignature("deny(address)",ATTACKER)), "WARD_DENY_FAILED");
        require(D.wards(ATTACKER)==0, "REVOKED_WARD_STILL_ACTIVE");
        require(!_invoke(ATTACKER,abi.encodeWithSignature("mint(address,uint256)",ALICE,1)), "REVOKED_WARD_MINTED");
    }

    function test_prop_BOB_0002_ledgerConservation() public {
        uint initialSupply=D.totalSupply();
        uint initialAlice=D.balanceOf(ALICE);
        uint initialBob=D.balanceOf(BOB);
        require(_invoke(WARD,abi.encodeWithSignature("mint(address,uint256)",ALICE,1000)), "WARD_MINT_FAILED");
        require(D.totalSupply()==initialSupply+1000 && D.balanceOf(ALICE)==initialAlice+1000,"MINT_CONSERVATION");
        require(_invoke(ALICE,abi.encodeWithSignature("transfer(address,uint256)",BOB,350)), "TRANSFER_FAILED");
        require(D.totalSupply()==initialSupply+1000 && D.balanceOf(ALICE)==initialAlice+650
          && D.balanceOf(BOB)==initialBob+350, "TRANSFER_CONSERVATION");
        require(_invoke(BOB,abi.encodeWithSignature("burn(address,uint256)",BOB,100)), "BURN_FAILED");
        require(D.totalSupply()==initialSupply+900 && D.balanceOf(BOB)==initialBob+250,"BURN_CONSERVATION");
        require(!_invoke(ATTACKER,abi.encodeWithSignature("transferFrom(address,address,uint256)",ALICE,ATTACKER,999)), "ATTACKER_SPENT_NO_ALLOWANCE");
    }

    function test_prop_BOB_0003_deployedConfiguration() public {
        // Exact historical observations from PHASE_04_ONCHAIN_READONLY_v1.
        require(D.DOMAIN_SEPARATOR()==0xdbb8cf42e1ecb028be3f3dbc922e1d878b963f411dc388ced501601c60f7c6f7,"DOMAIN_DRIFT");
        require(D.PERMIT_TYPEHASH()==0xea2aa0a1be11a07ed86d755c93467f4f82362b452371d1ba94d1715123511acb,"PERMIT_TYPE_DRIFT");
        require(D.totalSupply()==4536529357206555811266503939,"HISTORICAL_SUPPLY_DRIFT");
        require(D.wards(WARD)==1,"PINNED_WARD_DRIFT");
    }

    function test_prop_BOB_0004_unauthorizedMintAndHealthyControl() public {
        uint supply=D.totalSupply();
        require(!_invoke(ATTACKER,abi.encodeWithSignature("mint(address,uint256)",ATTACKER,1)), "UNAUTHORIZED_MINT");
        require(D.totalSupply()==supply,"FAILED_MINT_CHANGED_SUPPLY");
        require(_invoke(WARD,abi.encodeWithSignature("mint(address,uint256)",ATTACKER,1)), "AUTHORIZED_MINT_FAILED");
        require(D.totalSupply()==supply+1,"AUTHORIZED_MINT_NOT_ACCOUNTED");
    }

    function test_prop_BOB_0005_identityAndAllowancePartition() public {
        uint nonceAlice=D.nonces(ALICE);
        uint nonceBob=D.nonces(BOB);
        require(_invoke(ALICE,abi.encodeWithSignature("approve(address,uint256)",BOB,7)), "APPROVAL_FAILED");
        require(D.allowance(ALICE,BOB)==7,"OWNER_SPENDER_KEY_BAD");
        require(D.allowance(ALICE,CAROL)==0 && D.allowance(BOB,ALICE)==0,"IDENTITY_ALIASING");
        require(D.nonces(ALICE)==nonceAlice && D.nonces(BOB)==nonceBob,"APPROVE_CHANGED_NONCE");
    }

    function test_prop_BOB_0007_permitReplayExpiryAndDomain() public {
        address holder=vm.addr(HOLDER_PK);
        address spender=BOB;
        uint nonce=D.nonces(holder);
        bytes32 domain=D.DOMAIN_SEPARATOR();
        bytes32 valid=_digest(holder,spender,nonce,0,true,domain);
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(HOLDER_PK,valid);
        require(_invoke(CAROL,abi.encodeWithSignature("permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)",
          holder,spender,nonce,0,true,v,r,s)), "VALID_PERMIT_REJECTED");
        require(D.nonces(holder)==nonce+1 && D.allowance(holder,spender)==uint(-1),"VALID_PERMIT_STATE_WRONG");
        require(!_invoke(CAROL,abi.encodeWithSignature("permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)",
          holder,spender,nonce,0,true,v,r,s)), "REPLAY_ACCEPTED");
        uint8 twinV=v==27?28:27;
        bytes32 twinS=bytes32(SECP256K1_N-uint256(s));
        require(!_invoke(CAROL,abi.encodeWithSignature("permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)",
          holder,spender,nonce,0,true,twinV,r,twinS)), "MALLEATED_REPLAY_ACCEPTED");
        (v,r,s)=vm.sign(HOLDER_PK,_digest(holder,spender,nonce+1,1,true,domain));
        require(!_invoke(CAROL,abi.encodeWithSignature("permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)",
          holder,spender,nonce+1,1,true,v,r,s)), "EXPIRED_PERMIT_ACCEPTED");
        (v,r,s)=vm.sign(HOLDER_PK,_digest(holder,spender,nonce+1,0,true,bytes32(uint256(domain)+1)));
        require(!_invoke(CAROL,abi.encodeWithSignature("permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)",
          holder,spender,nonce+1,0,true,v,r,s)), "WRONG_DOMAIN_ACCEPTED");
        (v,r,s)=vm.sign(OTHER_PK,_digest(holder,spender,nonce+1,0,true,domain));
        require(!_invoke(CAROL,abi.encodeWithSignature("permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)",
          holder,spender,nonce+1,0,true,v,r,s)), "OTHER_SIGNER_ACCEPTED");
        (v,r,s)=vm.sign(HOLDER_PK,_digest(holder,spender,nonce+1,0,true,domain));
        require(!_invoke(CAROL,abi.encodeWithSignature("permit(address,address,uint256,uint256,bool,uint8,bytes32,bytes32)",
          holder,CAROL,nonce+1,0,true,v,r,s)), "SPENDER_MUTATION_ACCEPTED");
        require(D.nonces(holder)==nonce+1,"NEGATIVE_PERMIT_CHANGED_NONCE");
    }

    function test_prop_BOB_0008_stateTransitions() public {
        uint supply=D.totalSupply();
        require(_invoke(WARD,abi.encodeWithSignature("mint(address,uint256)",ALICE,30)), "SEED_FAILED");
        require(_invoke(ALICE,abi.encodeWithSignature("approve(address,uint256)",BOB,15)), "SEED_APPROVE_FAILED");
        require(_invoke(BOB,abi.encodeWithSignature("transferFrom(address,address,uint256)",ALICE,CAROL,7)), "AUTHORIZED_SPEND_FAILED");
        require(D.allowance(ALICE,BOB)==8,"ALLOWANCE_NOT_DECREMENTED");
        require(_invoke(BOB,abi.encodeWithSignature("burn(address,uint256)",ALICE,8)), "AUTHORIZED_BURN_FAILED");
        require(D.allowance(ALICE,BOB)==0,"BURN_ALLOWANCE_NOT_SPENT");
        require(!_invoke(BOB,abi.encodeWithSignature("transferFrom(address,address,uint256)",ALICE,CAROL,1)), "EXHAUSTED_ALLOWANCE_BYPASS");
        require(D.totalSupply()==supply+22,"SEQUENCE_SUPPLY_BAD");
    }
}
