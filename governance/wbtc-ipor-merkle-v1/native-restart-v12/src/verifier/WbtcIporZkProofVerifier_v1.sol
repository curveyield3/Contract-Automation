// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.18;

/// @notice The already-deployed RISC Zero verifier router.
/// @dev No RISC Zero router or proof-system implementation is deployed by
/// this project. The approved upstream router is a constructor dependency.
interface IRiscZeroReceiptVerifier {
    function verify(bytes calldata seal, bytes32 imageId, bytes32 journalDigest) external view;
}

/// @title WbtcIporZkProofVerifier
/// @notice One proof-verifier contract for the single WBTC IPOR Aragon voting plugin.
/// @dev Source-derived integration of the official IRiscZeroVerifier.verify API.
/// A receipt proves ONLY the computation of its pinned guest image. The guest
/// must authenticate the full voter set, all historical market state, global
/// economic denominator, source configuration and every Merkle leaf. An
/// incomplete or dummy guest image MUST NOT be installed.
/// @custom:security-contact See parent DAO's security policy.
contract WbtcIporZkProofVerifier {
    address public immutable dao;
    address public immutable votingPlugin;
    IRiscZeroReceiptVerifier public immutable receiptVerifier;
    bytes32 public immutable guestImageId;

    error InvalidVerificationConfiguration();
    error OnlyVotingPlugin();

    constructor(address dao_, address plugin_, address existingRouter_, bytes32 imageId_) {
        if (
            dao_ == address(0) || dao_.code.length == 0
                || plugin_ == address(0) || plugin_.code.length == 0
                || existingRouter_ == address(0) || existingRouter_.code.length == 0
                || imageId_ == bytes32(0)
        ) revert InvalidVerificationConfiguration();
        dao = dao_;
        votingPlugin = plugin_;
        receiptVerifier = IRiscZeroReceiptVerifier(existingRouter_);
        guestImageId = imageId_;
    }

    /// @notice Verifies the official RISC Zero receipt for precisely the
    /// journal bytes provided. The voting plugin must independently decode
    /// these bytes and bind every field to its immutable pending proposal.
    ///
    /// The RISC Zero receipt convention uses sha256(journal), not keccak256.
    /// Calling through this adapter does not grant any proposal/execution
    /// permission and does not mutate state.
    function verifySnapshot(bytes calldata seal, bytes calldata journal)
        external view returns (bool)
    {
        if (msg.sender != votingPlugin) revert OnlyVotingPlugin();
        if (journal.length == 0 || seal.length == 0) revert InvalidVerificationConfiguration();
        receiptVerifier.verify(seal, guestImageId, sha256(journal));
        return true;
    }
}
