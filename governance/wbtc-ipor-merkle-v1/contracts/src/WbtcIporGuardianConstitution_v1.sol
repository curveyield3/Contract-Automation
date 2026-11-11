// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.18;

/// @title WbtcIporGuardianConstitution
/// @notice One-way, non-upgradeable storage for the DAO Guardian's removal.
/// @dev This minimal enforcement component exists because the Aragon OSx voting
///      plugin is upgradeable and a plugin-local boolean would not be permanent.
///      The DAO's installed root permissions MUST restrict all alternate
///      execution paths; this contract by itself cannot prevent a DAO
///      administrator from installing a different voting plugin.
/// @custom:security-contact See project security contact before deployment.
contract WbtcIporGuardianConstitution {
    error OnlyBoundDAO();
    error AlreadyRemoved();
    error InvalidDAO();

    address public immutable dao;
    bool public isGuardianRemoved;

    event DaoGuardianPermanentlyRemoved(address indexed dao);

    constructor(address boundDAO) {
        if (boundDAO == address(0)) revert InvalidDAO();
        dao = boundDAO;
    }

    /// @notice Irreversible; only an action executed by the bound Aragon DAO
    ///      may remove the Guardian. No owner, upgrade, reset or replacement
    ///      function exists.
    function permanentlyRemoveDaoGuardian() external {
        if (msg.sender != dao) revert OnlyBoundDAO();
        if (isGuardianRemoved) revert AlreadyRemoved();
        isGuardianRemoved = true;
        emit DaoGuardianPermanentlyRemoved(dao);
    }
}
