/* The simulator must never touch a real job — and must undo the one it did.

   A live server that restarts without its sponsor key falls back to demo
   mode. Until now the demo driver then picked up whatever jobs it found,
   including REAL ones mid-bridge, marched them through the fake flow and
   wrote "done" with a fabricated redeem id. The user is told their money
   landed while the transfer is still sitting in the bridge, unclaimed. That
   happened on mainnet.

   Two rules, both checked here:
     1. a job is simulated or it is real, and each driver only ever advances
        its own — including the reverse, where the live driver would spend
        real gas against invented balances;
     2. a real job already carrying a fabricated finish is restored, because
        a guardian-signed bridge record stays claimable and the job can still
        land for real.
*/
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const funding = require("../tools/funding");

const REAL = "1RealAccountAddressXXXXXXXXXXXXXXX";
const SIM = "1DemoAccountAddressXXXXXXXXXXXXXXX";

function store(jobs, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demoiso-"));
  const transit = {};
  for (const a of Object.keys(jobs)) transit[a] = { ethAddress: "0xabc", ethPriv: "0x00", ts: Date.now() };
  fs.writeFileSync(path.join(dir, "funding.json"), JSON.stringify({ transit, jobs }));
  funding.configure({ dataDir: dir, network: "mainnet", ...opts });
  return dir;
}

const realJob = (extra) => ({
  asset: "eth", route: "C", status: "awaiting_redeem", koinosRecipient: REAL,
  amountLabel: "0.0005 ETH", estKoinOut: "12270000000", ethTxHash: "0x" + "ab".repeat(32),
  startedAt: Date.now(), taps: 0, ...extra,
});
const simJob = (extra) => ({ ...realJob(extra), demo: true, koinosRecipient: SIM });

(async () => {
  /* --- 1. in demo mode, a real job is left completely alone --- */
  {
    store({ [REAL]: realJob(), [SIM]: simJob({ status: "approve_permit2" }) }, { demo: true });
    const before = JSON.stringify(funding.job(REAL));
    await funding.tick();
    assert.strictEqual(JSON.stringify(funding.job(REAL)), before,
      "the simulator must not advance — or even touch — a real job");
    assert.notStrictEqual(funding.job(SIM).status, "approve_permit2",
      "while the simulated job beside it still runs");
    console.log("✓ demo mode advances only simulated jobs, and leaves real ones untouched");
  }

  /* --- 2. and the reverse: the live driver ignores simulated jobs --- */
  {
    store({ [SIM]: simJob({ status: "bridge_token" }) }, { demo: false });
    const before = JSON.stringify(funding.job(SIM));
    await funding.tick();
    assert.strictEqual(JSON.stringify(funding.job(SIM)), before,
      "a live driver must not spend real gas against invented balances");
    console.log("✓ the live driver ignores simulated jobs");
  }

  /* --- 3. a fabricated finish on a real job is undone at startup --- */
  {
    store({
      [REAL]: realJob({
        status: "done", redeemId: "0xdemo-redeem", koinReceived: "12270000000",
        finishedAt: Date.now(),
      }),
    }, { demo: false });
    const j = funding.job(REAL);
    assert.strictEqual(j.status, "awaiting_signatures",
      "a demo-marked completion must go back to re-reading the real bridge record");
    assert.ok(!j.redeemId, "the fabricated redeem id is cleared");
    assert.ok(!j.koinReceived, "and so is the amount it claimed to have landed");
    assert.match(j.error, /demo mode/i, "with the reason said plainly");
    assert.ok(j.repairedAt);
    console.log("✓ a fabricated 'landed' is undone and the job resumes for real");
  }

  /* --- 4. genuine completions and simulated jobs are not disturbed --- */
  {
    store({
      [REAL]: realJob({ status: "done", redeemId: "0x1220realredeemid", koinReceived: "12270000000" }),
      [SIM]: simJob({ status: "done", redeemId: "0xdemo-redeem", koinReceived: "1850000000" }),
    }, { demo: false });
    const real = funding.job(REAL);
    assert.strictEqual(real.status, "done", "a real completion stays done");
    assert.strictEqual(real.redeemId, "0x1220realredeemid");
    const sim = funding.job(SIM);
    assert.strictEqual(sim.status, "done", "a simulated job's own demo id is not 'damage'");
    assert.strictEqual(sim.redeemId, "0xdemo-redeem");
    console.log("✓ real completions and simulated jobs are left alone");
  }

  console.log("\nALL DEMO-ISOLATION CHECKS PASSED");
})().catch((e) => { console.error("FAILED:", e.message, "\n", e.stack); process.exit(1); });
