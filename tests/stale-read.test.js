/* A confirmed swap must be read from its own receipt, not from a second
   balance query.

   This is the bug that cost a real swap on mainnet. The USDT→vKOIN swap
   landed, but the follow-up balanceOf was served by a node one block behind,
   so it still reported zero vKOIN. The job called a successful swap a
   failure — and Retry then re-sent the same swap, whose USDT was by then
   genuinely spent, producing a second and far more confusing error
   ("execution reverted (unknown custom error)") on top of the first.

   Three things have to hold, and each is checked here:
     1. the amount comes from the receipt's own Transfer logs (no second read,
        so no lag), falling back to a balance read pinned to that block;
     2. a step that fails anyway reconciles against real balances and carries
        on, rather than parking at "error";
     3. Retry resumes from where the money actually is, never replaying a
        swap whose input is already spent.
*/
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");

/* Seams: the Ethereum provider and the token reads, swapped before
   funding.js destructures them. */
const BRIDGE_MOD = require.resolve("../tools/eth/eth-bridge");
const SWAP_MOD = require.resolve("../tools/eth/eth-swap-exec");
require(BRIDGE_MOD); require(SWAP_MOD);

let RECEIPT = null;
let FEE = { maxFeePerGas: null, gasPrice: null };
const PROVIDER = {
  getTransactionReceipt: async () => RECEIPT,
  getFeeData: async () => FEE,
};
require.cache[BRIDGE_MOD].exports = {
  ...require.cache[BRIDGE_MOD].exports,
  makeProvider: async () => PROVIDER,
};

const realSwap = require.cache[SWAP_MOD].exports;
let CHAIN_BAL = {};              // token → bigint, what balanceOf reports
const BAL_CALLS = [];
require.cache[SWAP_MOD].exports = {
  ...realSwap,
  balanceOf: async (_p, token, _owner, blockTag) => {
    BAL_CALLS.push({ token, blockTag });
    return CHAIN_BAL[token.toLowerCase()] ?? 0n;
  },
};

const RC = require("../tools/eth/route-constants");
const funding = require("../tools/funding");

const ACCOUNT = "1StaleReadTestAccountXXXXXXXXXXXXX";
const KEY = "0x" + "11".repeat(32);
const OWNER = new ethers.Wallet(KEY).address;
const VKOIN_OUT = 12270000000n;  // 122.7 vKOIN, 8 decimals
const USDT_IN = 1240000n;        // 1.24 USDT, 6 decimals

const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const pad = (a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const transferLog = (token, from, to, value) => ({
  address: token, topics: [TRANSFER, pad(from), pad(to)],
  data: ethers.zeroPadValue(ethers.toBeHex(value), 32),
});
const ZERO = "0x0000000000000000000000000000000000000000";

/** A job mid-Route-C with a confirmed-but-unread swap transaction. */
function parked(job) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-"));
  fs.writeFileSync(path.join(dir, "funding.json"), JSON.stringify({
    transit: { [ACCOUNT]: { ethAddress: OWNER, ethPriv: KEY, ts: Date.now() } },
    jobs: {
      [ACCOUNT]: {
        asset: "eth", route: "C", koinosRecipient: ACCOUNT, ethFrom: OWNER,
        amountLabel: "0.0005 ETH", slippageBps: 150, startedAt: Date.now(), taps: 0,
        ...job,
      },
    },
  }));
  funding.configure({ dataDir: dir, demo: false, network: "mainnet" });
  BAL_CALLS.length = 0;
}

(async () => {
  /* --- 1. the receipt is the source of truth --- */
  {
    const r = { status: 1, blockNumber: 21000000, logs: [
      transferLog(RC.USDT, OWNER, "0x1111111111111111111111111111111111111111", USDT_IN),
      transferLog(RC.VKOIN, ZERO, OWNER, VKOIN_OUT),
    ] };
    assert.strictEqual(realSwap.receivedInTx(r, RC.VKOIN, OWNER), VKOIN_OUT, "logs give the delivered amount");
    assert.strictEqual(realSwap.receivedInTx(r, RC.USDT, OWNER), -USDT_IN, "an outgoing transfer nets negative");
    assert.strictEqual(realSwap.receivedInTx(r, RC.USDC, OWNER), null, "a token that logged nothing returns null, not zero");
    console.log("✓ receivedInTx reads deliveries, nets spends, and admits when it can't tell");
  }

  /* --- 2. THE BUG: balanceOf lags, the receipt does not --- */
  {
    parked({ status: "swap_usdt_vkoin", pendingTx: "0xswap", usdtSats: String(USDT_IN), vkoinBefore: "0" });
    RECEIPT = { status: 1, blockNumber: 21000000, logs: [transferLog(RC.VKOIN, ZERO, OWNER, VKOIN_OUT)] };
    CHAIN_BAL = { [RC.VKOIN.toLowerCase()]: 0n };   // the lagging node: "no vKOIN"
    await funding.tick();
    const j = funding.job(ACCOUNT);
    assert.strictEqual(j.status, "approve_bridge", "a landed swap must not be called a failure by a stale read");
    assert.strictEqual(j.vkoinSats, String(VKOIN_OUT), "and the amount comes from the receipt");
    assert.strictEqual(j.error, undefined);
    console.log("✓ a swap that landed advances even when balanceOf still says zero");
  }

  /* --- 3. fallback read is pinned to the transaction's own block --- */
  {
    parked({ status: "swap_usdt_vkoin", pendingTx: "0xswap", usdtSats: String(USDT_IN), vkoinBefore: "0" });
    RECEIPT = { status: 1, blockNumber: 21000123, logs: [] };  // token logged nothing standard
    CHAIN_BAL = { [RC.VKOIN.toLowerCase()]: VKOIN_OUT };
    await funding.tick();
    const j = funding.job(ACCOUNT);
    assert.strictEqual(j.status, "approve_bridge");
    assert.strictEqual(j.vkoinSats, String(VKOIN_OUT));
    assert.ok(BAL_CALLS.some((c) => c.blockTag === 21000123),
      "the fallback must read AT the transaction's block, never at 'latest'");
    console.log("✓ the no-logs fallback reads at the transaction's own block");
  }

  /* --- 4. a step that fails anyway recovers from real balances --- */
  {
    parked({ status: "bridge_token", vkoinSats: String(VKOIN_OUT) });
    RECEIPT = null;
    CHAIN_BAL = { [RC.VKOIN.toLowerCase()]: VKOIN_OUT };
    /* buildTransferTokensTx rejects this recipient, so the step throws. */
    await funding.tick();
    const j = funding.job(ACCOUNT);
    assert.notStrictEqual(j.status, "error", "money still at the address is not a dead end");
    assert.strictEqual(j.status, "approve_bridge", "it reconciles to the step the balances imply");
    assert.ok(j.recovered, "and records what it recovered from");
    console.log("✓ a failing step with funds still on-chain reconciles instead of erroring");
  }

  /* --- 5. recovery is bounded — it must not ping-pong forever --- */
  {
    parked({ status: "bridge_token", vkoinSats: String(VKOIN_OUT), recoveries: 3 });
    RECEIPT = null;
    CHAIN_BAL = { [RC.VKOIN.toLowerCase()]: VKOIN_OUT };
    await funding.tick();
    const j = funding.job(ACCOUNT);
    assert.strictEqual(j.status, "error", "past the cap the real error must surface");
    assert.strictEqual(j.failedAt, "bridge_token");
    console.log("✓ recovery is capped, so a genuinely broken step still reports");
  }

  /* --- 6. Retry resumes from the money, not from the step name --- */
  {
    parked({ status: "error", failedAt: "swap_usdt_vkoin", error: "USDT→vKOIN swap produced no vKOIN",
             usdtSats: String(USDT_IN), vkoinBefore: "0" });
    CHAIN_BAL = { [RC.VKOIN.toLowerCase()]: VKOIN_OUT, [RC.USDT.toLowerCase()]: 0n };
    const out = await funding.resume(ACCOUNT);
    assert.strictEqual(out.status, "approve_bridge",
      "with the vKOIN already bought, Retry must NOT re-run the swap");
    assert.strictEqual(out.vkoinSats, String(VKOIN_OUT));
    console.log("✓ Retry picks up from the vKOIN on-chain instead of replaying a spent swap");
  }

  /* --- 7. reconcile never sweeps more than the job was started for --- */
  {
    parked({ status: "error", failedAt: "approve_permit2", usdtSats: String(USDT_IN) });
    CHAIN_BAL = { [RC.VKOIN.toLowerCase()]: 0n, [RC.USDT.toLowerCase()]: USDT_IN * 10n };
    const out = await funding.resume(ACCOUNT);
    assert.strictEqual(out.status, "approve_permit2");
    assert.strictEqual(out.usdtSats, String(USDT_IN),
      "a later deposit at the same address is not silently pulled into this job");
    console.log("✓ reconcile caps at the amount the user actually asked to swap");
  }

  /* --- 8. the gas reserve is priced from the live fee, not a flat number.
     A fixed 0.0024 ETH reserve left 0.00006 ETH of a 0.00246 balance
     spendable — 2% of the money held back for gas costing a fraction of
     that. --- */
  {
    parked({ status: "done" });
    const bal = {
      ethWei: ethers.parseEther("0.00246").toString(), eth: "0.00246",
      usdcSats: "0", usdtSats: "0", vkoinSats: "0",
    };
    FEE = { maxFeePerGas: ethers.parseUnits("1", "gwei"), gasPrice: null };
    let sp = await funding._spendableOf("eth", bal);
    let reserved = ethers.parseEther("0.00246") - sp.sats;
    assert.ok(reserved < ethers.parseEther("0.0015"),
      `at 1 gwei the reserve must be a small slice, held back ${ethers.formatEther(reserved)}`);
    assert.ok(sp.sats > ethers.parseEther("0.001"),
      `most of the balance must stay spendable, got ${sp.label}`);

    /* When gas is genuinely expensive, it reserves more — that is the point. */
    FEE = { maxFeePerGas: ethers.parseUnits("40", "gwei"), gasPrice: null };
    const pricey = await funding._spendableOf("eth", bal);
    assert.ok(pricey.sats < sp.sats, "a higher fee must hold back more, not the same flat amount");

    /* And an unreadable fee falls back rather than letting a job strand. */
    FEE = { maxFeePerGas: null, gasPrice: null };
    const fallback = await funding._spendableOf("eth", bal);
    assert.ok(fallback.sats >= 0n, "an unreadable fee must not throw");
    console.log("✓ gas reserve tracks the live fee (cheap gas no longer eats the deposit)");
  }

  console.log("\nALL STALE-READ CHECKS PASSED");
})().catch((e) => { console.error("FAILED:", e.message, "\n", e.stack); process.exit(1); });
