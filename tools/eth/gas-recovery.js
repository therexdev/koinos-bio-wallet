"use strict";

// SwapRouter02 exact-output recovery: stablecoin -> WETH -> native ETH in
// one atomic multicall. The ETH target and maximum input are both enforced.
// ABI source: Uniswap/swap-router-contracts IV3SwapRouter.sol (no inner deadline).
// The enclosing multicall(uint256,bytes[]) supplies the transaction deadline.
const { ethers } = require("ethers");
const RC = require("./route-constants");
const { bps, wei } = require("./gas-accounting");
const QUOTER_ABI = [
  "function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];
const ROUTER_ABI = [
  "function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountIn)",
  "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
  "function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)",
];
function stableToken(asset) {
  if (asset === "usdt") return RC.USDT;
  if (asset === "usdc") return RC.USDC;
  throw new Error("ETH recovery supports USDT and USDC deposits");
}
async function quote({ asset, outputWei, slippageBps, provider }) {
  const token = stableToken(asset), target = wei(outputWei);
  if (target <= 0n) throw new Error("Recovery target must be positive");
  const tolerance = BigInt(slippageBps);
  if (tolerance < 0n || tolerance >= 10000n) throw new Error("Invalid recovery slippage");
  const q = new ethers.Contract(RC.V3_QUOTER, QUOTER_ABI, provider);
  const results = await Promise.allSettled([500, 3000].map(async (fee) => {
    const r = await q.quoteExactOutputSingle.staticCall({ tokenIn: token, tokenOut: RC.WETH,
      amount: target, fee, sqrtPriceLimitX96: 0 });
    return { amountIn: BigInt(r[0]), fee, gasEstimate: BigInt(r[3]) };
  }));
  const available = results.filter((r) => r.status === "fulfilled" && r.value.amountIn > 0n).map((r) => r.value);
  available.sort((a, b) => a.amountIn < b.amountIn ? -1 : a.amountIn > b.amountIn ? 1 : 0);
  if (!available.length) throw new Error(`No executable ${asset.toUpperCase()} to ETH recovery quote; no gas will be advanced`);
  const best = available[0];
  return { ...best, outputWei: target, maxInput: best.amountIn + bps(best.amountIn, tolerance) };
}
function build({ asset, recipient, outputWei, maxInput, fee, deadline }) {
  const token = stableToken(asset), target = wei(outputWei), limit = wei(maxInput);
  if (!ethers.isAddress(recipient) || target <= 0n || limit <= 0n) throw new Error("Invalid ETH recovery transaction");
  if (![500, 3000].includes(Number(fee))) throw new Error("Unsupported recovery pool fee");
  if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new Error("Invalid recovery deadline");
  const iface = new ethers.Interface(ROUTER_ABI);
  const calls = [
    iface.encodeFunctionData("exactOutputSingle", [{ tokenIn: token, tokenOut: RC.WETH,
      fee, recipient: RC.V3_SWAP_ROUTER, amountOut: target, amountInMaximum: limit, sqrtPriceLimitX96: 0 }]),
    iface.encodeFunctionData("unwrapWETH9", [target, recipient]),
  ];
  return { to: RC.V3_SWAP_ROUTER, data: iface.encodeFunctionData("multicall(uint256,bytes[])", [deadline, calls]), value: 0n };
}
module.exports = { quote, build, stableToken, QUOTER_ABI, ROUTER_ABI };
