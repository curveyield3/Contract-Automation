// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import "../src/CurveYieldMorphoPositionModule_v13.sol";

interface V13Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function deal(address,uint256) external;
    function load(address,bytes32) external view returns(bytes32);
    function mockCall(address,bytes calldata,bytes calldata) external;
}
interface V13SafeSetup { function enableModule(address) external; }
interface V13Morpho is ICYMorpho {
    function createMarket(CYMarketParams calldata) external;
    function supply(CYMarketParams calldata,uint256,uint256,address,bytes calldata) external returns(uint256,uint256);
    function supplyCollateral(CYMarketParams calldata,uint256,address,bytes calldata) external;
    function borrow(CYMarketParams calldata,uint256,uint256,address,address) external returns(uint256,uint256);
}
interface V13Router is ICYSwapper {
    function routeFor(address,address) external view returns(bytes memory);
    function setRoute(address,address,bytes calldata) external;
    function twapMinimumOut(address,address,uint256) external view returns(uint256);
}
interface V13Primary is ICYPrimary {
    function setPolicy(uint256,uint256) external;
    function targetLtv() external view returns(uint256);
    function ltvOf() external view returns(uint256);
}
interface V13Weth is ICYToken {function deposit() external payable;}
interface V13Quoter {function quoteExactInput(bytes calldata,uint256) external returns(uint256,uint160[] memory,uint32[] memory,uint256);}
contract V13FixtureOracle {
    uint256 public immutable price;
    constructor(uint256 p){price=p;}
}

contract MorphoPositionModuleV13Fork {
    V13Vm private constant vm=V13Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant SAFE=0xF39087af2107EaDBf81f10a64051740A76B6291D;
    address private constant MORPHO=0xD50F2DffFd62f94Ee4AEd9ca05C61d0753268aBc;
    address private constant BUNDLER=0xA8C5e23C9C0DF2b6fF716486c6bBEBB6661548C8;
    address private constant ADAPTER=address(bytes20(hex"916aa175c36e845db45ff6ddb886ae437d403b61"));
    address private constant ROUTER=0x01F9894f92ea9224fECc8C35482E20a05De13582;
    address private constant PRIMARY=address(bytes20(hex"b0832afff2387edb89d799b967b49f910efc343d"));
    address private constant DAO=0x47623C62f281807D615eeb4A2CEee9d97F9D3C49;
    address private constant BOT=address(bytes20(hex"e7355a4fca376883fb775466ac8736c72ca19118"));
    address private constant WE=address(bytes20(hex"9893989433e7a383cb313953e4c2365107dc19a7"));
    address private constant W=0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62;
    address private constant US=0x2DCa96907fde857dd3D816880A0df407eeB2D2F2;
    address private constant UC=0x203A662b0BD271A6ed5a60EdFbd04bFce608FD36;
    address private constant KAT=0x7F1f4b4b29f5058fA32CC7a97141b8D7e5ABDC2d;
    address private constant AV=0x7231dbaCdFc968E07656D12389AB20De82FbfCeB;
    address private constant QUOTER=address(bytes20(hex"92dea23ed1c683940ff1a2f8fe23fe98c5d3041c"));
    bytes32 private constant WE_ID=0x0a8f3fd0965bfa6e94339cca629bec6ddac99f697ac74d808aa2d9f2c46b5f68;
    bytes32 private constant AV_ID=0x80e60fe453223b0f84a567724f88190bef708420d24397157067d424429783e9;
    uint256 private constant MAX=type(uint256).max;
    V13Morpho private constant mo=V13Morpho(MORPHO);
    V13Router private constant router=V13Router(ROUTER);
    V13Primary private constant primary=V13Primary(PRIMARY);
    CurveYieldMorphoPositionModule private mod;
    event log_named_uint(string key,uint256 value);
    event log_named_address(string key,address value);
    event log_string(string value);

    function setUp() public {
        require(block.chainid==747474,"NOT_KATANA");
        mod=new CurveYieldMorphoPositionModule(SAFE,MORPHO,BUNDLER,ADAPTER,ROUTER,AV_ID,PRIMARY);
        vm.startPrank(SAFE);
        V13SafeSetup(SAFE).enableModule(address(mod));
        mod.setExecutor(BOT,true);
        mod.setMarket(WE_ID,true);
        vm.stopPrank();
    }
    function _balance(address token,address who) private view returns(uint256){return ICYToken(token).balanceOf(who);}
    function _pos(bytes32 id) private view returns(uint256 shares,uint256 collateral){(,uint128 b,uint128 c)=mo.position(id,SAFE);return(b,c);}
    function _debt(bytes32 id,uint256 shares) private view returns(uint256){
        (,,uint128 a,uint128 s,,)=mo.market(id);
        return shares==0?0:1+(shares*(uint256(a)+1)-1)/(uint256(s)+1e6);
    }
    function _call(address to,bytes memory data) private pure returns(CYCall memory){return CYCall(to,data,0,false,bytes32(0));}
    function _approve(address token) private pure returns(CYCall memory){return _call(token,abi.encodeCall(ICYToken.approve,(ROUTER,MAX)));}
    function _swap(address a,address b,uint256 amount,address receiver) private view returns(CYCall memory){
        return _call(ROUTER,abi.encodeCall(ICYSwapper.swapExactInput,(a,b,amount,router.twapMinimumOut(a,b,amount),receiver,block.timestamp+600)));
    }
    function _quote(address a,address b,uint256 amount) private returns(uint256){
        bytes memory path=router.routeFor(a,b);
        require(path.length>0,"NO_ROUTE");
        (uint256 gross,,,)=V13Quoter(QUOTER).quoteExactInput(path,amount);
        bytes32 key=keccak256(abi.encode(a,b));
        uint256 fee=uint16(uint256(vm.load(ROUTER,bytes32(uint256(1))))>>160);
        if(uint256(vm.load(ROUTER,keccak256(abi.encode(key,uint256(4)))))!=0)
            fee=uint16(uint256(vm.load(ROUTER,keccak256(abi.encode(key,uint256(3))))));
        require(fee<=2000,"FEE_LAYOUT");
        return gross-gross*fee/10000;
    }
    function _bundle(bytes32 id,uint256 bps,bool existingRoutes) private returns(bytes memory data,uint256 debt,uint256 col,uint256 shares){
        CYMarketParams memory p=mo.idToMarketParams(id);
        mo.accrueInterest(p);
        (uint256 bs,uint256 c)=_pos(id);
        shares=bps==10000?bs:bs*bps/10000;
        col=bps==10000?c:c*bps/10000;
        debt=_debt(id,shares);
        require(debt>0&&col>0,"NO_POSITION");
        require(_balance(p.loanToken,ADAPTER)==0,"ADAPTER_LOAN_DUST_FIXTURE");
        CYCall[] memory nested=new CYCall[](existingRoutes?8:4);
        nested[0]=_call(ADAPTER,abi.encodeCall(ICYAdapter.morphoRepay,(p,0,shares,MAX,SAFE,bytes(""))));
        nested[1]=_call(ADAPTER,abi.encodeCall(ICYAdapter.morphoWithdrawCollateral,(p,col,BUNDLER)));
        nested[2]=_approve(p.collateralToken);
        if(existingRoutes){
            require(id==WE_ID,"WRONG_ROUTE_CASE");
            uint256 w=_quote(WE,W,col);uint256 u=_quote(W,UC,w);
            nested[3]=_swap(WE,W,col,BUNDLER);
            nested[4]=_approve(W);nested[5]=_swap(W,UC,w,BUNDLER);
            nested[6]=_approve(UC);nested[7]=_swap(UC,US,u,ADAPTER);
        }else{
            nested[3]=_swap(p.collateralToken,p.loanToken,col,ADAPTER);
        }
        bytes memory cb=abi.encode(nested);
        CYCall[] memory outer=new CYCall[](2);
        outer[0]=CYCall(ADAPTER,abi.encodeCall(ICYAdapter.morphoFlashLoan,(p.loanToken,debt,cb)),0,false,keccak256(cb));
        outer[1]=_call(ADAPTER,abi.encodeCall(ICYAdapter.erc20Transfer,(p.loanToken,SAFE,MAX)));
        data=abi.encodeCall(ICYBundler.multicall,(outer));
    }
    function _report(string memory label,bytes32 id) private{
        (uint256 b,uint256 c)=_pos(id);
        emit log_string(label);
        emit log_named_uint("borrowShares",b);
        emit log_named_uint("collateral",c);
        emit log_named_uint("debt",_debt(id,b));
        emit log_named_uint("avkatLtv",primary.ltvOf());
        emit log_named_uint("safeKAT",_balance(KAT,SAFE));
        emit log_named_uint("safeUSDT",_balance(US,SAFE));
        emit log_named_uint("safeUSDC",_balance(UC,SAFE));
    }
    function _standalone(bytes32 id,uint256 bps,bool existingRoutes) private {
        (uint256 beforeShares,uint256 beforeCol)=_pos(id);
        CYMarketParams memory p=mo.idToMarketParams(id);
        uint256 beforeLoan=_balance(p.loanToken,SAFE);
        (bytes memory data,uint256 debt,uint256 col,uint256 shares)=_bundle(id,bps,existingRoutes);
        emit log_named_uint("requestedDebtRepayment",debt);
        emit log_named_uint("requestedCollateralWithdrawal",col);
        _report("BEFORE",id);
        vm.prank(BOT);mod.execute(id,data,block.timestamp+600);
        (uint256 afterShares,uint256 afterCol)=_pos(id);
        require(afterShares==beforeShares-shares&&afterCol==beforeCol-col,"WRONG_SOURCE_DELTAS");
        require(_balance(p.loanToken,SAFE)>beforeLoan,"NO_NET_EQUITY");
        emit log_named_uint("extractedLoan",_balance(p.loanToken,SAFE)-beforeLoan);
        _report("AFTER",id);
    }
    function _loopData(uint256 cap,uint256 rate,bool both,bool bad) private view returns(bytes memory){
        ICYPrimary.PreSteps memory pre;
        pre.ranges=new ICYPrimary.RangeExit[](0);
        pre.vaults=new ICYPrimary.VaultExit[](0);
        pre.toKat=new ICYPrimary.Swap[](both?2:1);
        pre.toKat[0]=ICYPrimary.Swap(US,KAT,0);
        if(both)pre.toKat[1]=ICYPrimary.Swap(UC,KAT,0);
        ICYPrimary.LoopUp memory p=ICYPrimary.LoopUp(cap,0,bad?MAX:rate,0,block.timestamp+600);
        return abi.encodeCall(ICYPrimary.atomicLoopUp,(pre,p));
    }
    function _fixtureMarket(uint256 borrowAssets) private returns(bytes32 id){
        // Only the test contract's fork-only ETH is seeded. Actual WETH, vbUSDC,
        // router and Morpho are used. A distinct oracle identifies the fixture market.
        CYMarketParams memory orig=mo.idToMarketParams(WE_ID);
        vm.deal(address(this),0.06 ether);
        V13Weth(W).deposit{value:0.06 ether}();
        require(ICYToken(W).approve(ROUTER,MAX),"FIXTURE_ROUTER_APPROVAL");
        uint256 usdc=router.swapExactInput(W,UC,0.02 ether,router.twapMinimumOut(W,UC,0.02 ether),address(this),block.timestamp+600);
        CYMarketParams memory p=CYMarketParams(UC,W,address(new V13FixtureOracle(1600e24)),orig.irm,77e16);
        id=keccak256(abi.encode(p));mo.createMarket(p);
        require(ICYToken(UC).approve(MORPHO,MAX),"FIXTURE_LOAN_APPROVAL");
        mo.supply(p,usdc,0,address(this),"");
        require(ICYToken(W).transfer(SAFE,0.006 ether),"FIXTURE_COLLATERAL_TRANSFER");
        vm.startPrank(SAFE);
        require(ICYToken(W).approve(MORPHO,MAX),"FIXTURE_COLLATERAL_APPROVAL");
        mo.supplyCollateral(p,0.006 ether,SAFE,"");
        mo.borrow(p,borrowAssets,0,SAFE,address(this));
        mod.setMarket(id,true);
        vm.stopPrank();
        emit log_string("FORK_FIXTURE: WETH/vbUSDC with synthetic fixed oracle; actual Morpho and DEX");
    }
    function _migration(uint256 bps,uint256 cap,bool second,uint256 threshold,bool synthetic,bool rollback) private {
        bytes32 other;
        if(second)other=_fixtureMarket(4e6);
        // Configure desired production target only on the isolated fork for modeled discount cases.
        if(synthetic){
            vm.prank(SAFE);primary.setPolicy(767e15,500 ether);
        }
        CYMarketParams memory dp=mo.idToMarketParams(AV_ID);
        uint256 realPrice=ICYOracle(dp.oracle).price();
        uint256 rate=router.twapMinimumOut(KAT,AV,1 ether);
        if(synthetic){
            uint256 modeled=threshold+100;
            uint256 price=(1e54*10000+rate*(10000-modeled)-1)/(rate*(10000-modeled));
            vm.mockCall(dp.oracle,abi.encodeCall(ICYOracle.price,()),abi.encode(price));
            emit log_named_uint("syntheticDestinationOracle",price);
        }
        if(threshold!=0){
            uint256 price=ICYOracle(dp.oracle).price();
            rate=(1e54*10000+price*(10000-threshold)-1)/(price*(10000-threshold));
        }
        emit log_named_uint("actualDestinationOracle",realPrice);
        emit log_named_uint("thresholdBps",threshold);
        emit log_named_uint("requestedMaxFlashKAT",cap);
        emit log_named_uint("minAvkatPerKatWad",rate);
        CurveYieldMorphoPositionModule.SourceBundle[] memory bundles=new CurveYieldMorphoPositionModule.SourceBundle[](second?2:1);
        (uint256 b0,uint256 c0)=_pos(WE_ID);
        (bytes memory first,,uint256 col0,uint256 sh0)=_bundle(WE_ID,bps,true);
        bundles[0]=CurveYieldMorphoPositionModule.SourceBundle(WE_ID,first);
        uint256 b1;uint256 c1;uint256 col1;uint256 sh1;
        if(second){
            (b1,c1)=_pos(other);
            bytes memory secondData;
            (secondData,,col1,sh1)=_bundle(other,bps,false);
            bundles[1]=CurveYieldMorphoPositionModule.SourceBundle(other,secondData);
        }
        mo.accrueInterest(dp);
        (uint256 destB,uint256 destC)=_pos(AV_ID);
        uint256 destDebtBefore=_debt(AV_ID,destB);
        uint256 us0=_balance(US,SAFE);uint256 kat0=_balance(KAT,SAFE);uint256 uc0=_balance(UC,SAFE);
        _report("MIGRATION_BEFORE",WE_ID);
        bytes memory loopData=_loopData(cap,rate,second,rollback);
        vm.prank(BOT);
        (bool ok,bytes memory ret)=address(mod).call(abi.encodeCall(CurveYieldMorphoPositionModule.migrate,(bundles,loopData,block.timestamp+600)));
        if(rollback){
            require(!ok,"EXPECTED_DESTINATION_FAILURE");
            (uint256 b,uint256 c)=_pos(WE_ID);require(b==b0&&c==c0,"SOURCE_NOT_ROLLED_BACK");
            (b,c)=_pos(AV_ID);require(b==destB&&c==destC,"DEST_NOT_ROLLED_BACK");
            require(_balance(US,SAFE)==us0&&_balance(KAT,SAFE)==kat0&&_balance(UC,SAFE)==uc0,"BALANCES_NOT_ROLLED_BACK");
            return;
        }
        if(!ok){assembly ("memory-safe"){revert(add(ret,32),mload(ret))}}
        (uint256 b,uint256 c)=_pos(WE_ID);
        require(b==b0-sh0&&c==c0-col0,"SOURCE_WRONG_DELTA");
        if(second){(b,c)=_pos(other);require(b==b1-sh1&&c==c1-col1,"SECOND_SOURCE_WRONG_DELTA");}
        (b,c)=_pos(AV_ID);
        require(b>destB&&c>destC,"DESTINATION_DID_NOT_LOOP");
        require(primary.ltvOf()<=primary.targetLtv(),"DEST_LTV");
        emit log_named_uint("destinationDebtIncreaseKAT",_debt(AV_ID,b)-destDebtBefore);
        emit log_named_uint("destinationBorrowSharesIncrease",b-destB);
        emit log_named_uint("destinationCollateralIncrease",c-destC);
        _report("MIGRATION_AFTER",WE_ID);
    }
    function test_deployAndRegister() public {
        require(address(mod.SAFE())==SAFE&&mod.PRIMARY()==PRIMARY&&mod.marketAllowed(WE_ID)&&mod.isExecutor(BOT),"DEPLOY_CONFIG");
        emit log_named_address("forkDeployment",address(mod));
    }
    function test_liveWeETH_10pct() public {_standalone(WE_ID,1000,true);}
    function test_liveWeETH_25pct() public {_standalone(WE_ID,2500,true);}
    function test_liveWeETH_50pct() public {_standalone(WE_ID,5000,true);}
    function test_liveWeETH_full() public {_standalone(WE_ID,10000,true);}
    function test_fixtureWeth_25pct() public {_standalone(_fixtureMarket(4e6),2500,false);}
    function test_fixtureWeth_full() public {_standalone(_fixtureMarket(4e6),10000,false);}
    function test_fixtureWeth_highLtv_50pct() public {_standalone(_fixtureMarket(7360000),5000,false);}
    function test_fixtureWeth_highLtv_full() public {_standalone(_fixtureMarket(7360000),10000,false);}
    function test_migrate_10pct_1KAT() public {_migration(1000,1 ether,false,0,false,false);}
    function test_migrate_50pct_5KAT() public {_migration(5000,5 ether,false,0,false,false);}
    function test_migrate_full_20KAT() public {_migration(10000,20 ether,false,0,false,false);}
    function test_migrate_full_500KAT() public {_migration(10000,500 ether,false,0,false,false);}
    function test_migrate_target767_smallSeed_500KAT() public {
        vm.prank(SAFE);primary.setPolicy(767e15,500 ether);
        _migration(100,500 ether,false,0,false,false);
        require(primary.ltvOf()>=755e15&&primary.ltvOf()<=767e15,"TARGET_NOT_APPROACHED");
    }
    function test_migrate_twoMarkets_50pct_50KAT() public {_migration(5000,50 ether,true,0,false,false);}
    function test_modeled22pct_discount_tier21_50pct() public {_migration(5000,20 ether,false,2100,true,false);}
    function test_modeled24pct_discount_tier23_full() public {_migration(10000,100 ether,true,2300,true,false);}
    function test_atomicRollback_failedDestination() public {_migration(5000,5 ether,false,0,false,true);}
}
