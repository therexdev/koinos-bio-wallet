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
ethSwap.quoteEthToVkoin = async ({ amountEth }) => {
  const koin = Number(amountEth) * KOIN_PER_ETH;
  return { koinOut: String(Math.round(koin * 1e8)), koinOutMin: String(Math.round(koin * FILL * 1e8)) };
};
swap.balanceOf = async () => 0n;
sol.makeConnection = async () => ({ rpcEndpoint: "stub" });
sol.solBalance = async () => ethers.parseUnits("0.35", 9);
sol.tokenBalance = async () => 0n;

const ACCT = "1LiveSolQuoteAccountXXXXXXXXXXXXXX";
const wei = (n) => ethers.parseEther(String(n));
const koin = (sats) => Number(ethers.formatUnits(BigInt(sats), 8));

function boot({ sponsor }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solquote-"));
  process.env.ETH_GAS_SPONSOR_KEY = sponsor ? "0x" + "11".repeat(32) : "";
  delete require.cache[require.resolve("../tools/funding")];
  return dir;
}

(async () => {
  /* The sponsor key is read into config at require time, so drive it through
     the exported knob instead of reloading the module. */
  funding.configure({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "solquote-")), demo: false, network: "mainnet" });
  assert.ok(await funding._sdkReady(), "the Wormhole SDK loads");
  funding.enable(ACCT);

  /* Gas, at 3 gwei with the 50% headroom the reserve uses:
       the Ethereum swaps  900_000 × 1.5 × 3 gwei = 0.00405 ETH
       the Wormhole redeem 150_000 × 1.5 × 3 gwei = 0.000675 ETH
       the Vortex tail     260_000 × 1.5 × 3 gwei = 0.00117 ETH  */
  const RESERVE = 0.00405, REDEEM = 0.000675, VORTEX = 0.00117;

  /* --- 1. it runs at all, which is the regression this file exists for --- */
  {
    TRANSIT_ETH = wei("1");            // plenty, so nothing is gated on gas
    const q = await funding.quoteFor(ACCT, "sol", "0.2");
    assert.strictEqual(q.asset, "sol", "the quote names its asset — this threw ReferenceError once");
    assert.strictEqual(q.amount, "0.2");
    assert.deepStrictEqual(q.routes.map((r) => r.id).sort(), ["S", "T"]);
    assert.ok(q.best, "a live SOL quote produces a usable route");
    console.log("✓ the live SOL quote runs and names both routes");
  }

  /* --- 2. route T's numbers, checked by hand --- */
  {
    TRANSIT_ETH = wei("1");
    const q = await funding.quoteFor(ACCT, "sol", "0.2");
    const t = q.routes.find((r) => r.id === "T");
    /* 0.2 SOL → 0.03 ETH; less the 0.00405 reserve = 0.02595 spent. */
    const spend = 0.2 * 0.15 - RESERVE;
    const feeKoin = REDEEM * KOIN_PER_ETH;
    assert.strictEqual(t.ethBought, "0.03", "what the SOL buys in ether");
    assert.ok(Math.abs(koin(t.koinOut) - (spend * KOIN_PER_ETH - feeKoin)) < 0.01,
      `route T lands the ether it did not hold back, less the redeem: ${koin(t.koinOut)}`);
    assert.ok(Math.abs(Number(t.feeEth) - (RESERVE + REDEEM)) < 1e-9, "and says what the whole thing costs in gas");

    /* The floor must assume Jupiter fills at ITS threshold, not its mid. */
    const worstArrived = 0.2 * 0.15 * FILL;
    const floor = (worstArrived - RESERVE) * KOIN_PER_ETH * FILL - feeKoin;
    assert.ok(Math.abs(koin(t.koinOutMin) - floor) < 0.01,
      `the floor is priced on the worst Solana fill: ${koin(t.koinOutMin)} vs ${floor}`);
    /* The bug this replaces: pricing the floor on the EXPECTED fill, which
       lands above what the route can actually guarantee. */
    const naive = (0.2 * 0.15 - RESERVE) * KOIN_PER_ETH * FILL - feeKoin;
    assert.ok(koin(t.koinOutMin) < naive - 1, "and is genuinely below the optimistic figure it used to print");
    assert.ok(koin(t.koinOutMin) < koin(t.koinOut), "a floor is below the expectation");
    console.log("✓ route T: net of its own gas, with a floor that assumes the worst fill on both legs");
  }

  /* --- 3. route S is charged the gas the platform spends for it --- */
  {
    TRANSIT_ETH = wei("1");
    const q = await funding.quoteFor(ACCT, "sol", "0.2");
    const s = q.routes.find((r) => r.id === "S");
    const gross = 0.2 * 6000;
    const feeKoin = (REDEEM + VORTEX) * KOIN_PER_ETH;
    assert.ok(Math.abs(koin(s.koinOut) - (gross - feeKoin)) < 0.01, `route S is quoted net of its Ethereum tail: ${koin(s.koinOut)}`);
    assert.ok(Math.abs(Number(s.feeEth) - (REDEEM + VORTEX)) < 1e-9);
    /* Nobody is sponsoring in this run, so it must not claim otherwise. */
    assert.strictEqual(s.feePaidBy, "deposit", "with no sponsor the fees come out of the deposit, and the card must say so");
    /* 0.2 SOL is 1200 KOIN through the Solana pool but 1297.5 through the
       deeper Ethereum one, and the fees only widen it — so the ranking picks
       route T, and does so on the net numbers rather than the gross. */
    const t2 = q.routes.find((r) => r.id === "T");
    assert.ok(koin(t2.koinOut) > koin(s.koinOut), "route T lands more");
    assert.strictEqual(q.best.id, "T", "and the ranking follows the maths");
    assert.ok(koin(s.koinOut) < gross, "route S is ranked on what it nets, not on its gross output");
    console.log("✓ route S carries the cost of the tail somebody has to pay for it");
  }

  /* --- 4. no sponsor and an empty deposit address: neither route pretends --- */
  {
    TRANSIT_ETH = 0n;
    const q = await funding.quoteFor(ACCT, "sol", "0.2");
    assert.strictEqual(q.best, null, "nothing can run, so nothing is offered");
    for (const r of q.routes) {
      assert.strictEqual(r.koinOut, null);
      assert.match(r.error, /needs gas/, `route ${r.id} says why: ${r.error}`);
    }
    await assert.rejects(funding.start(ACCT, { asset: "sol", amount: "0.2" }), /gas|quoted/,
      "and start refuses before any SOL moves");
    console.log("✓ with no sponsor and no ether, both routes are refused up front");
  }

  /* --- 5. enough for the redeem but not for route S's whole tail --- */
  {
    /* max(redeem, ETH_GAS_MIN) is affordable; redeem + Vortex is not. */
    TRANSIT_ETH = wei("0.0015");
    const q = await funding.quoteFor(ACCT, "sol", "0.2");
    const t = q.routes.find((r) => r.id === "T");
    const s = q.routes.find((r) => r.id === "S");
    assert.ok(t.koinOut != null, "route T only needs the redeem paid for, and brings the rest with it");
    assert.strictEqual(s.koinOut, null, "route S needs its whole Ethereum tail funded, and cannot be");
    assert.match(s.error, /needs gas/);
    assert.strictEqual(q.best.id, "T");
    console.log("✓ the route that brings its own gas survives where the other cannot");
  }

  console.log("\nALL LIVE SOL-QUOTE CHECKS PASSED");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
