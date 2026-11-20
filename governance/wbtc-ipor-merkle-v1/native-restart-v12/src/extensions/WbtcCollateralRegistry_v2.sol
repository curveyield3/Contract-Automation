// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.18;

/// @notice Interfaces are intentionally read-only.  No additional collateral
///         adapter, oracle, escrow or voting contract is deployed.
interface IWbtcMorphoPosition {
    function position(bytes32 marketId, address borrower)
        external view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);
    function market(bytes32 marketId) external view returns (
        uint128 totalSupplyAssets, uint128 totalSupplyShares,
        uint128 totalBorrowAssets, uint128 totalBorrowShares,
        uint128 lastUpdate, uint128 fee
    );
}

interface IWbtcCurveLendController {
    function collateral_token() external view returns (address);
    function factory() external view returns (address);
    function user_state(address account) external view returns (uint256[4] memory);
}

interface IWbtcCurveLendFactory {
    function markets(uint256 marketIndex) external view returns (
        address vault, address controller, address amm, address collateralToken,
        address borrowedToken, address priceOracle, address monetaryPolicy
    );
}

interface IWbtcEulerCollateralVault {
    function asset() external view returns (address);
    function EVC() external view returns (address);
    function balanceOf(address account) external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
}

interface IWbtcEVC {
    function isCollateralEnabled(address account, address collateralVault) external view returns (bool);
    function getAccountOwner(address account) external view returns (address);
}

interface IWbtcVaultVotes {
    function delegates(address account) external view returns (address);
    function getVotes(address account) external view returns (uint256);
}

/// @notice Composable internal collateral registry. Deployed as part of the
///         adapted TokenVoting runtime, NOT as another deployed contract.
/// @dev The existing Aragon TokenVoting and IPOR Votes implementation files
///      remain untouched. External market reads are live and are committed to
///      a ballot only by _freezeListedCollateral() in its creation transaction.
abstract contract WbtcCollateralRegistry {
    enum MarketKind { None, MorphoBlue, CurveLend, EulerEVK }

    struct ApprovedMarket {
        MarketKind kind;
        address protocol; // Morpho core, CurveLend controller, or Euler eVault
        address auxiliary; // CurveLend factory or Euler EVC; zero for Morpho
        bytes32 marketId; // Morpho Blue's genuine market ID
        bool approved;
        uint64 epoch; // incremented whenever the market is reconfigured
    }

    struct CollateralEntry {
        address delegate;
        address market;
        address account; // Euler sub-account (or same address for Morpho/Curve)
        uint64 marketEpoch;
    }

    mapping(address => ApprovedMarket) public approvedMarkets;
    address[] internal marketKeys;
    mapping(address => bool) internal marketKeySeen;
    mapping(bytes32 => address) public uniqueMarketSource;

    CollateralEntry[] internal entries;
    mapping(bytes32 => uint256) internal entryIndexPlusOne;
    mapping(address => uint256) public registeredCollateralPositions;

    // Values in underlying WBTC IPOR vault SHARE units, already weighted 50%.
    mapping(uint256 => mapping(address => uint256)) internal frozenCollateralVotingPower;
    mapping(uint256 => uint256) public frozenCollateralTotal;
    mapping(uint256 => uint256) public frozenCollateralEntryCount;

    uint256 public minDelegatedCollateral; // default 0, measured in raw vault-share units
    uint16 public collateralPenaltyBps; // default 5000: 50% reduced voting weight
    uint256 public maxAutomaticSnapshotEntries; // initialized by the TokenVoting proxy initializer
    bytes32 public collateralMarketConfigurationDigest;
    uint256 public collateralMarketConfigurationNonce;

    error CollateralNotApproved(address market);
    error InvalidCollateralMarket();
    error InvalidCollateralDelegate();
    error InsufficientCollateral(address delegate, address market);
    error UnauthorizedCollateralConfiguration();
    error InvalidCollateralAccount();
    error AutomaticSnapshotRequiresMerkle(uint256 enrolled, uint256 maximum);

    event CollateralDelegationRegistered(address indexed delegate, address indexed market, address indexed account);
    event CollateralDelegationRemoved(address indexed delegate, address indexed market, address indexed account);
    event CollateralMarketConfigured(address indexed market, MarketKind kind, address protocol, bool approved);
    event MinimumDelegatedCollateralUpdated(uint256 minimum);
    event CollateralPenaltyUpdated(uint16 penaltyBps);
    event MaximumAutomaticSnapshotEntriesUpdated(uint256 maximum);
    event CollateralSnapshotFrozen(uint256 indexed ballotId, uint256 checkedEntries, uint256 weightedShares);

    function _votingShareToken() internal view virtual returns (address);
    function _governanceDAO() internal view virtual returns (address);

    modifier onlyGovernanceDAO() {
        if (msg.sender != _governanceDAO()) revert UnauthorizedCollateralConfiguration();
        _;
    }

    function marketCount() external view returns (uint256) { return marketKeys.length; }
    function marketKeyAt(uint256 index) external view returns (address) { return marketKeys[index]; }
    function collateralEntryCount() external view returns (uint256) { return entries.length; }
    function collateralEntryAt(uint256 index) external view returns (CollateralEntry memory) { return entries[index]; }
    function isCollateralEntryRegistered(address delegate, address market, address account) public view returns (bool) {
        return entryIndexPlusOne[_entryKey(delegate, market, account)] != 0;
    }
    function frozenCollateralPower(uint256 snapshotKey, address delegate) external view returns (uint256) {
        // snapshotKey = uint256(keccak256(abi.encode(parentSPP,parentId)))
        return frozenCollateralVotingPower[snapshotKey][delegate];
    }

    /// @notice Configure a single approved market via native DAO execution.
    /// @param market Unique registry address. For Morpho, which uses a bytes32
    ///        market ID behind one core address, additional markets MUST use
    ///        distinct agreed registry addresses; never conflate IDs.
    /// @param protocol Core Morpho contract, CurveLend controller or Euler vault.
    /// @param configuration Morpho: abi.encode(marketId,loanToken,oracle,irm,lltv).
    ///        CurveLend: abi.encode(factory,marketIndex).
    ///        Euler: abi.encode(evc). All are authenticated on configuration.
    function configureCollateralMarket(
        address market, MarketKind kind, address protocol, bytes calldata configuration, bool approved
    ) external onlyGovernanceDAO {
        if (market == address(0)) revert InvalidCollateralMarket();
        ApprovedMarket storage current = approvedMarkets[market];
        if (current.approved) {
            bytes32 oldSource = _marketSourceKey(current.kind, current.protocol, current.marketId);
            if (uniqueMarketSource[oldSource] == market) delete uniqueMarketSource[oldSource];
        }
        if (!approved) {
            if (!current.approved) revert CollateralNotApproved(market);
            current.approved = false;
        } else {
            if (kind == MarketKind.None || protocol.code.length == 0) revert InvalidCollateralMarket();
            address auxiliary;
            bytes32 id;
            if (kind == MarketKind.MorphoBlue) {
                (bytes32 marketId, address loanToken, address oracle, address irm, uint256 lltv) =
                    abi.decode(configuration, (bytes32,address,address,address,uint256));
                // MarketParamsLib.id() = keccak256(abi.encode(marketParams)).
                id = keccak256(abi.encode(loanToken, _votingShareToken(), oracle, irm, lltv));
                if (marketId == bytes32(0) || id != marketId) revert InvalidCollateralMarket();
                (,,,,uint128 lastUpdate,) = IWbtcMorphoPosition(protocol).market(id);
                if (lastUpdate == 0) revert InvalidCollateralMarket();
            } else if (kind == MarketKind.CurveLend) {
                uint256 marketIndex;
                (auxiliary, marketIndex) = abi.decode(configuration, (address,uint256));
                if (market != protocol || auxiliary.code.length == 0
                    || IWbtcCurveLendController(protocol).collateral_token() != _votingShareToken()
                    || IWbtcCurveLendController(protocol).factory() != auxiliary)
                    revert InvalidCollateralMarket();
                (, address controller,,address collateralToken,,,) =
                    IWbtcCurveLendFactory(auxiliary).markets(marketIndex);
                if (controller != protocol || collateralToken != _votingShareToken())
                    revert InvalidCollateralMarket();
            } else if (kind == MarketKind.EulerEVK) {
                auxiliary = abi.decode(configuration, (address));
                if (market != protocol || auxiliary.code.length == 0
                    || IWbtcEulerCollateralVault(protocol).asset() != _votingShareToken()
                    || IWbtcEulerCollateralVault(protocol).EVC() != auxiliary)
                    revert InvalidCollateralMarket();
            } else revert InvalidCollateralMarket();
            bytes32 sourceKey = _marketSourceKey(kind, protocol, id);
            if (uniqueMarketSource[sourceKey] != address(0)
                && uniqueMarketSource[sourceKey] != market) revert InvalidCollateralMarket();
            uniqueMarketSource[sourceKey] = market;
            current.kind = kind;
            current.protocol = protocol;
            current.auxiliary = auxiliary;
            current.marketId = id;
            current.approved = true;
            if (!marketKeySeen[market]) {
                marketKeySeen[market] = true;
                marketKeys.push(market);
            }
        }
        unchecked { ++current.epoch; }
        _recordConfigurationChange(market, kind, protocol, configuration, approved);
        emit CollateralMarketConfigured(market, kind, protocol, approved);
    }

    /// @notice 0 allows every strictly-positive amount of collateral.
    ///         Changing the minimum never alters an already frozen ballot.
    function setMinDelegatedCollateral(uint256 minimum) external onlyGovernanceDAO {
        minDelegatedCollateral = minimum;
        _recordConfigurationChange(address(0), MarketKind.None, address(0), abi.encode(minimum), true);
        emit MinimumDelegatedCollateralUpdated(minimum);
    }

    /// @notice Discount collateral voting units by a configurable percentage.
    /// @dev A proposal's raw positions and this percentage are frozen together;
    ///      later changes are future-only. 10,000 = 100%, zero = no penalty.
    function setCollateralPenalty(uint16 penaltyBps) external onlyGovernanceDAO {
        if (penaltyBps > 10000) revert InvalidCollateralMarket();
        collateralPenaltyBps = penaltyBps;
        _recordConfigurationChange(address(0), MarketKind.None, address(0), abi.encode(penaltyBps), true);
        emit CollateralPenaltyUpdated(penaltyBps);
    }

    function _weightedCollateral(uint256 rawShares, uint16 penaltyBps)
        internal pure returns (uint256)
    {
        return rawShares * (10000 - uint256(penaltyBps)) / 10000;
    }

    function _recordConfigurationChange(
        address market, MarketKind kind, address protocol, bytes memory data, bool approved
    ) private {
        unchecked { ++collateralMarketConfigurationNonce; }
        collateralMarketConfigurationDigest = keccak256(abi.encode(
            collateralMarketConfigurationDigest, block.chainid, address(this),
            collateralMarketConfigurationNonce, market, kind, protocol, keccak256(data), approved
        ));
    }

    /// @notice Bound execution gas for the automatic route without denying
    ///         registration or the alternative proof route for larger lists.
    function setMaxAutomaticSnapshotEntries(uint256 maximum) external onlyGovernanceDAO {
        if (maximum == 0) revert InvalidCollateralMarket();
        maxAutomaticSnapshotEntries = maximum;
        _recordConfigurationChange(address(0), MarketKind.None, address(0), abi.encode(maximum), true);
        emit MaximumAutomaticSnapshotEntriesUpdated(maximum);
    }

    /// @notice Public, permissionless self-account registration for any active
    ///         IPOR share delegate holding collateral in an approved market.
    function delegatecollateral(address delegate, address market) external {
        _registerCollateral(delegate, market, delegate);
    }

    /// @notice Euler EVC supports sub-accounts. A secondary registration
    ///         binds a sub-account to its actual EVC owner, rather than
    ///         assigning another account's collateral to an arbitrary voter.
    function delegateEulerSubaccount(address delegate, address market, address account) external {
        ApprovedMarket storage m = approvedMarkets[market];
        if (!m.approved || m.kind != MarketKind.EulerEVK) revert CollateralNotApproved(market);
        if (account == delegate || IWbtcEVC(m.auxiliary).getAccountOwner(account) != delegate)
            revert InvalidCollateralAccount();
        _registerCollateral(delegate, market, account);
    }

    function _registerCollateral(address delegate, address market, address account) internal {
        ApprovedMarket storage m = approvedMarkets[market];
        if (!m.approved) revert CollateralNotApproved(market);
        if (delegate == address(0)) revert InvalidCollateralDelegate();
        // A direct-vote delegatee or self-delegated collateral-only account
        // qualifies; otherwise the holder must first activate IPOR delegation.
        IWbtcVaultVotes votes = IWbtcVaultVotes(_votingShareToken());
        if (votes.delegates(delegate) != delegate && votes.getVotes(delegate) == 0)
            revert InvalidCollateralDelegate();
        if (m.kind != MarketKind.EulerEVK && account != delegate) revert InvalidCollateralAccount();
        uint256 rawShares = _collateralShares(m, account);
        if (rawShares == 0 || rawShares < minDelegatedCollateral)
            revert InsufficientCollateral(delegate, market);
        bytes32 key = _entryKey(delegate, market, account);
        if (entryIndexPlusOne[key] != 0) {
            // Refresh an entry after its market's governance-approved
            // reconfiguration. Old market versions are never counted.
            entries[entryIndexPlusOne[key] - 1].marketEpoch = m.epoch;
            return;
        }
        entries.push(CollateralEntry(delegate, market, account, m.epoch));
        entryIndexPlusOne[key] = entries.length;
        ++registeredCollateralPositions[delegate];
        emit CollateralDelegationRegistered(delegate, market, account);
    }

    /// @notice Permissionless incremental cleanup; only entries below the
    ///         active minimum or with zero balance are deleted. A market read
    ///         reverting fails the check rather than erasing voting rights.
    function pruneCollateralEntries(uint256 fromIndex, uint256 maximumChecks) external returns (uint256 checked, uint256 removed) {
        uint256 i = fromIndex;
        while (i < entries.length && checked < maximumChecks) {
            CollateralEntry memory e = entries[i];
            ++checked;
            if (!_eligibleCollateral(e)) { _removeEntry(i); ++removed; }
            else { ++i; }
        }
    }

    function _activeCollateralDelegate(address delegatee) internal view returns (bool) {
        IWbtcVaultVotes votes = IWbtcVaultVotes(_votingShareToken());
        return votes.delegates(delegatee) == delegatee || votes.getVotes(delegatee) != 0;
    }

    function _eligibleCollateral(CollateralEntry memory e) internal view returns (bool) {
        ApprovedMarket storage m = approvedMarkets[e.market];
        if (!_activeCollateralDelegate(e.delegate)) return false;
        if (!m.approved || e.marketEpoch != m.epoch) return false;
        if (m.kind == MarketKind.EulerEVK && e.account != e.delegate
            && IWbtcEVC(m.auxiliary).getAccountOwner(e.account) != e.delegate) return false;
        uint256 shares = _collateralShares(m, e.account);
        return shares > 0 && shares >= minDelegatedCollateral;
    }

    function _freezeListedCollateral(uint256 snapshotKey) internal {
        if (entries.length > maxAutomaticSnapshotEntries)
            revert AutomaticSnapshotRequiresMerkle(entries.length, maxAutomaticSnapshotEntries);
        // Called exactly once by the native TokenVoting child-proposal
        // creation pathway. The list is checked and invalid entries removed
        // in the SAME TRANSACTION as the proposal snapshot is committed.
        uint256 i;
        uint256 seen;
        uint256 totalWeighted;
        while (i < entries.length) {
            CollateralEntry memory e = entries[i];
            ApprovedMarket storage m = approvedMarkets[e.market];
            uint256 shares;
            if (m.approved && e.marketEpoch == m.epoch) shares = _collateralShares(m, e.account);
            ++seen;
            if (!m.approved || e.marketEpoch != m.epoch || !_activeCollateralDelegate(e.delegate)
                || shares == 0 || shares < minDelegatedCollateral) {
                _removeEntry(i);
                continue;
            }
            // An Euler EVC ownership change must not redirect collateral
            // of an existing sub-account to a stale registered delegate.
            if (m.kind == MarketKind.EulerEVK && e.account != e.delegate
                && IWbtcEVC(m.auxiliary).getAccountOwner(e.account) != e.delegate) {
                _removeEntry(i);
                continue;
            }
            // Use the penalty rate CURRENT AT PARENT CREATION; future
            // configuration changes cannot mutate this frozen snapshot.
            uint256 weighted = _weightedCollateral(shares, collateralPenaltyBps);
            frozenCollateralVotingPower[snapshotKey][e.delegate] += weighted;
            totalWeighted += weighted;
            ++i;
        }
        frozenCollateralEntryCount[snapshotKey] = seen;
        frozenCollateralTotal[snapshotKey] = totalWeighted;
        emit CollateralSnapshotFrozen(snapshotKey, seen, totalWeighted);
    }

    function _removeEntry(uint256 i) internal {
        CollateralEntry memory old = entries[i];
        bytes32 oldKey = _entryKey(old.delegate, old.market, old.account);
        uint256 last = entries.length - 1;
        if (i != last) {
            CollateralEntry memory moved = entries[last];
            entries[i] = moved;
            entryIndexPlusOne[_entryKey(moved.delegate, moved.market, moved.account)] = i + 1;
        }
        entries.pop();
        delete entryIndexPlusOne[oldKey];
        --registeredCollateralPositions[old.delegate];
        emit CollateralDelegationRemoved(old.delegate, old.market, old.account);
    }

    function _marketSourceKey(MarketKind kind, address protocol, bytes32 id)
        internal pure returns (bytes32)
    {
        return keccak256(abi.encode(kind, protocol, id));
    }

    function _entryKey(address delegate, address market, address account) internal pure returns (bytes32) {
        return keccak256(abi.encode(delegate, market, account));
    }

    function _collateralShares(ApprovedMarket storage m, address account) internal view returns (uint256) {
        if (m.kind == MarketKind.MorphoBlue) {
            (,,uint128 collateral) = IWbtcMorphoPosition(m.protocol).position(m.marketId, account);
            return uint256(collateral);
        }
        if (m.kind == MarketKind.CurveLend) {
            // Official LLAMMA controller.user_state returns [collateral,
            // borrowed-token amount, debt, number of bands].
            uint256[4] memory state = IWbtcCurveLendController(m.protocol).user_state(account);
            return state[0];
        }
        if (m.kind == MarketKind.EulerEVK) {
            if (!IWbtcEVC(m.auxiliary).isCollateralEnabled(account, m.protocol)) return 0;
            uint256 eVaultShares = IWbtcEulerCollateralVault(m.protocol).balanceOf(account);
            return IWbtcEulerCollateralVault(m.protocol).convertToAssets(eVaultShares);
        }
        revert InvalidCollateralMarket();
    }
}
