// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.18;

/// @notice The ONLY boundary for collateral snapshots, direct delegated-supply
///         census, and authenticated Merkle/ZK proof verification. The voting
///         plugin never iterates markets, delegates, or historical votes.
/// @dev Implementations MUST enforce caller permissions, bind the parent and
///      historical snapshot block, prove a COMPLETE active delegation census,
///      exclude direct-vote duplicates of pledged collateral, and freeze all
///      values permanently before any ballot can accept votes.
interface IWbtcVotingPowerSource {
    function snapshotFrozen(bytes32 parentKey) external view returns (bool);
    function freezeSnapshot(bytes32 parentKey, uint64 snapshotBlock) external;
    function snapshotTotals(bytes32 parentKey)
        external view returns (uint256 activeDelegatedDirectShares, uint256 weightedCollateralShares);
    function collateralVotes(bytes32 parentKey, address delegatee) external view returns (uint256);
    function safeBonusEligible(bytes32 parentKey) external view returns (bool);
}
