// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import "../src/AVKAT_Consolidated_Safe_Module_v7.sol";

interface VmFork {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
}
interface ISafeSetup { function enableModule(address module) external; }
interface IRouteOwner {
    function setRoute(address tokenIn,address tokenOut,bytes calldata path) external;
    function routeFor(address tokenIn,address tokenOut) external view returns(bytes memory);
    function twapMinimumOut(address tokenIn,address tokenOut,uint256 amount) external view returns(uint256);
}
contract AVKATForkSimulationV1 {
    VmFork internal constant vm=VmFork(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant SAFE=0xf39087af2107eadbf81f10a64051740a76b6291d;
    address internal constant MORPHO=0xd50f2dfffd62f94ee4aed9ca05c61d0753268abc;
    address internal constant KAT=0x7f1f4b4b29f5058fa32cc7a97141b8d7e5abdc2d;
    address internal constant AVKAT=0x7231dbacdfc968e07656d12389ab20de82fbfceb;
    bytes32 internal constant MARKET=0x80e60fe453223b0f84a567724f88190bef708420d24397157067d424429783e9;
    address internal constant ROUTER=0x01f9894f92ea9224fecc8c35482e20a05de13582;
    address internal constant ROUTER_OWNER=0x47623c62f281807d615eeb4a2ceee9d97f9d3c49;
    address internal constant NPM=0x2659c6085d26144117d904c46b48b6d180393d27;
    address internal constant STAKER=0xbe12e1b5c4859a3d141412748279b67458f729e9;
    address internal constant CHARM=0xbc2ae38ce7127854b08ec5956f8a31547f6390ff;
    address internal constant U=0x203a662b0bd271a6ed5a60edfbd04bfce608fd36; // vbUSDC
    address internal constant T=0x2dca96907fde857dd3d816880a0df407eeb2d2f2; // vbUSDT
    address internal constant W=0x0913da6da4b42f538b445599b46bb4622342cf52; // vbWBTC
    address internal constant BOT=address(0xB071);
    uint256 internal constant NFT_STABLE=492499; // vbUSDC/vbUSDT 0.01%, staked for SAFE
    uint256 internal constant NFT_KAT=493397; // vbUSDC/KAT 0.05%, staked for SAFE
    uint256 internal constant NFT_EMPTY=493398;
    AVKATConsolidatedSafeModule internal mod;
    event log_named_uint(string name,uint256 value);
    event log_named_address(string name,address value);
    event log_string(string value);

    function setUp() public {
        require(block.chainid==747474,"FORK_CHAIN_NOT_KATANA");
        // All changes to the deployed router are made only inside this temporary fork.
        vm.startPrank(ROUTER_OWNER);
        IRouteOwner(ROUTER).setRoute(U,KAT,abi.encodePacked(U,uint24(500),KAT));
        IRouteOwner(ROUTER).setRoute(T,KAT,abi.encodePacked(T,uint24(100),U,uint24(500),KAT));
        IRouteOwner(ROUTER).setRoute(W,KAT,abi.encodePacked(W,uint24(500),U,uint24(500),KAT));
        vm.stopPrank();
        mod=new AVKATConsolidatedSafeModule(SAFE,MORPHO,KAT,AVKAT,MARKET);
        // Safe enabled-module config is changed only on this fork; live Safe is untouched.
        vm.prank(SAFE);
        ISafeSetup(SAFE).enableModule(address(mod));
        vm.startPrank(SAFE);
        mod.setExecutor(BOT,true);
        mod.configureVault(CHARM,1,true);
        mod.configureVault(AVKAT,2,true);
        mod.configureRange(1,NPM,STAKER,U,T,100,NFT_STABLE,0,65535,true);
        mod.configureRange(2,NPM,STAKER,U,KAT,500,NFT_KAT,0,65535,true);
        mod.configureRange(3,NPM,address(0),U,KAT,500,NFT_EMPTY,0,65535,true);
        vm.stopPrank();
    }
    function _bal(address token) internal view returns(uint256) {
        return IAvkatERC20(token).balanceOf(SAFE);
    }
    function _liq(uint256 tid) internal view returns(uint128 liquidity) {
        (,,,,,,,liquidity,,,,)=IAvkatPositionManager(NPM).positions(tid);
    }
    function _none() internal pure returns(AVKATConsolidatedSafeModule.Swap[] memory p) {
        p=new AVKATConsolidatedSafeModule.Swap[](0);
    }
    function _emptyPre() internal pure returns(AVKATConsolidatedSafeModule.PreSteps memory p) {
        p.ranges=new AVKATConsolidatedSafeModule.RangeExit[](0);
        p.vaults=new AVKATConsolidatedSafeModule.VaultExit[](0);
        p.toKat=_none();
    }
    function _bothWithCharm(bool full) internal view returns(AVKATConsolidatedSafeModule.PreSteps memory p) {
        uint128 a=_liq(NFT_STABLE),b=_liq(NFT_KAT);
        require(a>0&&b>0,"ACTIVE_NFT_LIQUIDITY_MISSING");
        uint256 shares=_bal(CHARM);
        require(shares>1,"CHARM_SHARES_MISSING");
        p.ranges=new AVKATConsolidatedSafeModule.RangeExit[](2);
        p.ranges[0]=AVKATConsolidatedSafeModule.RangeExit(1,full?type(uint128).max:a/2,0,0,false);
        p.ranges[1]=AVKATConsolidatedSafeModule.RangeExit(2,full?type(uint128).max:b/2,0,0,false);
        p.vaults=new AVKATConsolidatedSafeModule.VaultExit[](1);
        p.vaults[0]=AVKATConsolidatedSafeModule.VaultExit(CHARM,full?shares:shares/2,0,0);
        p.toKat=new AVKATConsolidatedSafeModule.Swap[](3);
        p.toKat[0]=AVKATConsolidatedSafeModule.Swap(U,KAT,0);
        p.toKat[1]=AVKATConsolidatedSafeModule.Swap(T,KAT,0);
        p.toKat[2]=AVKATConsolidatedSafeModule.Swap(W,KAT,0);
    }
    function _loopRequest() internal view returns(AVKATConsolidatedSafeModule.LoopUp memory p) {
        p=AVKATConsolidatedSafeModule.LoopUp({
            maxFlash:5 ether,
            minFlash:0,
            minAvkatPerKatWad:500000000000000000, // 0.5 avKAT/KAT enforced on actual output
            maxLtv:0,
            deadline:block.timestamp+3600
        });
    }
    function _reportState(string memory prefix) internal {
        emit log_named_uint(string.concat(prefix,"_KAT"),_bal(KAT));
        emit log_named_uint(string.concat(prefix,"_CHARM_SHARES"),_bal(CHARM));
        emit log_named_uint(string.concat(prefix,"_NFT_492499_LIQ"),_liq(NFT_STABLE));
        emit log_named_uint(string.concat(prefix,"_NFT_493397_LIQ"),_liq(NFT_KAT));
        emit log_named_uint(string.concat(prefix,"_MORPHO_LTV"),mod.ltvOf());
    }
    function test_deployment_ConstructorAndViews() public {
        require(address(mod.SAFE())==SAFE&&address(mod.MORPHO())==MORPHO,"CONSTRUCTOR_MISMATCH");
        require(mod.KAT()==KAT&&mod.AVKAT()==AVKAT&&mod.LOOP_MARKET()==MARKET,"MARKET_MISMATCH");
        require(mod.SWAPPER()==ROUTER&&mod.routerSwapFieldCount()==6&&mod.routerQuoteFieldCount()==3,"ROUTER_PROFILE_WRONG");
        require(mod.MAX_LTV()==769000000000000000,"MAX_LTV_WRONG");
        emit log_named_address("FORK_DEPLOYED_MODULE",address(mod));
        _reportState("INITIAL");
    }
    function test_router_OwnerInstallsThreeMissingRoutes() public {
        require(IRouteOwner(ROUTER).routeFor(U,KAT).length==43,"U_ROUTE_NOT_SET");
        require(IRouteOwner(ROUTER).routeFor(T,KAT).length==66,"T_ROUTE_NOT_SET");
        require(IRouteOwner(ROUTER).routeFor(W,KAT).length==66,"W_ROUTE_NOT_SET");
        require(IRouteOwner(ROUTER).twapMinimumOut(U,KAT,1e6)>0,"U_TWAP_NOT_WORKING");
        require(IRouteOwner(ROUTER).twapMinimumOut(KAT,AVKAT,1 ether)>0,"AVKAT_TWAP_NOT_WORKING");
        emit log_string("Router routes installed by fork-impersonated onchain owner; not written to live Katana");
    }
    function test_configuration_setExecutor() public {
        vm.prank(SAFE);mod.setExecutor(BOT,false);
        require(!mod.isExecutor(BOT),"EXECUTOR_NOT_REMOVED");
        vm.prank(SAFE);mod.setExecutor(BOT,true);
        require(mod.isExecutor(BOT),"EXECUTOR_NOT_REINSTATED");
    }
    function test_configuration_setPolicy() public {
        vm.prank(SAFE);mod.setPolicy(700000000000000000,20 ether);
        require(mod.targetLtv()==700000000000000000&&mod.maxFlashKat()==20 ether,"POLICY_NOT_APPLIED");
    }
    function test_configuration_setSwapper() public {
        AVKATConsolidatedSafeModule.RouterField[] memory a=new AVKATConsolidatedSafeModule.RouterField[](6);
        a[0]=AVKATConsolidatedSafeModule.RouterField(1,0);
        a[1]=AVKATConsolidatedSafeModule.RouterField(2,0);
        a[2]=AVKATConsolidatedSafeModule.RouterField(3,0);
        a[3]=AVKATConsolidatedSafeModule.RouterField(0,0);
        a[4]=AVKATConsolidatedSafeModule.RouterField(5,0);
        a[5]=AVKATConsolidatedSafeModule.RouterField(6,0);
        AVKATConsolidatedSafeModule.RouterField[] memory q=new AVKATConsolidatedSafeModule.RouterField[](3);
        q[0]=AVKATConsolidatedSafeModule.RouterField(1,0);
        q[1]=AVKATConsolidatedSafeModule.RouterField(2,0);
        q[2]=AVKATConsolidatedSafeModule.RouterField(3,0);
        vm.prank(SAFE);
        mod.setSwapper(ROUTER,bytes4(keccak256("swapExactInput(address,address,uint256,uint256,address,uint256)")),
            a,bytes4(keccak256("twapMinimumOut(address,address,uint256)")),q,0,300);
        require(mod.SWAPPER()==ROUTER&&mod.routerSwapFieldCount()==6,"SET_SWAP_FAILED");
    }
    function test_configuration_configureVaultAndRange() public {
        (uint8 kind,address x,address y,bool on)=mod.vaults(CHARM);
        require(kind==1&&x==W&&y==U&&on,"CHARM_VAULT_CONFIG_WRONG");
        (kind,x,y,on)=mod.vaults(AVKAT);
        require(kind==2&&x==KAT&&on,"ERC4626_VAULT_CONFIG_WRONG");
        (address npm,address staker,address token0,address token1,uint24 fee,uint256 tid,,,,,,bool enabled)=mod.ranges(1);
        require(npm==NPM&&staker==STAKER&&token0==U&&token1==T&&fee==100&&tid==NFT_STABLE&&enabled,
            "NFT_RANGE_CONFIG_WRONG");
    }
    function test_authorization_OnlySafeConfigAndOnlyExecutor() public {
        vm.prank(BOT);
        (bool ok,)=address(mod).call(abi.encodeCall(AVKATConsolidatedSafeModule.setPolicy,(1,1)));
        require(!ok,"BOT_CHANGED_POLICY");
        vm.prank(address(0xBADA));
        (ok,)=address(mod).call(abi.encodeCall(AVKATConsolidatedSafeModule.withdrawVault,(CHARM,1,0,0)));
        require(!ok,"UNAUTHORIZED_WITHDRAW_SUCCEEDED");
    }
    function test_flashCallback_RejectsUnsolicitedCalls() public {
        vm.prank(BOT);
        (bool ok,)=address(mod).call(abi.encodeCall(AVKATConsolidatedSafeModule.onMorphoFlashLoan,(1,bytes(""))));
        require(!ok,"UNSOLICITED_CALLBACK_SUCCEEDED");
    }
    function test_executeApprovedSwaps_USDCtoKAT() public {
        uint256 start=_bal(KAT);
        require(_bal(U)>=1e6,"SAFE_HAS_NO_USDC_FOR_SWAP");
        AVKATConsolidatedSafeModule.Swap[] memory sw=new AVKATConsolidatedSafeModule.Swap[](1);
        sw[0]=AVKATConsolidatedSafeModule.Swap(U,KAT,1e6);
        vm.prank(BOT);mod.executeApprovedSwaps(sw);
        require(_bal(KAT)>start,"SWAP_DID_NOT_RECEIVE_KAT");
    }
    function test_withdrawVault_CharmHalf() public {
        uint256 s=_bal(CHARM);require(s>1,"CHARM_BALANCE_ZERO");
        vm.prank(BOT);mod.withdrawVault(CHARM,s/2,0,0);
        require(_bal(CHARM)==s-s/2,"WRONG_HALF_WITHDRAW_SHARES");
        emit log_named_uint("CHARM_HALF_SHARES_BURNED",s/2);
    }
    function test_withdrawVault_CharmFull() public {
        uint256 s=_bal(CHARM);require(s>0,"CHARM_BALANCE_ZERO");
        vm.prank(BOT);mod.withdrawVault(CHARM,0,0,0);
        require(_bal(CHARM)==0,"CHARM_FULL_WITHDRAW_REMAINS");
        emit log_named_uint("CHARM_FULL_SHARES_BURNED",s);
    }
    function test_depositVault_CharmProportional() public {
        uint256 s=_bal(CHARM);require(s>1,"CHARM_BALANCE_ZERO");
        vm.prank(BOT);mod.withdrawVault(CHARM,s/2,0,0);
        uint256 before=_bal(CHARM),w=_bal(W),u=_bal(U);
        require(w>0&&u>0,"CHARM_TOKENS_NOT_RECEIVED");
        vm.prank(BOT);mod.depositVault(CHARM,w,u,0,0,1,_none());
        require(_bal(CHARM)>before,"CHARM_SHARES_NOT_MINTED");
    }
    function test_depositVault_ERC4626Avkat() public {
        require(_bal(KAT)>1 ether,"SAFE_KAT_BALANCE_LOW");
        uint256 before=_bal(AVKAT);
        vm.prank(BOT);mod.depositVault(AVKAT,1 ether,0,0,0,1,_none());
        require(_bal(AVKAT)>before,"AVKAT_SHARES_NOT_MINTED");
    }
    function test_withdrawVault_ERC4626Avkat() public {
        vm.prank(BOT);mod.depositVault(AVKAT,1 ether,0,0,0,1,_none());
        uint256 s=_bal(AVKAT);require(s>0,"AVKAT_DEPOSIT_ZERO");
        vm.prank(BOT);mod.withdrawVault(AVKAT,s/2,0,0);
        require(_bal(AVKAT)==s-s/2,"AVKAT_REDEEM_SHARES_WRONG");
    }
    function test_withdrawRange_NFT492499_Half() public {
        uint128 before=_liq(NFT_STABLE);require(before>1,"NFT_STABLE_EMPTY");
        vm.prank(BOT);mod.withdrawRange(1,before/2,0,0,false);
        require(_liq(NFT_STABLE)==before-before/2,"NFT_STABLE_HALF_WRONG");
    }
    function test_withdrawRange_NFT493397_Half() public {
        uint128 before=_liq(NFT_KAT);require(before>1,"NFT_KAT_EMPTY");
        vm.prank(BOT);mod.withdrawRange(2,before/2,0,0,false);
        require(_liq(NFT_KAT)==before-before/2,"NFT_KAT_HALF_WRONG");
    }
    function test_withdrawRange_NFT492499_Full() public {
        require(_liq(NFT_STABLE)>0,"NFT_STABLE_EMPTY");
        vm.prank(BOT);mod.withdrawRange(1,type(uint128).max,0,0,false);
        require(_liq(NFT_STABLE)==0,"NFT_STABLE_FULL_WRONG");
    }
    function test_withdrawRange_NFT493397_Full() public {
        require(_liq(NFT_KAT)>0,"NFT_KAT_EMPTY");
        vm.prank(BOT);mod.withdrawRange(2,type(uint128).max,0,0,false);
        require(_liq(NFT_KAT)==0,"NFT_KAT_FULL_WRONG");
    }
    function test_addRangeLiquidity_NFT492499() public {
        uint128 before=_liq(NFT_STABLE);require(before>1,"NFT_STABLE_EMPTY");
        vm.prank(BOT);mod.withdrawRange(1,before/2,0,0,false);
        uint128 afterExit=_liq(NFT_STABLE);
        uint256 u=_bal(U),t=_bal(T);require(u>0&&t>0,"NO_STABLE_ASSETS_FOR_ADD");
        vm.prank(BOT);mod.addRangeLiquidity(1,u,t,0,0,block.timestamp+3600,_none());
        require(_liq(NFT_STABLE)>afterExit,"NFT_ADD_NOT_MINTED");
    }
    function test_createRangeLiquidity_EmptyNftReplacement() public {
        require(_liq(NFT_EMPTY)==0,"EXPECTED_EMPTY_NFT");
        vm.prank(BOT);mod.withdrawRange(3,type(uint128).max,0,0,true);
        require(_bal(U)>5e6&&_bal(KAT)>5 ether,"SAFE_HAS_INSUFFICIENT_MINT_ASSETS");
        AVKATConsolidatedSafeModule.MintSpec memory s=
            AVKATConsolidatedSafeModule.MintSpec(331370,333000,5e6,5 ether,0,0,block.timestamp+3600);
        vm.prank(BOT);uint256 tid=mod.createRangeLiquidity(3,s,_none());
        require(tid!=0&&_liq(tid)>0,"NFT_MINT_FAILED");
        emit log_named_uint("NEW_NFT_ID",tid);
    }
    function test_rebalanceRange_NFT492499() public {
        AVKATConsolidatedSafeModule.MintSpec memory s=
            AVKATConsolidatedSafeModule.MintSpec(7,8,_bal(U),_bal(T),0,0,block.timestamp+3600);
        vm.prank(BOT);uint256 tid=mod.rebalanceRange(1,0,0,_none(),s);
        require(tid!=0&&tid!=NFT_STABLE&&_liq(tid)>0,"REBALANCE_DID_NOT_MINT");
        emit log_named_uint("REBALANCED_NFT_ID",tid);
    }
    function test_deleverageWithSafeKat_ExistingSafeKAT() public {
        uint256 before=_bal(KAT);require(before>1 ether,"SAFE_KAT_EMPTY");
        vm.prank(BOT);uint256 repaid=mod.deleverageWithSafeKat(1 ether);
        require(repaid>0&&repaid<=1 ether&&_bal(KAT)<before,"KAT_REPAYMENT_INCORRECT");
        emit log_named_uint("SAFE_KAT_REPAID",repaid);
    }
    function test_atomicDeleverage_RealMorphoPosition() public {
        (,,uint128 collateral)=IAvkatMorpho(MORPHO).position(MARKET,SAFE);
        require(collateral>0,"NO_EXISTING_COLLATERAL");
        AVKATConsolidatedSafeModule.Deloop memory p=
            AVKATConsolidatedSafeModule.Deloop({
                maxFlash:200 ether,
                avkatToSell:uint256(collateral)*95/100,
                maxSafeKatContribution:10 ether,
                keepKat:0,
                minSaleKat:1 ether,
                maxLtv:0,
                deadline:block.timestamp+3600
            });
        vm.prank(BOT);mod.atomicDeleverage(_emptyPre(),p);
        require(mod.ltvOf()<=mod.targetLtv(),"DELOOP_LTV_EXCEEDED");
    }
    function test_atomicLoopUp_HalfCharmAndBothActiveNFTs() public {
        uint128 a=_liq(NFT_STABLE),b=_liq(NFT_KAT);
        uint256 shares=_bal(CHARM);require(a>1&&b>1&&shares>1,"MISSING_HALF_LIQUIDITY");
        _reportState("HALF_BEFORE");
        vm.prank(BOT);mod.atomicLoopUp(_bothWithCharm(false),_loopRequest());
        require(_liq(NFT_STABLE)==a-a/2,"HALF_STABLE_NFT_NOT_WITHDRAWN");
        require(_liq(NFT_KAT)==b-b/2,"HALF_KAT_NFT_NOT_WITHDRAWN");
        require(_bal(CHARM)==shares-shares/2,"HALF_CHARM_NOT_WITHDRAWN");
        require(mod.ltvOf()<=mod.targetLtv(),"HALF_LOOP_LTV_TOO_HIGH");
        _reportState("HALF_AFTER");
    }
    function test_atomicLoopUp_FullCharmAndBothActiveNFTs() public {
        uint128 a=_liq(NFT_STABLE),b=_liq(NFT_KAT);
        uint256 shares=_bal(CHARM);require(a>0&&b>0&&shares>0,"MISSING_FULL_LIQUIDITY");
        _reportState("FULL_BEFORE");
        vm.prank(BOT);mod.atomicLoopUp(_bothWithCharm(true),_loopRequest());
        require(_liq(NFT_STABLE)==0&&_liq(NFT_KAT)==0,"FULL_NFT_NOT_WITHDRAWN");
        require(_bal(CHARM)==0,"FULL_CHARM_NOT_WITHDRAWN");
        require(mod.ltvOf()<=mod.targetLtv(),"FULL_LOOP_LTV_TOO_HIGH");
        _reportState("FULL_AFTER");
    }
    function test_atomicLoopUp_RejectsMissingMandatoryRate() public {
        AVKATConsolidatedSafeModule.LoopUp memory p=_loopRequest();p.minAvkatPerKatWad=0;
        vm.prank(BOT);
        (bool ok,)=address(mod).call(abi.encodeCall(AVKATConsolidatedSafeModule.atomicLoopUp,(_emptyPre(),p)));
        require(!ok,"ZERO_MIN_RATE_WAS_ACCEPTED");
    }
}
