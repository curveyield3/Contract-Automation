// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.18;
interface IRiscZeroReceiptVerifier {
    function verify(bytes calldata seal, bytes32 imageId, bytes32 journalDigest) external view;
}
interface IWbtcIporVotingSource {
    function getVotingToken() external view returns (address);
    function guardianSafe() external view returns (address);
    function morphoBlue() external view returns (address);
    function curveLendFactory() external view returns (address);
    function getMarketCount() external view returns (uint256);
    function getVotingMarketAt(uint256 index) external view returns (uint8 kind, address market, address custody, bytes32 id, bool enabled);
    function excludedEconomicAccounts(address) external view returns (bool);
    function getEconomicExclusionCount() external view returns (uint256);
    function getEconomicExclusionAt(uint256 index) external view returns (address);
    function getSnapshotMode(uint256 parentId) external view returns (bool removal, bool guardianBonus, bool verified, bool pending);
    function snapshotBlockNumber(uint256) external view returns (uint256);
    function snapshotBlockHash(uint256) external view returns (bytes32);
    function snapshotSourceHash(uint256) external view returns (bytes32);
    function snapshotRosterSize(uint256) external view returns (uint256);
    function snapshotAnchorTimestamp(uint256) external view returns (uint256);
    function snapshotReady(uint256) external view returns (bool);
}
interface IWbtcIporShareSource {
    function totalSupply() external view returns (uint256);
    function balanceOf(address user) external view returns (uint256);
}
interface IWbtcIporMorphoRead {
    function position(bytes32 id, address user) external view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);
    function idToMarketParams(bytes32 id) external view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv);
}
interface IWbtcIporCurveRead {
    function collateral_token() external view returns (address);
    function amm() external view returns (address);
    function factory() external view returns (address);
}
interface IWbtcIporCurveFactory {
    function market_count() external view returns (uint256);
    function markets(uint256 i) external view returns (
        address vault, address controller, address amm, address collateralToken,
        address borrowedToken, address priceOracle, address monetaryPolicy);
}
interface IWbtcIporAmmRead {
    function coins(uint256 i) external view returns (address);
    function get_sum_xy(address user) external view returns (uint256[2] memory);
}
contract WbtcIporZkProofVerifier {
    address public immutable dao;
    address public immutable votingPlugin;
    IRiscZeroReceiptVerifier public immutable receiptVerifier;
    bytes32 public immutable guestImageId;
    bytes32 private constant LEAF_DOMAIN = keccak256("WBTC_IPOR_GOVERNANCE_VOTER_LEAF_V1");
    error InvalidVerificationConfiguration();
    error OnlyVotingPlugin();
    error InvalidSource();
    error InvalidSnapshot();
    struct SnapshotJournal {
        uint256 chainId;
        address dao;
        address plugin;
        uint256 parentId;
        uint256 anchorBlock;
        uint256 anchorTimestamp;
        bytes32 anchorBlockHash;
        bytes32 sourceHash;
        bytes32 rosterRoot;
        uint256 qualifiedEconomicWeight;
        uint256 wholeSupplyEconomicWeight;
        uint256 rosterSize;
        bool removal;
        bool guardianBonus;
    }
    constructor(address dao_, address plugin_, address existingRouter_, bytes32 imageId_) {
        if (dao_ == address(0) || dao_.code.length == 0
            || plugin_ == address(0) || plugin_.code.length == 0
            || existingRouter_ == address(0) || existingRouter_.code.length == 0
            || imageId_ == bytes32(0)) revert InvalidVerificationConfiguration();
        dao = dao_;
        votingPlugin = plugin_;
        receiptVerifier = IRiscZeroReceiptVerifier(existingRouter_);
        guestImageId = imageId_;
    }
    function _v() private view returns (IWbtcIporVotingSource) {
        return IWbtcIporVotingSource(votingPlugin);
    }
    function validateMarket(uint8 kind, address market, bytes32 id) external view returns (address custody) {
        IWbtcIporVotingSource v = _v();
        address shares = v.getVotingToken();
        if (kind == 1) {
            if (market != v.morphoBlue() || id == bytes32(0)) revert InvalidSource();
            (address loan, address collateral,,,) = IWbtcIporMorphoRead(market).idToMarketParams(id);
            if (loan == address(0) || collateral != shares) revert InvalidSource();
            custody = market;
        } else if (kind == 2) {
            IWbtcIporCurveFactory factory = IWbtcIporCurveFactory(v.curveLendFactory());
            uint256 index = uint256(id);
            if (index >= factory.market_count()) revert InvalidSource();
            (address vault, address controller, address amm, address collateral,
                address borrowed, address oracle, address policy) = factory.markets(index);
            if (vault.code.length == 0 || controller != market || collateral != shares
                || borrowed == address(0) || borrowed == collateral || oracle == address(0)
                || policy == address(0) || amm.code.length == 0) revert InvalidSource();
            custody = amm;
            if (IWbtcIporCurveRead(market).amm() != custody
                || IWbtcIporCurveRead(market).factory() != address(factory)
                || IWbtcIporCurveRead(market).collateral_token() != shares
                || IWbtcIporAmmRead(custody).coins(1) != shares) revert InvalidSource();
        } else revert InvalidSource();
        if (v.excludedEconomicAccounts(custody)) revert InvalidSource();
    }
    function validateEconomicExclusion(address account) external view {
        IWbtcIporVotingSource v = _v();
        if (account == address(0) || account == v.guardianSafe()
            || account == v.morphoBlue() || account == v.curveLendFactory()) revert InvalidSource();
        for (uint256 i; i < v.getMarketCount(); ++i) {
            (, address market, address custody,,) = v.getVotingMarketAt(i);
            if (market == account || custody == account) revert InvalidSource();
        }
    }
    function sourceMarketHash(bytes32 digest) external view returns (bytes32) {
        IWbtcIporVotingSource v = _v();
        for (uint256 i; i < v.getMarketCount(); ++i) {
            (uint8 kind, address market, address custody, bytes32 id, bool enabled) = v.getVotingMarketAt(i);
            digest = keccak256(abi.encode(digest, kind, market, custody, id, enabled));
        }
        return digest;
    }
    function economicWeight(address account) external view returns (uint256 weight) {
        IWbtcIporVotingSource v = _v();
        uint256 count = v.getMarketCount();
        bool custody = account == v.morphoBlue() || v.excludedEconomicAccounts(account);
        for (uint256 i; i < count; ++i) {
            (,, address c,,) = v.getVotingMarketAt(i);
            if (c == account) custody = true;
        }
        if (!custody) weight = IWbtcIporShareSource(v.getVotingToken()).balanceOf(account);
        uint256 marketTotal;
        for (uint256 i; i < count; ++i) {
            (uint8 kind, address market, address c, bytes32 id, bool enabled) = v.getVotingMarketAt(i);
            if (!enabled) continue;
            if (kind == 1) {
                (,, uint128 collateral) = IWbtcIporMorphoRead(market).position(id, account);
                marketTotal += uint256(collateral);
            } else if (kind == 2) {
                uint256[2] memory amounts = IWbtcIporAmmRead(c).get_sum_xy(account);
                marketTotal += amounts[1];
            }
        }
        return weight + marketTotal / 2;
    }
    function wholeEconomicSupply() external view returns (uint256 supply) {
        IWbtcIporVotingSource v = _v();
        IWbtcIporShareSource shares = IWbtcIporShareSource(v.getVotingToken());
        supply = shares.totalSupply();
        for (uint256 i; i < v.getEconomicExclusionCount(); ++i) {
            address account = v.getEconomicExclusionAt(i);
            if (v.excludedEconomicAccounts(account)) supply -= shares.balanceOf(account);
        }
    }
    function verifyVoterLeaf(bytes32 root, uint256 parentId, address voter,
        uint256 economic, uint64 activeSince, bytes32[] calldata siblings)
        external view returns (bool)
    {
        if (siblings.length > 32) revert InvalidSnapshot();
        bytes32 hash = keccak256(abi.encodePacked(keccak256(abi.encode(
            LEAF_DOMAIN, block.chainid, votingPlugin, parentId, voter, economic, activeSince))));
        for (uint256 i; i < siblings.length; ++i) {
            bytes32 sibling = siblings[i];
            hash = hash < sibling ? keccak256(abi.encodePacked(hash, sibling))
                : keccak256(abi.encodePacked(sibling, hash));
        }
        return hash == root;
    }
    function verifySnapshot(bytes calldata seal, bytes calldata journal)
        external view returns (bool)
    {
        if (msg.sender != votingPlugin) revert OnlyVotingPlugin();
        if (seal.length == 0 || journal.length == 0) revert InvalidVerificationConfiguration();
        SnapshotJournal memory j = abi.decode(journal, (SnapshotJournal));
        IWbtcIporVotingSource v = _v();
        (bool removal, bool bonus, bool verified, bool pending) = v.getSnapshotMode(j.parentId);
        if (!verified || !pending || v.snapshotReady(j.parentId)
            || j.chainId != block.chainid || j.dao != dao || j.plugin != votingPlugin
            || j.anchorBlock != v.snapshotBlockNumber(j.parentId)
            || j.anchorBlockHash != v.snapshotBlockHash(j.parentId)
            || j.anchorTimestamp == 0 || j.anchorTimestamp > v.snapshotAnchorTimestamp(j.parentId)
            || j.sourceHash != v.snapshotSourceHash(j.parentId)
            || j.rosterRoot == bytes32(0) || j.qualifiedEconomicWeight == 0
            || j.rosterSize == 0 || j.rosterSize != v.snapshotRosterSize(j.parentId)
            || j.wholeSupplyEconomicWeight < j.qualifiedEconomicWeight
            || j.removal != removal || j.guardianBonus != bonus)
            revert InvalidSnapshot();
        receiptVerifier.verify(seal, guestImageId, sha256(journal));
        return true;
    }
}