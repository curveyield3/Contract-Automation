// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
struct CyHopR { uint8 venue; address tokenIn; address tokenOut; address pool; uint24 fee; }
interface IRouterV2 {
 function checkPool(address pool) external view;
 function routeHops(address from, address to) external view returns(CyHopR[] memory);
 function quoteAtSpot(address pool, uint256 amountIn, address tokenIn, address tokenOut) external view returns(uint256);
 function swapExactInput(address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,address recipient,uint256 deadline) external returns(uint256);
}
