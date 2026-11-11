// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.18;

// Source-derived from Aragon TokenVotingSetup v1.4 (Release 1, Build 4):
// https://github.com/aragon/token-voting-plugin/blob/e726c28061486114d601c547e4da1180ed5ab6da/src/TokenVotingSetup.sol
// Preserve Aragon's standard plugin setup processor, UUPS proxy factory,
// PreparedSetupData and PermissionLib vocabulary. Removed token creation,
// wrapper/voting condition and dangerous upgrade/target-redirection grants.

import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";
import {PermissionLib} from "@aragon/osx-commons-contracts/src/permission/PermissionLib.sol";
import {IPlugin} from "@aragon/osx-commons-contracts/src/plugin/IPlugin.sol";
import {PluginUpgradeableSetup} from "@aragon/osx-commons-contracts/src/plugin/setup/PluginUpgradeableSetup.sol";
import {ProxyLib} from "@aragon/osx-commons-contracts/src/utils/deployment/ProxyLib.sol";
import {IVotesUpgradeable} from "@openzeppelin/contracts-upgradeable/governance/utils/IVotesUpgradeable.sol";

import {MajorityVotingBase} from "./base/MajorityVotingBase.sol";
import {
    WbtcIporTokenVoting,
    IWbtcIporSnapshotSource,
    IWbtcIporGuardianConstitution,
    IWbtcIporActionPolicy
} from "./WbtcIporTokenVoting_v1.sol";

/// @notice One-plugin, two-proposal-kind OSx installation. Never creates a
///         new governance ERC20 or wraps/deposits IPOR vault shares.
contract WbtcIporTokenVotingSetup is PluginUpgradeableSetup {
    using ProxyLib for address;

    bytes32 private constant EXECUTE_PERMISSION_ID = keccak256("EXECUTE_PERMISSION");
    bytes32 private constant EXECUTE_PROPOSAL_PERMISSION_ID = keccak256("EXECUTE_PROPOSAL_PERMISSION");
    address private constant ANY_ADDR = address(type(uint160).max);

    WbtcIporTokenVoting private immutable votingImplementation;

    error InvalidDependency();
    error ConstitutionDisallowsUpgrade();

    struct InstallationParams {
        address shareToken;
        IPlugin.TargetConfig targetConfig;
        bytes pluginMetadata;
        address[] excludedAccounts;
        address guardianSafe;
        address constitution;
        address snapshotSource;
        address actionPolicy;
    }

    constructor(WbtcIporTokenVoting implementation)
        PluginUpgradeableSetup(address(implementation))
    {
        if (address(implementation).code.length == 0) revert InvalidDependency();
        votingImplementation = implementation;
    }

    /// @inheritdoc IPluginSetup
    function prepareInstallation(address _dao, bytes calldata _data)
        external
        returns (address plugin, PreparedSetupData memory preparedSetupData)
    {
        InstallationParams memory p = abi.decode(_data, (InstallationParams));
        if (_dao.code.length == 0 || p.shareToken.code.length == 0 || p.snapshotSource.code.length == 0
            || p.constitution.code.length == 0 || p.actionPolicy.code.length == 0
            || p.guardianSafe == address(0) || p.targetConfig.target != _dao
            || uint8(p.targetConfig.operation) != 0) revert InvalidDependency();

        MajorityVotingBase.VotingSettings memory settings = MajorityVotingBase.VotingSettings({
            votingMode: MajorityVotingBase.VotingMode.Standard,
            supportThreshold: 670000,
            minParticipation: 250000,
            minDuration: 14 days,
            minProposerVotingPower: 0
        });

        plugin = address(votingImplementation).deployUUPSProxy(
            abi.encodeCall(
                WbtcIporTokenVoting.initialize,
                (
                    IDAO(_dao),
                    settings,
                    IVotesUpgradeable(p.shareToken),
                    p.targetConfig,
                    0,
                    p.pluginMetadata,
                    p.excludedAccounts,
                    p.guardianSafe,
                    IWbtcIporGuardianConstitution(p.constitution),
                    IWbtcIporSnapshotSource(p.snapshotSource),
                    IWbtcIporActionPolicy(p.actionPolicy)
                )
            )
        );

        preparedSetupData.helpers = new address[](4);
        preparedSetupData.helpers[0] = p.shareToken;
        preparedSetupData.helpers[1] = p.snapshotSource;
        preparedSetupData.helpers[2] = p.constitution;
        preparedSetupData.helpers[3] = p.actionPolicy;

        // In contrast to the general TokenVotingSetup, deliberately DO NOT
        // grant UPDATE_VOTING_SETTINGS, SET_TARGET_CONFIG, SET_METADATA or
        // UPGRADE_PLUGIN_PERMISSION. DAO-approved configuration uses the
        // allowlisted updateGovernanceConfiguration() execution action.
        PermissionLib.MultiTargetPermission[] memory permissions =
            new PermissionLib.MultiTargetPermission[](3);

        permissions[0] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Grant,
            where: _dao,
            who: plugin,
            condition: PermissionLib.NO_CONDITION,
            permissionId: EXECUTE_PERMISSION_ID
        });
        permissions[1] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Grant,
            where: plugin,
            who: ANY_ADDR,
            condition: PermissionLib.NO_CONDITION,
            permissionId: votingImplementation.CREATE_PROPOSAL_PERMISSION_ID()
        });
        permissions[2] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Grant,
            where: plugin,
            who: ANY_ADDR,
            condition: PermissionLib.NO_CONDITION,
            permissionId: EXECUTE_PROPOSAL_PERMISSION_ID
        });
        preparedSetupData.permissions = permissions;
    }

    /// @dev An OSx setup upgrade must never be a route around the
    ///      one-way constitution. Global DAO permission graph still matters.
    function prepareUpdate(address, uint16, SetupPayload calldata)
        external pure override
        returns (bytes memory, PreparedSetupData memory)
    {
        revert ConstitutionDisallowsUpgrade();
    }

    /// @dev No ordinary plugin removal/replacement through this setup.
    function prepareUninstallation(address, SetupPayload calldata)
        external pure returns (PermissionLib.MultiTargetPermission[] memory)
    {
        revert ConstitutionDisallowsUpgrade();
    }
}
