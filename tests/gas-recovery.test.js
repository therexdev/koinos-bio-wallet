"use strict";
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const R = require("../tools/eth/gas-recovery");
const RC = require("../tools/eth/route-constants");
const recipient = "0x3333333333333333333333333333333333333333";
// Independently decode the deployed SwapRouter02 shape: it differs from the
// original V3 router by omitting the inner deadline from the swap tuple.
const ABI = new ethers.Interface([
  "function multicall(uint256,bytes[])",
  "function exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160))",
  "function unwrapWETH9(uint256,address)",
]);
for (const asset of ["usdc", "usdt"]) {
  const target = ethers.parseEther("0.002"), max = 7000000n;
  const tx = R.build({ asset, recipient, outputWei: target, maxInput: max, fee: 500, deadline: 2000000000 });
  assert.equal(tx.to, RC.V3_SWAP_ROUTER); assert.equal(tx.value, 0n);
  const [deadline, calls] = ABI.decodeFunctionData("multicall", tx.data);
  assert.equal(deadline, 2000000000n); assert.equal(calls.length, 2);
  const [params] = ABI.decodeFunctionData("exactOutputSingle", calls[0]);
  assert.equal(params[0], asset === "usdc" ? RC.USDC : RC.USDT);
  assert.equal(params[1], RC.WETH); assert.equal(params[3], RC.V3_SWAP_ROUTER);
  assert.equal(params[4], target); assert.equal(params[5], max);
  const [minimum, to] = ABI.decodeFunctionData("unwrapWETH9", calls[1]);
  assert.equal(minimum, target); assert.equal(to, recipient);
}
assert.throws(() => R.build({ asset: "vkoin", recipient, outputWei: 1, maxInput: 1, fee: 500, deadline: 1 }), /supports/);
assert.throws(() => R.build({ asset: "usdt", recipient, outputWei: 0, maxInput: 1, fee: 500, deadline: 1 }), /Invalid/);
console.log("✓ recovery calldata fixes the ETH output, caps token input, unwraps atomically and enforces an outer deadline");
