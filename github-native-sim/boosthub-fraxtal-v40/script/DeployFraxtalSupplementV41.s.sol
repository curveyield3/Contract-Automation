// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Fraxtal-only supplemental deployment: reuses the EXISTING BoostHub and
// OmniRouter; does not redeploy or reconfigure either one.
import {BaseAllToWantBoostHubV5} from "../contracts/BaseAllToWantBoostHubV5.sol";
import {StrategyConvexBoostHubStakingV5} from "../contracts/StrategyConvexBoostHubStakingV5.sol";
import {BeefyVaultV7FixedV2} from "../contracts/BeefyVaultV7FixedV2.sol";
import {IStrategyBoostHubV1} from "../contracts/interfaces/IStrategyBoostHubV1.sol";
import {CurveYieldOmniRouter} from "../contracts/CurveYieldOmniRouter.sol";

interface VmV40 {
    function readFile(string calldata) external view returns (string memory);
    function parseJsonBytes(string calldata, string calldata) external pure returns (bytes memory);
    function parseJsonString(string calldata, string calldata) external pure returns (string memory);
    function parseJsonBytes32(string calldata, string calldata) external pure returns (bytes32);
    function getNonce(address) external view returns (uint64);
    function computeCreateAddress(address, uint256) external pure returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
}
interface IBoostHubV40 {
    function owner() external view returns (address);
    function isApprovedDepositor(uint256,address) external view returns (bool);
    function setApprovedDepositors(uint256,address[] calldata,bool[] calldata,bool) external;
}
interface IStakingV40 {
    function lp_token() external view returns (address);
    function boost_hub() external view returns (address);
    function pid() external view returns (uint256);
    function admin() external view returns (address);
    function fee_receiver() external view returns (address);
    function reward_smoothing_units() external view returns (uint256);
}

contract DeployFraxtalSupplementV41 {
    VmV40 private constant vm = VmV40(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant HUB = 0x40f7085841034f752F17592875703EB5032f2B42;
    // Existing router deliberately excluded; this deployment creates and owns its own router.
    address private constant SDFXS_WFRAX_POOL = 0x3df1658e3E76d14eF3C4d410829EA7575bB83B9B;
    address private constant WFRAX_FRXUSD_TRICRYPTO = 0xa0D3911349e701A1F49C1Ba2dDA34b4ce9636569;
    address private constant FRXUSD_SFRXUSD_STABLE = 0x1aB35116c3FA0B2F507d8C8C3261d42683c1e31e;
    address private constant SFRXUSD_RATE_READER = 0xBFc4D34Db83553725eC6c768da71D2D9c1456B55;
    address private constant FRXUSD = 0xFc00000000000000000000000000000000000001;
    address private constant SFRXUSD = 0xfc00000000000000000000000000000000000008;
    address private constant SDFXS = 0x1AEe2382e05Dc68BDfC472F1E46d570feCca5814;
    address private constant WFRAX = 0xFc00000000000000000000000000000000000002;
    address private constant DEPLOYER = 0x064256591313eEb86a84A5CbCc4C6460791B96DD;
    address private constant ADMIN_AND_FEES = 0x47623C62f281807D615eeb4A2CEee9d97F9D3C49;
    uint256 private constant PID = 0;

    event NewRouter(address indexed router);
    event NewStaking(address indexed staking);
    event NewStrategyVault(address indexed strategy, address indexed vault);

    // Exact pool/oracle setup, matched to on-chain pool coins and their read interfaces.
    // Router price_oracle reports output whole-tokens per input whole-token (1e18).
    function _hop(
        uint16 poolType, address tokenOut, address pool, uint8 indexIn, uint8 indexOut,
        address oracle, bytes4 selector, bytes memory oracleInputs, bool invert
    ) private pure returns (CurveYieldOmniRouter.SimpleHop memory) {
        return CurveYieldOmniRouter.SimpleHop({
            poolType: poolType, tokenOut: tokenOut, swapContract: pool,
            poolId: bytes32(0), poolData: abi.encode(indexIn,indexOut),
            oracle: CurveYieldOmniRouter.SimpleOracle({
                oracleAddress: oracle, readFunctionID: selector, requiredInputs: oracleInputs,
                invert: invert, rateDecimals: 18
            })
        });
    }

    function _configureRoutes(CurveYieldOmniRouter router) private {
        bytes4 curvePrice = bytes4(keccak256("price_oracle(uint256)"));
        bytes4 sharesForAssets = bytes4(keccak256("convertToShares(uint256)"));
        // Preserve the exact legacy sdFXS/WFRAX execution route and inverse oracle direction.
        CurveYieldOmniRouter.SimpleHop memory a = _hop(
            6,WFRAX,SDFXS_WFRAX_POOL,1,0,SDFXS_WFRAX_POOL,curvePrice,abi.encode(uint256(0)),false
        );
        CurveYieldOmniRouter.SimpleHop memory b = _hop(
            6,SDFXS,SDFXS_WFRAX_POOL,0,1,SDFXS_WFRAX_POOL,curvePrice,abi.encode(uint256(0)),true
        );
        // TriCrypto FRXUSD/wfrxETH/WFRAX: WFRAX index 2, frxUSD index 0.
        // price_oracle(1) quotes frxUSD per WFRAX, NOT the wfrxETH price.
        CurveYieldOmniRouter.SimpleHop memory c = _hop(
            5,FRXUSD,WFRAX_FRXUSD_TRICRYPTO,2,0,
            WFRAX_FRXUSD_TRICRYPTO,curvePrice,abi.encode(uint256(1)),false
        );
        // StableSwap NG frxUSD (index 0) / sfrxUSD (index 1).
        // Historical oracle is the mint-redeemer's *share* conversion (sfrxUSD per frxUSD),
        // independent of the very low pool liquidity. Requires fresh mint-redeemer oracle upkeep.
        CurveYieldOmniRouter.SimpleHop memory d = _hop(
            6,SFRXUSD,FRXUSD_SFRXUSD_STABLE,0,1,
            SFRXUSD_RATE_READER,sharesForAssets,abi.encode(uint256(1e18)),false
        );
        CurveYieldOmniRouter.SimpleHop[] memory path = new CurveYieldOmniRouter.SimpleHop[](1);
        path[0]=a; router.setRoute(SDFXS,WFRAX,path);
        path[0]=b; router.setRoute(WFRAX,SDFXS,path); // harvest needs this inverse route
        path[0]=c; router.setRoute(WFRAX,FRXUSD,path);
        path[0]=d; router.setRoute(FRXUSD,SFRXUSD,path);
        path = new CurveYieldOmniRouter.SimpleHop[](2);
        path[0]=a; path[1]=c; router.setRoute(SDFXS,FRXUSD,path);
        path = new CurveYieldOmniRouter.SimpleHop[](3);
        path[0]=a; path[1]=c; path[2]=d; router.setRoute(SDFXS,SFRXUSD,path);
    }

    function run() external returns (address routerAddress, address staking, address strategy, address vault) {
        require(block.chainid == 252, "FRAXTAL_ONLY");
        require(IBoostHubV40(HUB).owner() == DEPLOYER, "HUB_OWNER_NOT_DEPLOYER");
        require(HUB.code.length != 0 && SDFXS.code.length != 0, "MISSING_LIVE_CONTRACT");

        string memory artifact = vm.readFile("artifacts/staking.json");
        require(vm.parseJsonBytes32(artifact, ".sourceSha256") == sha256(bytes(vm.readFile("contracts/BoostHubStaking.vy"))), "STAKING_SOURCE_MISMATCH");
        require(keccak256(bytes(vm.parseJsonString(artifact, ".compilerVersion"))) == keccak256("0.4.3"), "STAKING_COMPILER_MISMATCH");
        bytes memory vyperCreation = vm.parseJsonBytes(artifact, ".bytecode");
        require(vyperCreation.length > 1000, "INVALID_VYPER_BYTECODE");
        address[8] memory rewardTokens;
        rewardTokens[0] = WFRAX;
        // KEEP the deployed staking's 15-day reward smoothing distinct from
        // the NEW strategy's 24-hour profit unlocking.
        bytes memory initcode = abi.encodePacked(vyperCreation, abi.encode(
            SDFXS, HUB, PID, ADMIN_AND_FEES, rewardTokens, ADMIN_AND_FEES, uint256(150)
        ));
        vm.startBroadcast();
        // The deployer configures all routes BEFORE handing router ownership to the admin.
        CurveYieldOmniRouter router = new CurveYieldOmniRouter(DEPLOYER, ADMIN_AND_FEES);
        routerAddress = address(router);
        _configureRoutes(router);
        require(router.price_oracle(SDFXS, WFRAX) != 0, "MISSING_SDFXS_WFRAX_PRICE");
        require(router.price_oracle(SDFXS, FRXUSD) != 0, "MISSING_SDFXS_FRXUSD_PRICE");
        require(router.price_oracle(SDFXS, SFRXUSD) != 0, "MISSING_SDFXS_SFRXUSD_PRICE");
        require(router.price_oracle(WFRAX, SDFXS) != 0, "MISSING_REWARD_SWAP_PRICE");
        require(router.feeRecipient() == ADMIN_AND_FEES, "BAD_ROUTER_FEE_RECEIVER");
        router.transferOwnership(ADMIN_AND_FEES);
        require(router.owner() == ADMIN_AND_FEES, "BAD_ROUTER_OWNER");
        emit NewRouter(routerAddress);
        assembly { staking := create(0, add(initcode, 32), mload(initcode)) }
        require(staking != address(0), "STAKING_CREATE_FAILED");
        IStakingV40 st = IStakingV40(staking);
        require(st.lp_token() == SDFXS && st.boost_hub() == HUB && st.pid() == PID, "INVALID_STAKING_BINDING");
        require(st.admin() == ADMIN_AND_FEES && st.fee_receiver() == ADMIN_AND_FEES, "INVALID_STAKING_ADMIN");
        require(st.reward_smoothing_units() == 150, "INVALID_STAKING_SMOOTHING");
        emit NewStaking(staking);

        // Append ONLY the new depositor, preserving the existing staking
        // contract and all existing pool settings and approvals.
        address[] memory depositors = new address[](1);
        bool[] memory approvals = new bool[](1);
        depositors[0] = staking;
        approvals[0] = true;
        IBoostHubV40(HUB).setApprovedDepositors(PID, depositors, approvals, false);
        require(IBoostHubV40(HUB).isApprovedDepositor(PID, staking), "STAKING_NOT_APPROVED");

        // These two creations MUST remain successive. Strategy's immutable vault
        // address is computed from the broadcasting EOA's next two CREATE nonces.
        address predictedVault = vm.computeCreateAddress(DEPLOYER, vm.getNonce(DEPLOYER) + 1);
        BaseAllToWantBoostHubV5.Addresses memory addresses = BaseAllToWantBoostHubV5.Addresses({
            want: SDFXS, vault: predictedVault, swapper: routerAddress, adminFeeReceiver: ADMIN_AND_FEES
        });
        BaseAllToWantBoostHubV5.FeeSettings memory fees = BaseAllToWantBoostHubV5.FeeSettings({
            totalPerformanceFeeBps: 300, callShareBps: 300, adminShareBps: 9700
        });
        strategy = address(new StrategyConvexBoostHubStakingV5(staking, addresses, fees, 1 days, 0));
        vault = address(new BeefyVaultV7FixedV2(
            IStrategyBoostHubV1(strategy), "CurveYield sdFXS", "cysdFXS", 30, ADMIN_AND_FEES
        ));
        require(vault == predictedVault, "STRATEGY_VAULT_NONCE_MISMATCH");
        require(StrategyConvexBoostHubStakingV5(strategy).vault() == vault, "STRATEGY_NOT_BOUND");
        require(address(BeefyVaultV7FixedV2(vault).strategy()) == strategy, "VAULT_NOT_BOUND");
        require(address(StrategyConvexBoostHubStakingV5(strategy).staking()) == staking, "STRATEGY_STAKING_MISMATCH");
        require(StrategyConvexBoostHubStakingV5(strategy).adminFeeReceiverAddress() == ADMIN_AND_FEES, "STRATEGY_FEE_RECEIVER_MISMATCH");
        require(StrategyConvexBoostHubStakingV5(strategy).totalPerformanceFeeBps() == 300, "BAD_PERFORMANCE_FEE");
        require(StrategyConvexBoostHubStakingV5(strategy).callShareBps() == 300, "BAD_CALL_FEE_SHARE");
        require(StrategyConvexBoostHubStakingV5(strategy).lockDuration() == 1 days, "BAD_LOCK_DURATION");
        require(BeefyVaultV7FixedV2(vault).withdrawalFeeBps() == 30, "BAD_WITHDRAW_FEE");
        BeefyVaultV7FixedV2(vault).transferOwnership(ADMIN_AND_FEES);
        require(BeefyVaultV7FixedV2(vault).owner() == ADMIN_AND_FEES, "BAD_VAULT_ADMIN");
        emit NewStrategyVault(strategy,vault);
        vm.stopBroadcast();
    }
}
