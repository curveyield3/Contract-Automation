// SPDX-License-Identifier: AGPL-3.0-or-later

pragma solidity ^0.8.8;

import {DAO, IDAO, Action} from "@aragon/osx/core/dao/DAO.sol";
import {IProposal} from "@aragon/osx-commons-contracts/src/plugin/extensions/proposal/IProposal.sol";
import {MajorityVotingBase} from "./base/MajorityVotingBase.sol";
import {PluginUUPSUpgradeable} from "@aragon/osx/framework/plugin/setup/PluginSetupProcessor.sol";
import {IMembership} from "@aragon/osx-commons-contracts/src/plugin/extensions/membership/IMembership.sol";
import {_applyRatioCeiled} from "@aragon/osx-commons-contracts/src/utils/math/Ratio.sol";

import {IVotesUpgradeable} from "@openzeppelin/contracts-upgradeable/governance/utils/IVotesUpgradeable.sol";
import {SafeCastUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import {IERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import {IERC6372Upgradeable} from "@openzeppelin/contracts-upgradeable/interfaces/IERC6372Upgradeable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {SafeERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import {IERC20MetadataUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20MetadataUpgradeable.sol";
import {IWbtcVotingPowerSource} from "../interfaces/IWbtcVotingPowerSource.sol";

interface IWbtcNativeSPP {
    function createProposal(bytes memory, Action[] memory, uint128, uint64, bytes[][] memory)
        external returns (uint256);
    function state(uint256) external view returns (uint8);
    function getBodyResult(uint256, uint16, address) external view returns (uint8);
}

/// @title TokenVoting
/// @author Aragon X - 2021-2025
/// @notice The majority voting implementation using an
///         [OpenZeppelin `Votes`](https://docs.openzeppelin.com/contracts/4.x/api/governance#Votes)
///         compatible governance token.
/// @dev v1.4 (Release 1, Build 4). For each upgrade, if the reinitialization step is required,
///      increment the version numbers in the modifier for both the initialize and initializeFrom functions.
/// @custom:security-contact sirt@aragon.org
contract WbtcWeightedTokenVoting is IMembership, MajorityVotingBase {
    using SafeCastUpgradeable for uint256;
    using EnumerableSet for EnumerableSet.AddressSet;
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice The [ERC-165](https://eips.ethereum.org/EIPS/eip-165) interface ID of the contract.
    bytes4 internal constant TOKEN_VOTING_INTERFACE_ID = this.getVotingToken.selector;

    /// @notice An [OpenZeppelin `Votes`](https://docs.openzeppelin.com/contracts/4.x/api/governance#Votes)
    ///         compatible contract referencing the token being used for voting.
    IVotesUpgradeable private votingToken; // Slot 0

    /// @notice Wether the token contract indexes past voting power by timestamp.
    bool public tokenIndexedByTimestamp; // Slot 0

    /// @notice The list of addresses excluded from voting
    EnumerableSet.AddressSet internal excludedAccounts; // Slot 1

    /// @notice Emitted when an account's balance is considered as non-circulating supply. Its balance will be excluded from the token supply computation.
    /// @param accounts The addresses whose balance is considered as not circulating
    event ExcludedFromSupply(address[] accounts);

    /// @notice Thrown if the voting power is zero
    error NoVotingPower();

    /// @notice Thrown if the token reports an inconsistent clock mode and clock value
    error TokenClockMismatch();

    // === Minimal WBTC governance extension. No custom voter roster, market
    // scan, proof parser, threshold algorithm, or historical inactivity logic. ===
    uint256 private constant SAFE_BONUS_BPS = 1500;
    uint256 private constant SPAM_BPS = 3300; // strictly greater than 33% of CAST weight

    struct Bond {
        address proposer;
        address refundOrSlashRecipient;
        uint256 shares;
        uint64 snapshotBlock;
        uint256 childProposalId;
        bool settled;
    }
    struct PendingParent {
        address proposer;
        uint64 snapshotBlock;
        uint256 bondShares;
    }

    IWbtcVotingPowerSource public powerSource;
    address public parentSPP;
    address public guardianSafe;
    address public slashedRecipient;
    bool public guardianRemovalMode;
    uint256 public proposalBondShares;
    mapping(bytes32 => Bond) private bonds;
    mapping(uint256 => bytes32) public childParentKey;
    mapping(bytes32 => uint256) private safeBonusForParent;
    mapping(uint256 => uint256) public spamVotingPower;
    PendingParent private pendingParent;
    bool private bondLocked;

    error NotDAO();
    error InvalidGovernanceConfiguration();
    error InvalidNativeParent();
    error InvalidOrUnfrozenSnapshot();
    error ParentAlreadyExists();
    error BondNotFinal();
    error BondAlreadySettled();
    error BondTransferReentrancy();

    event WeightedGovernanceConfigured(address parentSPP, address powerSource, address guardianSafe, bool guardianRemoval);
    event ProposalBondUpdated(uint256 rawShares, address recipient);
    event BondDeposited(address indexed processor, uint256 indexed parentId, address indexed proposer, uint256 shares);
    event BondSettled(address indexed processor, uint256 indexed parentId, address recipient, uint256 shares, bool forfeited);

    modifier onlyDao() {
        if (msg.sender != address(dao())) revert NotDAO();
        _;
    }
    modifier bondNonReentrant() {
        if (bondLocked) revert BondTransferReentrancy();
        bondLocked = true;
        _;
        bondLocked = false;
    }

    /// @notice Configuration uses DAO permission controls. Deploy separate
    ///         instances for standard (25% / 67%) and removal (33% / 75%)
    ///         to keep Aragon's native VotingSettings untouched.
    function configureWeightedGovernance(
        address processor, address source_, address safe,
        address slashRecipient, bool removalMode
    ) external onlyDao {
        if (parentSPP != address(0) || processor.code.length == 0 || source_.code.length == 0
            || slashRecipient == address(0) || (!removalMode && safe == address(0)))
            revert InvalidGovernanceConfiguration();
        parentSPP = processor;
        powerSource = IWbtcVotingPowerSource(source_);
        guardianSafe = safe;
        slashedRecipient = slashRecipient;
        guardianRemovalMode = removalMode;
        emit WeightedGovernanceConfigured(processor, source_, safe, removalMode);
    }

    function configureProposalBond(uint256 rawShareAmount, address slashRecipient) external onlyDao {
        if (slashRecipient == address(0) || rawShareAmount == 0) revert InvalidGovernanceConfiguration();
        proposalBondShares = rawShareAmount;
        slashedRecipient = slashRecipient;
        emit ProposalBondUpdated(rawShareAmount, slashRecipient);
    }

    function bondDetails(address processor, uint256 parentId) external view returns (Bond memory) {
        return bonds[_parentKey(processor, parentId)];
    }

    function _parentKey(address processor, uint256 parentId) private pure returns (bytes32) {
        return keccak256(abi.encode(processor, parentId));
    }

    /// @notice Only parent initiation path. SPP calls THIS instance to create
    ///         its child ballot using native IProposal. No other contract needs
    ///         proposal creation privileges and caller pays the share bond.
    function initiateProposal(
        bytes calldata metadata, Action[] calldata actions, uint128 allowFailureMap,
        uint64 startDate, bytes[][] calldata stageProposalParams
    ) external bondNonReentrant returns (uint256 parentId) {
        if (parentSPP == address(0) || pendingParent.proposer != address(0)
            || tokenIndexedByTimestamp) revert InvalidGovernanceConfiguration();
        address proposer = _msgSender();
        uint256 raw = proposalBondShares;
        IERC20Upgradeable(address(votingToken)).safeTransferFrom(proposer, address(this), raw);
        uint64 snapshot = uint64(block.number - 1);
        pendingParent = PendingParent(proposer, snapshot, raw);
        parentId = IWbtcNativeSPP(parentSPP).createProposal(
            metadata, actions, allowFailureMap, startDate, stageProposalParams
        );
        bytes32 key = _parentKey(parentSPP, parentId);
        Bond storage b = bonds[key];
        if (b.proposer == address(0)) {
            b.proposer = proposer;
            b.shares = raw;
            b.snapshotBlock = snapshot;
            b.refundOrSlashRecipient = slashedRecipient;
        } else if (b.proposer != proposer || b.snapshotBlock != snapshot) {
            revert InvalidNativeParent();
        }
        _freezeSnapshotIfNeeded(key, snapshot);
        if (!guardianRemovalMode) _snapshotSupply(key, snapshot); // Safe veto exists before community child
        delete pendingParent;
        emit BondDeposited(parentSPP, parentId, proposer, raw);
    }

    function _freezeSnapshotIfNeeded(bytes32 key, uint64 snapshot) private {
        if (!powerSource.snapshotFrozen(key)) powerSource.freezeSnapshot(key, snapshot);
        if (!powerSource.snapshotFrozen(key)) revert InvalidOrUnfrozenSnapshot();
    }

    /// @dev Native SPP metadata format: (parentSPP, parentId, stageId).
    ///      Guardian's first child is reentrant during parent creation; the
    ///      pending bond is bound before native child voting begins.
    function _parentFromMetadata(bytes calldata metadata) private returns (bytes32 key, uint64 snapshot) {
        (address processor, uint256 parentId,) = abi.decode(metadata, (address, uint256, uint16));
        if (processor != parentSPP || msg.sender != parentSPP) revert InvalidNativeParent();
        key = _parentKey(processor, parentId);
        Bond storage b = bonds[key];
        if (b.proposer == address(0)) {
            PendingParent memory p = pendingParent;
            if (p.proposer == address(0)) revert InvalidNativeParent();
            b.proposer = p.proposer;
            b.shares = p.bondShares;
            b.snapshotBlock = p.snapshotBlock;
            b.refundOrSlashRecipient = slashedRecipient;
        }
        snapshot = b.snapshotBlock;
        _freezeSnapshotIfNeeded(key, snapshot);
    }

    /// @dev All expensive direct-delegation census, market calculations, and
    ///      offchain proof authenticity checks are performed by powerSource.
    ///      Its snapshots must be frozen and complete or this call reverts.
    function _snapshotSupply(bytes32 key, uint64 snapshot) private returns (uint256) {
        (uint256 delegated, uint256 collateral) = powerSource.snapshotTotals(key);
        if (guardianRemovalMode) return votingToken.getPastTotalSupply(snapshot);
        uint256 active = delegated + collateral;
        uint256 bonus = powerSource.safeBonusEligible(key) ? active * SAFE_BONUS_BPS / 10000 : 0;
        safeBonusForParent[key] = bonus;
        return active + bonus;
    }

    function _votingPowerAt(uint256 childId, address voter, uint256 snapshot) private view returns (uint256 power) {
        bytes32 key = childParentKey[childId];
        if (bonds[key].proposer == address(0)) revert InvalidNativeParent();
        power = votingToken.getPastVotes(voter, snapshot) + powerSource.collateralVotes(key, voter);
        if (!guardianRemovalMode && voter == guardianSafe) power += safeBonusForParent[key];
    }

    /// @notice Anyone can settle a terminal native SPP proposal.
    ///         Executed=>refund. Canceled/Expired=>refund unless the distinct
    ///         spam tally exceeds 33% of cast voting power.
    function settleBond(uint256 parentId) external bondNonReentrant {
        bytes32 key = _parentKey(parentSPP, parentId);
        Bond storage b = bonds[key];
        if (b.proposer == address(0)) revert InvalidNativeParent();
        if (b.settled) revert BondAlreadySettled();
        uint8 state = IWbtcNativeSPP(parentSPP).state(parentId);
        if (state != 1 && state != 2 && state != 4) revert BondNotFinal();
        uint256 castPower;
        uint256 spamPower;
        if (b.childProposalId != 0) {
            Tally storage tally = proposals[b.childProposalId].tally;
            castPower = tally.yes + tally.no + tally.abstain;
            spamPower = spamVotingPower[b.childProposalId];
        }
        // The sole Safe's native result is published by SPP (VetoSpam == 3).
        if (!guardianRemovalMode
            && IWbtcNativeSPP(parentSPP).getBodyResult(parentId, 0, guardianSafe) == 3) {
            uint256 guardianWeight = safeBonusForParent[key];
            castPower += guardianWeight;
            spamPower += guardianWeight;
        }
        bool forfeited = state != 2 && castPower != 0 && spamPower * 10000 > castPower * SPAM_BPS;
        address recipient = forfeited ? b.refundOrSlashRecipient : b.proposer;
        b.settled = true;
        IERC20Upgradeable(address(votingToken)).safeTransfer(recipient, b.shares);
        emit BondSettled(parentSPP, parentId, recipient, b.shares, forfeited);
    }


    /// @notice Initializes the component.
    /// @dev This method is required to support [ERC-1822](https://eips.ethereum.org/EIPS/eip-1822).
    /// @param _dao The IDAO interface of the associated DAO.
    /// @param _votingSettings The voting settings.
    /// @param _token The [ERC-20](https://eips.ethereum.org/EIPS/eip-20) token to use for voting.
    ///     If the given token implements https://eips.ethereum.org/EIPS/eip-6372,
    ///     then `CLOCK_MODE()` or `clock()` will determine the clock type used by the plugin.
    ///     The token will be assumed to use a block number based clock otherwise.
    /// @param _targetConfig Configuration for the execution target, specifying the target address and operation type
    ///     (either `Call` or `DelegateCall`). Defined by `TargetConfig` in the `IPlugin` interface,
    ///     part of the `osx-commons-contracts` package, added in build 3.
    /// @param _minApprovals The minimal amount of approvals the proposal needs to succeed.
    /// @param _pluginMetadata The plugin specific information encoded in bytes.
    ///     This can also be an ipfs cid encoded in bytes.
    function initialize(
        IDAO _dao,
        VotingSettings calldata _votingSettings,
        IVotesUpgradeable _token,
        TargetConfig calldata _targetConfig,
        uint256 _minApprovals,
        bytes calldata _pluginMetadata,
        address[] memory _excludedAccounts
    ) external onlyCallAtInitialization reinitializer(3) {
        __MajorityVotingBase_init(_dao, _votingSettings, _targetConfig, _minApprovals, _pluginMetadata);

        votingToken = _token;
        uint8 shareDecimals = IERC20MetadataUpgradeable(address(_token)).decimals();
        if (shareDecimals < 3 || shareDecimals > 36) revert InvalidGovernanceConfiguration();
        proposalBondShares = 10 ** (shareDecimals - 3); // default 0.001 whole shares


        _detectTokenClock();

        for (uint256 i; i < _excludedAccounts.length;) {
            excludedAccounts.add(_excludedAccounts[i]);

            unchecked {
                ++i;
            }
        }
        if (_excludedAccounts.length > 0) {
            emit ExcludedFromSupply(_excludedAccounts);
        }

        emit MembershipContractAnnounced({definingContract: address(_token)});
    }

    /// @notice Reinitializes the TokenVoting after an upgrade from a previous build version. For each
    ///         reinitialization step, use the `_fromBuild` version to decide which internal functions to
    ///         call for reinitialization.
    /// @dev WARNING: The contract should only be upgradeable through PSP to ensure that _fromBuild is not
    ///      incorrectly passed, and that the appropriate permissions for the upgrade are properly configured.
    /// @param _fromBuild Build version number of previous implementation contract this upgrade is transitioning from.
    /// @param _initData The initialization data to be passed to via `upgradeToAndCall`
    ///     (see [ERC-1967](https://docs.openzeppelin.com/contracts/4.x/api/proxy#ERC1967Upgrade)).
    function initializeFrom(uint16 _fromBuild, bytes calldata _initData) external reinitializer(3) {
        if (_fromBuild < 3) {
            (uint256 minApprovals, TargetConfig memory targetConfig, bytes memory pluginMetadata) =
                abi.decode(_initData, (uint256, TargetConfig, bytes));

            _updateMinApprovals(minApprovals);

            _setTargetConfig(targetConfig);

            _setMetadata(pluginMetadata);
        }
        if (_fromBuild < 4) {
            _detectTokenClock();

            // @dev The list of excluded accounts are intentionally skipped here
            //      Changing the excluded supply on the fly could break important governance invariants,
            //      therefore such feature is only allowed during the first initialization.
        }
    }

    /// @notice Checks if this or the parent contract supports an interface by its ID.
    /// @param _interfaceId The ID of the interface.
    /// @return Returns `true` if the interface is supported.
    function supportsInterface(bytes4 _interfaceId) public view virtual override returns (bool) {
        return _interfaceId == TOKEN_VOTING_INTERFACE_ID || _interfaceId == type(IMembership).interfaceId
            || super.supportsInterface(_interfaceId);
    }

    /// @notice getter function for the voting token.
    /// @dev public function also useful for registering interfaceId
    ///      and for distinguishing from majority voting interface.
    /// @return The token used for voting.
    function getVotingToken() public view returns (IVotesUpgradeable) {
        return votingToken;
    }

    /// @notice Returns the total voting power checkpointed for a specific timestamp or block number, subtracting the balance of excluded addresses.
    /// @param _timePoint The block number or timestamp.
    /// @return The effective voting power.
    function totalVotingPower(uint256 _timePoint) public view override returns (uint256) {
        uint256 _excludedSupply;
        for (uint256 i; i < excludedAccounts.length();) {
            _excludedSupply += votingToken.getPastVotes(excludedAccounts.at(i), _timePoint);

            unchecked {
                ++i;
            }
        }
        return votingToken.getPastTotalSupply(_timePoint) - _excludedSupply;
    }

    /// @inheritdoc MajorityVotingBase
    /// @dev Requires the `CREATE_PROPOSAL_PERMISSION_ID` permission.
    function createProposal(
        bytes calldata _metadata,
        Action[] calldata _actions,
        uint256 _allowFailureMap,
        uint64 _startDate,
        uint64 _endDate,
        VoteOption _voteOption,
        bool _tryEarlyExecution
    ) public override auth(CREATE_PROPOSAL_PERMISSION_ID) returns (uint256 proposalId) {
        uint256 snapshotTimepoint;
        unchecked {
            // The time point must be already mined (block) or in the past (timestamp) to
            // protect against backrunning transactions causing census changes.
            if (tokenIndexedByTimestamp) {
                snapshotTimepoint = block.timestamp - 1;
            } else {
                snapshotTimepoint = block.number - 1;
            }
        }

        // Only authorized native SPP creates a child ballot. Its locked parent
        // snapshot replaces the native child-creation block, preserving original
        // proposal creation/threshold/tally/emit behavior below.
        (bytes32 parentKey, uint64 parentSnapshot) = _parentFromMetadata(_metadata);
        snapshotTimepoint = parentSnapshot;
        uint256 totalVotingPower_ = _snapshotSupply(parentKey, parentSnapshot);

        if (totalVotingPower_ == 0) {
            revert NoVotingPower();
        }

        (_startDate, _endDate) = _validateProposalDates(_startDate, _endDate);

        proposalId = _createProposalId(keccak256(abi.encode(_actions, _metadata)));

        // Store proposal related information
        Proposal storage proposal_ = proposals[proposalId];

        if (proposal_.parameters.snapshotTimepoint != 0) {
            revert ProposalAlreadyExists(proposalId);
        }

        proposal_.parameters.startDate = _startDate;
        proposal_.parameters.endDate = _endDate;
        proposal_.parameters.snapshotTimepoint = snapshotTimepoint.toUint64();
        proposal_.parameters.votingMode = votingMode();
        proposal_.parameters.supportThreshold = supportThreshold();
        proposal_.parameters.minVotingPower = _applyRatioCeiled(totalVotingPower_, minParticipation());

        proposal_.minApprovalPower = _applyRatioCeiled(totalVotingPower_, minApproval());

        proposal_.targetConfig = getTargetConfig();

        // Reduce costs
        if (_allowFailureMap != 0) {
            proposal_.allowFailureMap = _allowFailureMap;
        }

        for (uint256 i; i < _actions.length;) {
            proposal_.actions.push(_actions[i]);
            unchecked {
                ++i;
            }
        }

        // Native SPP is the caller, not the human proposer: never cast a
        // proposed user's vote using the SPP's own address.
        if (_voteOption != VoteOption.None) revert InvalidNativeParent();
        childParentKey[proposalId] = parentKey;
        bonds[parentKey].childProposalId = proposalId;

        _emitProposalCreatedEvent(_metadata, _actions, _allowFailureMap, proposalId, _startDate, _endDate);
    }

    /// @inheritdoc IProposal
    function createProposal(
        bytes calldata _metadata,
        Action[] calldata _actions,
        uint64 _startDate,
        uint64 _endDate,
        bytes memory _data
    ) external override returns (uint256 proposalId) {
        // Note that this calls public function for permission check.
        uint256 allowFailureMap;
        VoteOption _voteOption = VoteOption.None;
        bool tryEarlyExecution;

        if (_data.length != 0) {
            (allowFailureMap, _voteOption, tryEarlyExecution) = abi.decode(_data, (uint256, VoteOption, bool));
        }

        proposalId =
            createProposal(_metadata, _actions, allowFailureMap, _startDate, _endDate, _voteOption, tryEarlyExecution);
    }

    /// @inheritdoc IProposal
    function customProposalParamsABI() external pure override returns (string memory) {
        return "(uint256 allowFailureMap, uint8 voteOption, bool tryEarlyExecution)";
    }

    /// @inheritdoc IMembership
    function isMember(address _account) external view returns (bool) {
        // A member must own at least one token or have at least one token delegated to her/him.
        return votingToken.getVotes(_account) > 0 || IERC20Upgradeable(address(votingToken)).balanceOf(_account) > 0;
    }

    /// @inheritdoc MajorityVotingBase
    function _vote(uint256 _proposalId, VoteOption _voteOption, address _voter, bool _tryEarlyExecution)
        internal
        override
    {
        Proposal storage proposal_ = proposals[_proposalId];

        // This could re-enter, though we can assume the governance token is not malicious
        uint256 votingPower = _votingPowerAt(_proposalId, _voter, proposal_.parameters.snapshotTimepoint);
        VoteOption state = proposal_.voters[_voter];

        // If voter had previously voted, decrease count
        if (state == VoteOption.Yes) {
            proposal_.tally.yes = proposal_.tally.yes - votingPower;
        } else if (state == VoteOption.No || state == VoteOption.NoSpam) {
            proposal_.tally.no -= votingPower;
            if (state == VoteOption.NoSpam) spamVotingPower[_proposalId] -= votingPower;
        } else if (state == VoteOption.Abstain) {
            proposal_.tally.abstain = proposal_.tally.abstain - votingPower;
        }

        // write the updated/new vote for the voter.
        if (_voteOption == VoteOption.Yes) {
            proposal_.tally.yes = proposal_.tally.yes + votingPower;
        } else if (_voteOption == VoteOption.No || _voteOption == VoteOption.NoSpam) {
            proposal_.tally.no += votingPower;
            if (_voteOption == VoteOption.NoSpam) spamVotingPower[_proposalId] += votingPower;
        } else if (_voteOption == VoteOption.Abstain) {
            proposal_.tally.abstain = proposal_.tally.abstain + votingPower;
        }

        proposal_.voters[_voter] = _voteOption;

        emit VoteCast({proposalId: _proposalId, voter: _voter, voteOption: _voteOption, votingPower: votingPower});

        if (!_tryEarlyExecution) {
            return;
        }

        if (
            _canExecute(_proposalId)
                && dao().hasPermission(address(this), _voter, EXECUTE_PROPOSAL_PERMISSION_ID, _msgData())
        ) {
            _execute(_proposalId);
        }
    }

    /// @inheritdoc MajorityVotingBase
    function _canVote(uint256 _proposalId, address _account, VoteOption _voteOption)
        internal
        view
        override
        returns (bool)
    {
        Proposal storage proposal_ = proposals[_proposalId];

        // The proposal vote hasn't started or has already ended.
        if (!_isProposalOpen(proposal_)) {
            return false;
        }

        // The voter votes `None` which is not allowed.
        if (_voteOption == VoteOption.None) {
            return false;
        }

        // The voter has no voting power.
        if (_votingPowerAt(_proposalId, _account, proposal_.parameters.snapshotTimepoint) == 0) {
            return false;
        }

        // The voter has already voted but vote replacment is not allowed.
        if (
            proposal_.voters[_account] != VoteOption.None
                && proposal_.parameters.votingMode != VotingMode.VoteReplacement
        ) {
            return false;
        }

        return true;
    }

    /// @dev Helper function to identify the clock mode used by the given voting token.
    function _detectTokenClock() private {
        bool clockModeTimestamp;
        bool clockTimestamp;

        try IERC6372Upgradeable(address(votingToken)).CLOCK_MODE() returns (string memory clockMode) {
            clockModeTimestamp = keccak256(bytes(clockMode)) == keccak256(bytes("mode=timestamp"));
        } catch {}
        try IERC6372Upgradeable(address(votingToken)).clock() returns (uint48 timePoint) {
            clockTimestamp = (timePoint == block.timestamp);
        } catch {}

        if (clockModeTimestamp != clockTimestamp) {
            revert TokenClockMismatch();
        } else if (clockModeTimestamp) {
            tokenIndexedByTimestamp = true;
        } else {
            // Assuming that the token indexes by block number
        }
    }

    /// @dev Helper function to avoid stack too deep in non via-ir compilation mode.
    function _emitProposalCreatedEvent(
        bytes calldata _metadata,
        Action[] calldata _actions,
        uint256 _allowFailureMap,
        uint256 proposalId,
        uint64 _startDate,
        uint64 _endDate
    ) private {
        emit ProposalCreated(proposalId, _msgSender(), _startDate, _endDate, _metadata, _actions, _allowFailureMap);
    }

    /// @dev This empty reserved space is put in place to allow future versions to add new
    /// variables without shifting down storage in the inheritance chain.
    /// https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
    uint256[47] private __gap;
}
