// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.18;
import {BokkyPooBahsDateTimeLibrary} from "./lib/BokkyPooBahsDateTimeLibrary.sol";
interface IRiscZeroReceiptVerifier {
    function verify(bytes calldata seal, bytes32 imageId, bytes32 journalDigest) external view;
}
struct GovernanceAction { address to; uint256 value; bytes data; }
interface IWbtcIporVotingSource {
    function getVotingToken() external view returns (address);
    function guardianSafe() external view returns (address);
    function morphoBlue() external view returns (address);
    function curveLendFactory() external view returns (address);
    function getMarketCount() external view returns (uint256);
    function getRegisteredVoterCount() external view returns (uint256);
    function economicExclusionDigest() external view returns (bytes32);
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
    function stagedProcessor() external view returns (address);
}
interface IShareBondToken {
    function transferFrom(address from,address to,uint256 amount) external returns(bool);
    function transfer(address to,uint256 amount) external returns(bool);
    function decimals() external view returns(uint8);
}
interface IParentBodyCategoryRead {
    function isGuardianRemoval(uint256 parentId) external view returns(bool);
}
interface IProposalCreatorRead {
    function getProposalCreator(uint256 id) external view returns(address);
}
interface IStageConfigReader {
    enum ResultType {None,Approval,Veto}
    struct Body {address addr;bool isManual;bool tryAdvance;ResultType resultType;}
    struct Stage {Body[] bodies;uint64 maxAdvance;uint64 minAdvance;uint64 voteDuration;
        uint16 approvalThreshold;uint16 vetoThreshold;bool cancelable;bool editable;}
    function getStages(uint256 idx) external view returns(Stage[] memory);
    function getCurrentConfigIndex() external view returns(uint16);
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
    mapping(uint256 => uint256) private bondAmounts;
    mapping(uint256 => bool) private bondSettled;
    bool private bondLock;
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
    function hasElapsedMonths(uint64 start,uint8 months,uint256 asOf) external pure returns(bool) {
        return asOf >= BokkyPooBahsDateTimeLibrary.addMonths(uint256(start),uint256(months));
    }
    function _validBallot(IStageConfigReader.Stage memory st,address voting,uint64 duration)
        private pure returns(bool)
    {
        return st.bodies.length==1 && st.bodies[0].addr==voting
            && !st.bodies[0].isManual && !st.bodies[0].tryAdvance
            && st.bodies[0].resultType==IStageConfigReader.ResultType.Approval
            && st.minAdvance==duration && st.voteDuration==duration
            && st.maxAdvance>duration && st.approvalThreshold==1 && st.vetoThreshold==0
            && !st.cancelable && !st.editable;
    }
    function validateStageConfigurations(address safe,address voting,uint16 standardIdx,
        uint16 removalIdx,uint16 noGuardianIdx) external view returns(bool)
    {
        if(voting!=votingPlugin || safe!=_v().guardianSafe()
            || standardIdx==0 || removalIdx==0 || noGuardianIdx==0
            || standardIdx==removalIdx || standardIdx==noGuardianIdx
            || removalIdx==noGuardianIdx)revert InvalidSource();
        IStageConfigReader spp=IStageConfigReader(_v().stagedProcessor());
        uint16 maxIdx=spp.getCurrentConfigIndex();
        if(standardIdx>maxIdx || removalIdx>maxIdx || noGuardianIdx>maxIdx)
            revert InvalidSource();
        IStageConfigReader.Stage[] memory normal=spp.getStages(standardIdx);
        IStageConfigReader.Stage[] memory removal=spp.getStages(removalIdx);
        IStageConfigReader.Stage[] memory afterRemoval=spp.getStages(noGuardianIdx);
        if(normal.length!=2 || removal.length!=1 || afterRemoval.length!=1)
            revert InvalidSource();
        IStageConfigReader.Stage memory review=normal[0];
        if(review.bodies.length!=1 || review.bodies[0].addr!=safe
            || !review.bodies[0].isManual
            || review.bodies[0].resultType!=IStageConfigReader.ResultType.Veto
            || review.minAdvance!=0 || review.voteDuration!=7 days
            || review.maxAdvance<=7 days || review.approvalThreshold!=0
            || review.vetoThreshold!=1 || review.cancelable || review.editable
            || !_validBallot(normal[1],voting,14 days)
            || !_validBallot(removal[0],voting,30 days)
            || !_validBallot(afterRemoval[0],voting,14 days))revert InvalidSource();
        return true;
    }
    function _requireStagedProcessor() private view {
        if(msg.sender != _v().stagedProcessor())revert OnlyVotingPlugin();
    }
    function escrowBond(uint256 parentId,address proposer,bool removal) external returns(uint256 amount) {
        _requireStagedProcessor();
        if(bondLock || bondAmounts[parentId]!=0 || proposer==address(0))revert InvalidSource();
        bondLock=true;
        IShareBondToken token=IShareBondToken(_v().getVotingToken());
        uint8 decimals=token.decimals();
        if(decimals<3 || decimals>36)revert InvalidSource();
        amount=10**uint256(decimals-3);
        if(removal)amount*=5;
        bondAmounts[parentId]=amount;
        if(!token.transferFrom(proposer,address(this),amount))revert InvalidSource();
        bondLock=false;
    }
    function settleBond(uint256 parentId,address proposer,bool spam) external returns(uint256 amount) {
        _requireStagedProcessor();
        if(bondLock || bondAmounts[parentId]==0 || bondSettled[parentId])revert InvalidSource();
        bondLock=true;
        bondSettled[parentId]=true;
        amount=bondAmounts[parentId];
        if(!IShareBondToken(_v().getVotingToken()).transfer(spam ? dao : proposer,amount))
            revert InvalidSource();
        bondLock=false;
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
    function sourceConfigurationHash() external view returns (bytes32 digest) {
        IWbtcIporVotingSource v=_v();
        digest=keccak256(abi.encode(block.chainid,dao,v.getVotingToken(),v.guardianSafe(),
            v.morphoBlue(),v.curveLendFactory(),v.getMarketCount(),
            v.getRegisteredVoterCount(),v.economicExclusionDigest(),v.getEconomicExclusionCount()));
        for(uint256 i;i<v.getMarketCount();++i){
            (uint8 kind,address market,address custody,bytes32 id,bool enabled)=v.getVotingMarketAt(i);
            digest=keccak256(abi.encode(digest,kind,market,custody,id,enabled));
        }
    }
    function validateBodyProposal(bytes calldata metadata,bytes calldata encodedActions,
        uint256 failureMap,uint8 vote,bool early) external view returns(uint256 parentId,bool special)
    {
        if(msg.sender!=votingPlugin || failureMap!=0 || vote!=0 || early)revert InvalidSource();
        GovernanceAction[] memory actions=abi.decode(encodedActions,(GovernanceAction[]));
        address spp=_v().stagedProcessor();
        if(actions.length!=1 || actions[0].to!=spp || actions[0].value!=0
            || actions[0].data.length!=132)revert InvalidSource();
        (address declared,uint256 parent,uint16 stage)=abi.decode(metadata,(address,uint256,uint16));
        if(declared!=spp || stage>1)revert InvalidSource();
        bytes memory data=actions[0].data;
        bytes4 selector;
        assembly { selector := mload(add(data,32)) }
        if(selector!=bytes4(keccak256("reportProposalResult(uint256,uint16,uint8,bool)")))
            revert InvalidSource();
        (uint256 called,uint16 index,uint8 result,bool tryAdvance)=abi.decode(
            _skipSelector(data),(uint256,uint16,uint8,bool));
        if(called!=parent || index!=stage || result!=1 || tryAdvance)revert InvalidSource();
        special=IParentBodyCategoryRead(spp).isGuardianRemoval(parent);
        return(parent,special);
    }
    function _skipSelector(bytes memory raw) private pure returns(bytes memory rest) {
        rest=new bytes(raw.length-4);
        for(uint256 i;i<rest.length;++i)rest[i]=raw[i+4];
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
    function _verifySnapshot(bytes calldata seal, bytes calldata journal)
        private view returns (SnapshotJournal memory j)
    {
        if (msg.sender != votingPlugin) revert OnlyVotingPlugin();
        if (seal.length == 0 || journal.length == 0) revert InvalidVerificationConfiguration();
        j = abi.decode(journal, (SnapshotJournal));
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
    }
    function verifySnapshot(bytes calldata seal,bytes calldata journal) external view returns(bool) {
        _verifySnapshot(seal,journal);
        return true;
    }
    function verifyProposerSnapshot(uint256 parentId,bytes calldata seal,bytes calldata journal,
        uint256 creatorEconomic,uint64 creatorActiveSince,bytes32[] calldata proof,
        uint8 minMonths)
        external view returns(bytes32 root,uint256 qualified,uint256 whole,uint256 roster,
            uint256 anchorTimestamp,uint256 anchorBlock,bool bonus)
    {
        SnapshotJournal memory j=_verifySnapshot(seal,journal);
        if(j.parentId!=parentId || creatorActiveSince==0
            || creatorActiveSince>j.anchorTimestamp
            || creatorEconomic<(j.qualifiedEconomicWeight+9)/10)
            revert InvalidSnapshot();
        address creator=IProposalCreatorRead(_v().stagedProcessor()).getProposalCreator(parentId);
        bytes32 leaf=keccak256(abi.encodePacked(keccak256(abi.encode(
            LEAF_DOMAIN,block.chainid,votingPlugin,parentId,creator,creatorEconomic,creatorActiveSince))));
        if(proof.length>32)revert InvalidSnapshot();
        for(uint256 i;i<proof.length;++i){
            bytes32 sibling=proof[i];
            leaf=leaf<sibling ? keccak256(abi.encodePacked(leaf,sibling))
                : keccak256(abi.encodePacked(sibling,leaf));
        }
        if(leaf!=j.rosterRoot || (j.removal && j.anchorTimestamp<
            BokkyPooBahsDateTimeLibrary.addMonths(uint256(creatorActiveSince),minMonths)))
            revert InvalidSnapshot();
        return(j.rosterRoot,j.qualifiedEconomicWeight,j.wholeSupplyEconomicWeight,
            j.rosterSize,j.anchorTimestamp,j.anchorBlock,j.guardianBonus);
    }
}