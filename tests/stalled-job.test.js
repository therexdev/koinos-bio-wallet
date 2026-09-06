/* A job that stops moving has to SAY so.

   This is the failure that stranded a real conversion. 0.1 SOL was swapped
   and handed to Wormhole; the redeem on Ethereum never completed; and the
   card went on showing "Receiving the vKOIN on Ethereum…" with a spinner,
   for as long as anyone cared to watch. Two things made it invisible:

     1. tick() swallowed transient errors — dropProvider() and retry, with
        nothing written down — so a step failing every few seconds looked
        exactly like a step still working;
     2. the Retry button was hidden unless status === 'error', and a job
        looping on a transient error never reaches 'error'. So there was
        no button to press, anywhere.

   And it should not have started at all: with a sponsor key set but an
   empty float, redeemerFor() said "sponsored" without ever asking the
   float whether it could pay, so the quote succeeded and the SOL went
   one-way into the bridge.

   Run: node tests/stalled-job.test.js
*/
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ethers } = require("ethers");

/* Seams installed before funding.js is loaded. */
const BRIDGE_MOD = require.resolve("../tools/eth/eth-bridge");
require(BRIDGE_MOD);
let SPONSOR_WEI = 0n;
let TRANSIT_WEI = 0n;
const GWEI = 3n * 10n ** 9n;
const SPONSOR_KEY = "0x" + "77".repeat(32);
const SPONSOR_ADDR = new ethers.Wallet(SPONSOR_KEY).address;
require.cache[BRIDGE_MOD].exports = {
  ...require.cache[BRIDGE_MOD].exports,
  makeProvider: async () => ({
    getFeeData: async () => ({ maxFeePerGas: GWEI, gasPrice: GWEI }),
    getBalance: async (addr) =>
      (String(addr).toLowerCase() === SPONSOR_ADDR.toLowerCase() ? SPONSOR_WEI : TRANSIT_WEI),
    getBlockNumber: async () => 1,
  }),
};

const funding = require("../tools/funding");
const jup = require("../tools/sol/jupiter");
const SC = require("../tools/sol/sol-constants");
/* Jupiter answers instantly, so what the quote does is decided by the float
   and nothing else. */
jup.quote = async ({ amount, outputMint }) => {
  const solAmt = Number(ethers.formatUnits(BigInt(amount), 9));
  const weth = outputMint === SC.WETH_SOL_MINT;
  const out = Math.round(solAmt * (weth ? 0.15 : 6000) * 1e8);
  return { outAmount: String(out), outAmountMin: String(Math.round(out * 0.985)),
    priceImpactPct: 0.1, via: ["stub"], raw: {} };
};
/* Balances come over contract calls and JSON-RPC; neither is the subject
   here, so both answer from memory. */
const swap = require("../tools/eth/eth-swap-exec");
swap.balanceOf = async () => 0n;
const solLite = require("../tools/sol/rpc-lite");
solLite.solBalance = async () => ethers.parseUnits("0.3", 9);
solLite.tokenBalance = async () => 0n;
const solRpc = require("../tools/sol/sol-rpc");
solRpc.makeConnection = async () => ({ rpcEndpoint: "stub" });

const ethSwap = require("../tools/eth/eth-swap");
ethSwap.quoteEthToVkoin = async ({ amountEth }) => {
  const koin = Number(amountEth) * 50000;
  return { koinOut: String(Math.round(koin * 1e8)), koinOutMin: String(Math.round(koin * 0.985 * 1e8)) };
};
ethSwap.quoteUsdtOut = async ({ amountWei }) =>
  ({ usdt: String(Math.round(Number(ethers.formatEther(amountWei)) * 3700 * 1e6)) });

const ACCT = "1StalledJobTestAccountXXXXXXXXXXXX";
const TRANSIT_KEY = "0x" + "11".repeat(32);
const TRANSIT_ADDR = new ethers.Wallet(TRANSIT_KEY).address;

/* Writing the store directly is how the other suites park a job at a chosen
   step; funding.js reads it on configure(). */
let DIR = null;
function park(job) {
  DIR = DIR || fs.mkdtempSync(path.join(os.tmpdir(), "stalled-"));
  fs.writeFileSync(path.join(DIR, "funding.json"), JSON.stringify({
    transit: { [ACCT]: { ethAddress: TRANSIT_ADDR, ethPriv: TRANSIT_KEY, solAddress: "SoLstubAddressXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", solSecret: "x", ts: Date.now() } },
    jobs: job ? { [ACCT]: { asset: "sol", route: "S", koinosRecipient: ACCT, slippageBps: 150, startedAt: Date.now(), ...job } } : {},
  }));
  funding.configure({ dataDir: DIR, demo: false, network: "mainnet", gasSponsorKey: SPONSOR_KEY });
  return funding.job(ACCT);
}
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), "stalled-"));

(async () => {
  park(null);

  /* --- 1. an empty float is not a sponsor --- */
  {
    SPONSOR_WEI = 0n; TRANSIT_WEI = 0n;
    const q = await funding.quoteFor(ACCT, "sol", "0.1").catch((e) => ({ error: String(e.message || e) }));
    const routes = (q.routes || []).filter((r) => r.koinOut != null);
    assert.strictEqual(routes.length, 0,
      "with an empty float and an empty deposit address, no SOL route may be offered");
    const why = q.error || (q.routes || []).map((r) => r.error).join(" ");
    assert.match(why, /needs gas|ETH_GAS_SPONSOR_KEY|deposit address/i,
      `and it must say why, got: ${why}`);
    console.log("✓ an empty float cannot sponsor — the route is refused instead of stranding the deposit");
  }

  /* --- 2. a funded float sponsors again --- */
  {
    SPONSOR_WEI = ethers.parseEther("0.5"); TRANSIT_WEI = 0n;
    const q = await funding.quoteFor(ACCT, "sol", "0.1").catch((e) => ({ error: String(e.message || e) }));
    const priced = (q.routes || []).filter((r) => r.koinOut != null || !/needs gas/i.test(r.error || ""));
    assert.ok(priced.length > 0, "a float with ether in it is allowed to sponsor");
    console.log("✓ a funded float still sponsors (the check gates on money, not on the key)");
  }

  /* --- 3. a job that stops moving reports itself as stalled --- */
  {
    /* The step the real one died on, entered half an hour ago. */
    park({
      status: "wh_redeem", estKoinOut: "97367990000",
      statusAt: Date.now() - 30 * 60 * 1000,
      lastError: "fetch failed", transientCount: 42,
    });
    const pub = funding.publicJob(funding.job(ACCT));
    assert.ok(pub.stalled, "a step sat in for half an hour is stalled");
    assert.ok(pub.stalled.minutes >= 29, `and says how long: ${pub.stalled.minutes}`);
    assert.strictEqual(pub.stalled.lastError, "fetch failed",
      "and carries the reason that was being retried silently");
    console.log("✓ a stuck step is reported as stalled, with how long and why");
  }

  /* --- 4. a step that is merely slow is NOT stalled --- */
  {
    park({ status: "wh_redeem", statusAt: Date.now() - 60 * 1000 });
    const pub = funding.publicJob(funding.job(ACCT));
    assert.ok(!pub.stalled, "a minute in is normal — guardians take longer than that");
    console.log("✓ a slow step is not called stuck");
  }

  /* --- 5. moving on clears the stall and its reason --- */
  {
    const j = park({ status: "wh_redeem", statusAt: Date.now() - 30 * 60 * 1000, lastError: "fetch failed" });
    assert.ok(funding.publicJob(funding.job(ACCT)).stalled, "stalled before the step moves");
    funding._saveJob(ACCT, { ...j, status: "collect_fee" });
    const pub = funding.publicJob(funding.job(ACCT));
    assert.ok(!pub.stalled, "a step that moved on is not stalled");
    assert.strictEqual(pub.lastError, undefined,
      "and does not carry the previous step's complaint into the next stall");
    console.log("✓ moving on clears the stall and the stale reason with it");
  }

  /* --- 6. the never-mined transaction names itself --- */
  {
    park({
      status: "wh_redeem", pendingTx: "0x" + "ab".repeat(32),
      statusAt: Date.now() - 30 * 60 * 1000,
    });
    const pub = funding.publicJob(funding.job(ACCT));
    assert.ok(pub.stalled, "waiting on a receipt for half an hour is stalled");
    assert.match(pub.stalled.pendingTx, /^0xabab/, "and the transaction is named, so it can be looked up");
    console.log("✓ a transaction that never mined is named rather than waited on forever");
  }

  console.log("\nALL STALLED-JOB CHECKS PASSED");
})().catch((e) => { console.error("FAILED:", e.message, "\n", e.stack); process.exit(1); });
