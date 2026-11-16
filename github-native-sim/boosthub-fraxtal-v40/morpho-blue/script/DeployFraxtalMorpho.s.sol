// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {Morpho} from "../src/Morpho.sol";
import {MarketParams, Market, Id, IMorpho} from "../src/interfaces/IMorpho.sol";
import {CollateralYieldIRM} from "../src/fraxtal/CollateralYieldIRM.sol";
import {OmniRouterBeefyShareOracle, IV36BeefyShare} from "../src/fraxtal/OmniRouterBeefyShareOracle.sol";

/// @notice Fraxtal-only: unchanged Morpho Blue with one CurveYield collateral and three isolated debt markets.
contract DeployFraxtalMorpho is Script {
    uint256 internal constant FRAXTAL_ID = 252;
    address internal constant WFRAX = 0xFc00000000000000000000000000000000000002;
    address internal constant FRXUSD = 0xFc00000000000000000000000000000000000001;
    address internal constant SFRXUSD = 0xfc00000000000000000000000000000000000008;
    address internal constant ADMIN_AND_FEES = 0x47623C62f281807D615eeb4A2CEee9d97F9D3C49;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant MARKET_FEE = 0.15e18; // 15% of accrued borrowing interest; minted as supply shares

    function run() external {
        require(block.chainid == FRAXTAL_ID, "FRAXTAL_252_ONLY");
        uint256 key = vm.envUint("PRIVATE_KEY");
        address collateral = vm.envAddress("CYSDFXS_COLLATERAL");
        address router = vm.envAddress("OMNI_ROUTER");
        uint256 lltvW = vm.envUint("LLTV_WFRAX_WAD");
        uint256 lltvF = vm.envUint("LLTV_FRXUSD_WAD");
        uint256 lltvS = vm.envUint("LLTV_SFRXUSD_WAD");
        require(collateral.code.length != 0 && router.code.length != 0, "MISSING_VAULT_OR_ROUTER");
        require(WFRAX.code.length != 0 && FRXUSD.code.length != 0 && SFRXUSD.code.length != 0, "MISSING_LOAN_TOKENS");
        _checkLltv(lltvW); _checkLltv(lltvF); _checkLltv(lltvS);
        address want = IV36BeefyShare(collateral).want();
        require(want.code.length != 0, "WANT_MISSING");
        require(IV36BeefyShare(collateral).getPricePerFullShare() != 0, "ZERO_PPS");

        vm.startBroadcast(key);
        Morpho morpho = new Morpho(vm.addr(key));
        // Owner is explicitly the requested fee/admin address.
        CollateralYieldIRM irm = new CollateralYieldIRM(
            address(morpho), vm.addr(key), collateral,
            vm.envUint("FALLBACK_COLLATERAL_APR_WAD"),
            vm.envUint("MAX_COLLATERAL_APR_WAD"),
            vm.envUint("MAX_BORROW_APR_WAD")
        );
        OmniRouterBeefyShareOracle oracleW = new OmniRouterBeefyShareOracle(collateral, router, WFRAX);
        OmniRouterBeefyShareOracle oracleF = new OmniRouterBeefyShareOracle(collateral, router, FRXUSD);
        OmniRouterBeefyShareOracle oracleS = new OmniRouterBeefyShareOracle(collateral, router, SFRXUSD);
        // Do not proceed with a market deployment with incomplete on-chain oracle routes.
        require(oracleW.price() != 0 && oracleF.price() != 0 && oracleS.price() != 0, "MISSING_ORACLE_ROUTE");
        morpho.enableIrm(address(irm));
        morpho.enableLltv(lltvW);
        if (lltvF != lltvW) morpho.enableLltv(lltvF);
        if (lltvS != lltvW && lltvS != lltvF) morpho.enableLltv(lltvS);

        MarketParams memory w = _params(WFRAX, collateral, address(oracleW), address(irm), lltvW);
        MarketParams memory f = _params(FRXUSD, collateral, address(oracleF), address(irm), lltvF);
        MarketParams memory s = _params(SFRXUSD, collateral, address(oracleS), address(irm), lltvS);
        // Configure before createMarket: Morpho's createMarket initializes the IRM.
        _curve(irm, w, 30, 50, 110, 90, 0);
        _curve(irm, f, 20, 40, 120, 88, 0);
        _curve(irm, s, 20, 40, 120, 88, 400); // 400 bps = -4% absolute borrow APR

        morpho.setFeeRecipient(ADMIN_AND_FEES);
        morpho.createMarket(w); morpho.createMarket(f); morpho.createMarket(s);
        morpho.setFee(w, MARKET_FEE);
        morpho.setFee(f, MARKET_FEE);
        morpho.setFee(s, MARKET_FEE);
        require(morpho.feeRecipient() == ADMIN_AND_FEES, "BAD_FEE_RECIPIENT");
        require(IMorpho(address(morpho)).market(Id.wrap(_id(w))).fee == MARKET_FEE, "BAD_WFRAX_FEE");
        require(IMorpho(address(morpho)).market(Id.wrap(_id(f))).fee == MARKET_FEE, "BAD_FRXUSD_FEE");
        require(IMorpho(address(morpho)).market(Id.wrap(_id(s))).fee == MARKET_FEE, "BAD_SFRXUSD_FEE");
        irm.transferOwnership(ADMIN_AND_FEES);
        morpho.setOwner(ADMIN_AND_FEES);
        vm.stopBroadcast();
        console2.log("Morpho", address(morpho));
        console2.log("IRM", address(irm));
        console2.log("WFRAX market ID"); console2.logBytes32(_id(w));
        console2.log("frxUSD market ID"); console2.logBytes32(_id(f));
        console2.log("sfrxUSD market ID"); console2.logBytes32(_id(s));
        console2.log("Fee recipient", morpho.feeRecipient());
    }

    function _params(address loan, address collateral, address oracle, address irm, uint256 lltv)
        private pure returns (MarketParams memory)
    { return MarketParams(loan, collateral, oracle, irm, lltv); }

    function _curve(CollateralYieldIRM irm, MarketParams memory params, uint256 minimumPct, uint256 targetPct,
        uint256 maximumPct, uint256 targetUtilPct, uint256 rebateBps) private
    {
        // The curve values are 18-decimal fractions, so 110% = 1.10e18.
        irm.setCurve(params, CollateralYieldIRM.Curve({
            minimumMultiplier: minimumPct * WAD / 100,
            targetMultiplier: targetPct * WAD / 100,
            maximumMultiplier: maximumPct * WAD / 100,
            targetUtilization: targetUtilPct * WAD / 100,
            aprRebate: rebateBps * WAD / 10_000
        }));
    }

    function _checkLltv(uint256 value) private pure {
        require(value > 0 && value < WAD, "BAD_LLTV");
    }

    function _id(MarketParams memory params) private pure returns (bytes32) { return keccak256(abi.encode(params)); }
}
