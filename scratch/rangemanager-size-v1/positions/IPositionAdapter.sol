// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
// COMPILATION PLACEHOLDER ONLY: original IPositionAdapter.sol was not supplied.
struct SafeCall { address to; uint256 value; bytes data; }
interface IPositionAdapter {
 function exitCalls(bytes calldata data,uint256 fractionE18,address recipient) external view returns (SafeCall[] memory pre, SafeCall[] memory post, address[] memory outTokens, uint256[] memory auxiliary);
 function guard(bytes calldata data,address account) external view;
 function addShares(bytes calldata data) external view returns(address[] memory tokens,uint256[] memory shares);
 function addCalls(bytes calldata data,address[] calldata tokens,uint256[] calldata amounts,address recipient) external view returns(SafeCall[] memory calls);
}
