/* The LIVE SOL quote — the path demo mode never touches.

   tests/sol-rail.test.js runs the rail in demo mode, which returns before
   quoteSol() is ever called. That is exactly how a plain ReferenceError in
   the live quote reached a commit: every SOL quote and every SOL start would
   have thrown on a real server, and the card would have shown the raw error
   where the routes belong. So this file drives the real function with the
   chains and the price APIs stubbed, and checks the money arithmetic it
   produces.

   Run: node tests/sol-quote-live.test.js
*/
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ethers } = require("ethers");

/* ---- stubs, installed BEFORE tools/funding.js is loaded ---- */
const GWEI = 3n * 10n ** 9n;
const KOIN_PER_ETH = 50000;         // the pretend market
const FILL = 0.985;                 // what a quoter guarantees vs quotes

let TRANSIT_ETH = 0n;               // what the Ethereum deposit address holds
const ethBridge = require("../tools/eth/eth-bridge");
ethBridge.makeProvider = async () => ({
  getFeeData: async () => ({ maxFeePerGas: GWEI, gasPrice: GWEI }),
  getBalance: async () => TRANSIT_ETH,
  getBlockNumber: async () => 1,
});

/* start() asks the Vortex bridge whether it is paused before anything moves;
   with a stub provider that is a real contract call, so answer it here. */
const ethBridgeToken = require("../tools/eth/eth-bridge-token");
ethBridgeToken.bridgePaused = async () => false;

const funding = require("../tools/funding");
const jup = require("../tools/sol/jupiter");
const ethSwap = require("../tools/eth/eth-swap");
const swap = require("../tools/eth/eth-swap-exec");
const sol = require("../tools/sol/sol-rpc");
const SC = require("../tools/sol/sol-constants");

/* Jupiter: 1 SOL buys 0.15 ETH (8-dec wormhole units) or 6000 vKOIN. */
jup.quote = async ({ amount, outputMint }) => {
  const solAmt = Number(ethers.formatUnits(BigInt(amount), 9));
  const weth = outputMint === SC.WETH_SOL_MINT;
  const out = weth ? Math.round(solAmt * 0.15 * 1e8) : Math.round(solAmt * 6000 * 1e8);
  return {
    outAmount: String(out), outAmountMin: String(Math.round(out * FILL)),
    priceImpactPct: weth ? 0.01 : 4.2, via: [weth ? "Meteora" : "Raydium"], raw: {},
  };
};
/* Uniswap: linear, so the arithmetic under test is the only thing moving. */
/* ether in dollars, for the fee thresholds */
const ETH_USD = 3700;
ethSwap.quoteUsdtOut = async ({ amountWei }) => ({ usdt: String(Math.round(Number(ethers.formatEther(amountWei)) * ETH_USD * 1e6)) });
ethSwap.quoteEthToVkoin = async ({ amountEth }) => {
  const koin = Number(amountEth) * KOIN_PER_ETH;
  return { koinOut: String(Math.round(koin * 1e8)), koinOutMin: String(Math.round(koin * FILL * 1e8)) };
};
swap.balanceOf = async () => 0n;
sol.makeConnection = async () => ({ rpcEndpoint: "stub" });
/* Balances come over plain JSON-RPC now, not through the Solana packages. */
const solLite = require("../tools/sol/rpc-lite");
solLite.solBalance = async () => ethers.parseUnits("0.35", 9);
solLite.tokenBalance = async () => 0n;

const ACCT = "1LiveSolQuoteAccountXXXXXXXXXXXXXX";
const wei = (n) => ethers.parseEther(String(n));
const koin = (sats) => Number(ethers.formatUnits(BigInt(sats), 8));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solquote-v2-"));
  funding.configure({ dataDir: dir, demo: false, network: "mainnet", gasSponsorKey: "",
    fee: require("../tools/eth/fees").config({ FUND_FEE_TREASURY: "0x3333333333333333333333333333333333333333" }) });
  swap.allowance = async () => 0n;
  funding.enable(ACCT);

  TRANSIT_ETH = wei("1");
  const q = await funding.quoteFor(ACCT, "sol", "0.2");
  const t = q.routes.find((r) => r.id === "T"), s = q.routes.find((r) => r.id === "S");
  assert.ok(t.koinOut && s.koinOut, JSON.stringify(q.routes));
  assert.equal(q.best.id, "T");
  assert.ok(t.quoteId && t.quoteExpiresAt > Date.now());
  assert.equal(t.feeModel, 2);

  // Independent route budgets at 3 gwei: 20% gas headroom and 25% price
  // headroom = 4.5 gwei per unpadded unit. No reset is needed at allowance 0.
  // T tail 885k + optional signature renewal 65k + collection 21k.
  const tailAndCollection = 971000 * 4.5e-9;
  const platform = 0.03 * 0.01;
  assert.ok(Math.abs(koin(t.koinOut) - (0.03 - tailAndCollection - platform) * KOIN_PER_ETH) < 0.01);
  assert.ok(Math.abs(Number(t.feeEth) - (1106000 * 3e-9 + platform)) < 1e-12,
    "expected fees exclude the unused signature-renewal contingency");
  assert.ok(Math.abs(Number(t.maxFeeEth) - (1171000 * 4.5e-9 + platform)) < 1e-12);
  const floor = (0.03 * FILL - tailAndCollection - platform) * KOIN_PER_ETH * FILL;
  assert.ok(Math.abs(koin(t.koinOutMin) - floor) < 0.01,
    "the final minimum accounts for the worst Solana fill and downstream budget");
  assert.equal(t.sponsorMaxEth, "0.0", "existing ETH is used before sponsorship");
  assert.equal(koin(s.koinOut), 1200, "S pays its fees separately in ETH, so do not deduct them twice from KOIN delivery");
  assert.ok(BigInt(s.comparisonKoinOut) < BigInt(s.koinOut), "route ranking still includes separately paid ETH fees");
  console.log("✓ live SOL quotes share the accepted fee plan, include all ETH costs and rank net value");

  TRANSIT_ETH = 0n;
  const empty = await funding.quoteFor(ACCT, "sol", "0.2");
  assert.equal(empty.best, null);
  assert.ok(empty.routes.every((r) => r.koinOut === null && /ETH/.test(r.error)));
  console.log("✓ no sponsor and no ETH means no route is offered before SOL moves");

  TRANSIT_ETH = wei("0.0015");
  const partial = await funding.quoteFor(ACCT, "sol", "0.2");
  assert.ok(partial.routes.find((r) => r.id === "T").quoteId);
  assert.equal(partial.routes.find((r) => r.id === "S").koinOut, null);
  console.log("✓ T can bootstrap from existing ETH when S cannot cover its full ETH tail");

  await assert.rejects(funding.start(ACCT, { asset: "sol", amount: "0.2", route: "T" }), /quote expired/);
  const begun = await funding.start(ACCT, { asset: "sol", amount: "0.2", route: "T", quoteId: partial.best.quoteId });
  assert.equal(begun.status, "sol_swap");
  assert.equal(begun.feeModel, 2);
  const internal = funding.job(ACCT);
  assert.equal(internal.feePlan.id, partial.best.quoteId);
  funding._saveJob(ACCT, { ...internal, status: "error", failedAt: "wh_redeem", pendingEth: { raw: "PRIVATE_SIGNED_BYTES" }, pendingSolRaw: "PRIVATE_SOL_BYTES" });
  assert.ok(!JSON.stringify(funding.publicJob(funding.job(ACCT))).includes("PRIVATE_"));
  assert.throws(() => funding.reset(ACCT), /reconcile/);
  funding._saveJob(ACCT, { ...internal, status: "done", settlementComplete: true, reservationReleased: true });
  funding.reset(ACCT);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, "funding.json"), "utf8"));
  assert.equal(persisted.history[internal.id].id, internal.id, "reset preserves the durable job history");
  assert.equal(persisted.jobs[ACCT], undefined);
  console.log("✓ start binds the quote; private transaction bytes stay private and reset retains history");
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("\nALL LIVE SOL-QUOTE CHECKS PASSED");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
