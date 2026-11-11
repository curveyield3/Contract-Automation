// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.18;

/// @title WbtcIporActionPolicy
/// @notice Explicitly scoped action permissions for ordinary WBTC IPOR DAO
///         proposals; complements, not replaces, Aragon OSx DAO permissions.
/// @dev Uses the existing Aragon DAO execution model: only msg.sender ==
///      configured DAO may update the permitted vault selectors.
///      Code is intentionally non-upgradeable and has no owner/admin role.
contract WbtcIporActionPolicy {
    address public immutable dao;
    address public immutable vaultShares;
    address public immutable weightedSources;
    address public immutable guardianConstitution;

    address public governancePlugin; // set exactly once by the DAO after plugin install
    mapping(bytes4 => bool) public allowedVaultSelector;

    error Unauthorized();
    error InvalidConfiguration();
    error PluginAlreadyBound();
    error ForbiddenSelector();

    event GovernancePluginBound(address indexed plugin);
    event VaultSelectorUpdated(bytes4 indexed selector, bool allowed);

    bytes4 private constant UPGRADE_TO = bytes4(keccak256("upgradeTo(address)"));
    bytes4 private constant UPGRADE_TO_AND_CALL = bytes4(keccak256("upgradeToAndCall(address,bytes)"));
    bytes4 private constant GRANT_ROLE = bytes4(keccak256("grantRole(bytes32,address)"));
    bytes4 private constant REVOKE_ROLE = bytes4(keccak256("revokeRole(bytes32,address)"));

    // The only configuration method exposed by this project's Aragon fork.
    bytes4 private constant UPDATE_VOTING_SETTINGS =
        bytes4(keccak256("updateGovernanceConfiguration((uint32,uint32,uint32,uint32,uint32,uint64,uint64,uint64,uint256))"));
    bytes4 private constant ADD_MARKET = bytes4(keccak256("addVotingMarket(uint8,address,bytes32)"));
    bytes4 private constant ENABLE_MARKET = bytes4(keccak256("setVotingMarketEnabled(uint256,bool)"));
    bytes4 private constant CONFIGURE_ACTIVITY = bytes4(keccak256("configureVoterActivity(uint8,uint8,uint8)"));
    bytes4 private constant SET_VAULT_SELECTOR = bytes4(keccak256("setVaultSelectorAllowed(bytes4,bool)"));

    constructor(address boundDAO, address vault, address sourceRegistry, address constitution) {
        if (boundDAO == address(0) || vault.code.length == 0
            || sourceRegistry.code.length == 0 || constitution.code.length == 0) {
            revert InvalidConfiguration();
        }
        if (boundDAO == vault || boundDAO == sourceRegistry || boundDAO == constitution) {
            revert InvalidConfiguration();
        }
        dao = boundDAO;
        vaultShares = vault;
        weightedSources = sourceRegistry;
        guardianConstitution = constitution;
    }

    modifier onlyDAO() {
        if (msg.sender != dao) revert Unauthorized();
        _;
    }

    /// @notice Binding is a setup action: a standard proposal cannot redirect
    ///         an installed policy to a different plugin.
    function bindGovernancePlugin(address plugin) external onlyDAO {
        if (governancePlugin != address(0)) revert PluginAlreadyBound();
        if (plugin.code.length == 0 || plugin == dao || plugin == guardianConstitution) {
            revert InvalidConfiguration();
        }
        governancePlugin = plugin;
        emit GovernancePluginBound(plugin);
    }

    /// @notice A normal proposal can authorize a new exact vault function only
    ///         via an explicit DAO vote. No arbitrary target or plugin upgrade.
    function setVaultSelectorAllowed(bytes4 selector, bool allowed) external onlyDAO {
        if (
            selector == bytes4(0) || selector == UPGRADE_TO || selector == UPGRADE_TO_AND_CALL
                || selector == GRANT_ROLE || selector == REVOKE_ROLE
        ) revert ForbiddenSelector();
        allowedVaultSelector[selector] = allowed;
        emit VaultSelectorUpdated(selector, allowed);
    }

    /// @notice Code-level action scope: zero ETH, an approved destination and
    ///         an exact callable selector. Storage checks in target contracts
    ///         must further enforce the target's authorized semantics.
    function isAllowed(address target, uint256 value, bytes calldata data) external view returns (bool) {
        if (value != 0 || data.length < 4 || governancePlugin == address(0)) return false;
        if (target == guardianConstitution || target == dao) return false;
        bytes4 selector;
        assembly {
            selector := calldataload(data.offset)
        }
        if (target == governancePlugin) {
            return selector == UPDATE_VOTING_SETTINGS;
        }
        if (target == weightedSources) {
            return selector == ADD_MARKET || selector == ENABLE_MARKET || selector == CONFIGURE_ACTIVITY;
        }
        if (target == address(this)) {
            return selector == SET_VAULT_SELECTOR;
        }
        if (target == vaultShares) {
            return allowedVaultSelector[selector];
        }
        return false;
    }
}
