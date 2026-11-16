// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;
/// @notice LIVE FORK SIMULATION ONLY. MUST NEVER BE USED FOR PRODUCTION MARKETS.
contract ForkOnlyFixedOracle {
    uint256 public immutable price;
    constructor(uint256 price_) { require(price_ != 0, "ZERO"); price = price_; }
}
