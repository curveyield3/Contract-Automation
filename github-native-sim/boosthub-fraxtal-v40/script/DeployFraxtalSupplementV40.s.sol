// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Fraxtal-only supplemental deployment: reuses the EXISTING BoostHub and
// OmniRouter; does not redeploy or reconfigure either one.
import {BaseAllToWantBoostHubV5} from "../contracts/BaseAllToWantBoostHubV5.sol";
import {StrategyConvexBoostHubStakingV5} from "../contracts/StrategyConvexBoostHubStakingV5.sol";
import {BeefyVaultV7FixedV2} from "../contracts/BeefyVaultV7FixedV2.sol";
import {IStrategyBoostHubV1} from "../contracts/interfaces/IStrategyBoostHubV1.sol";

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

contract DeployFraxtalSupplementV40 {
    VmV40 private constant vm = VmV40(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant HUB = 0x40f7085841034f752f17592875703eb5032f2b42;
    address private constant ROUTER = 0xb730db2de60877961dd90d1fbf37830f64616df4;
    address private constant SDFXS = 0x1AEe2382e05Dc68BDfC472F1E46d570feCca5814;
    address private constant WFRAX = 0xFc00000000000000000000000000000000000002;
    address private constant DEPLOYER = 0x064256591313eeb86a84a5cbcc4c6460791b96dd;
    address private constant ADMIN_AND_FEES = 0x47623C62f281807D615eeb4A2CEee9d97F9D3C49;
    uint256 private constant PID = 0;

    event NewStaking(address indexed staking);
    event NewStrategyVault(address indexed strategy, address indexed vault);

    function run() external returns (address staking, address strategy, address vault) {
        require(block.chainid == 252, "FRAXTAL_ONLY");
        require(IBoostHubV40(HUB).owner() == DEPLOYER, "HUB_OWNER_NOT_DEPLOYER");
        require(HUB.code.length != 0 && ROUTER.code.length != 0 && SDFXS.code.length != 0, "MISSING_LIVE_CONTRACT");

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
            want: SDFXS, vault: predictedVault, swapper: ROUTER, adminFeeReceiver: ADMIN_AND_FEES
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
