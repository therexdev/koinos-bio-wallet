/* Landing the KOIN: who has to sign the Vortex bridge redeem?

   The redeem only mints to the recipient named in the guardian-signed
   record, and the bridge carries relayer/payment fields so a third party can
   submit it — so the sponsor tries first and the user taps nothing. But
   whether the deployed contract ALSO demands the recipient's authority is a
   fact about a contract we can't read from here, so the code must be right
   either way: sponsor first, passkey tap if the chain says otherwise.

   These checks pin every branch of that decision, plus the two failure modes
   that would otherwise strand real money mid-bridge — a lost reply on an
   already-completed transfer, and a transient RPC blip.
*/
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

/* Swap the bridge op builder before funding.js destructures it, so nothing
   here needs a network or a real record. */
const BRIDGE = require.resolve("../tools/eth/koinos-bridge");
require(BRIDGE);
const FAKE_OP = { call_contract: { contract_id: "bridge", entry_point: 1, args: "redeem" } };
require.cache[BRIDGE].exports = {
  ...require.cache[BRIDGE].exports,
  opCompleteTransfer: async () => FAKE_OP,
};

const chain = require("../tools/chain");
const funding = require("../tools/funding");

const ACCOUNT = "1LandingTestAccountAddressXXXXXXXX";
const RECORD = {
  id: "0xdeadbeef", recipient: ACCOUNT, koinosToken: "1KoinToken",
  amount: "12419000000", signatures: ["sigA", "sigB"],
  expiration: String(Date.now() + 30 * 60 * 1000),
};

/** Fresh data dir holding one job parked at awaiting_redeem. */
function parked(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redeem-"));
  fs.writeFileSync(path.join(dir, "funding.json"), JSON.stringify({
    transit: { [ACCOUNT]: { ethAddress: "0xabc", ethPriv: "0x00", ts: Date.now() } },
    jobs: {
      [ACCOUNT]: {
        asset: "eth", route: "C", status: "awaiting_redeem",
        koinosRecipient: ACCOUNT, amountLabel: "0.0005 ETH",
        estKoinOut: "12419000000", startedAt: Date.now(), taps: 0,
        record: RECORD, ...extra,
      },
    },
  }));
  funding.configure({ dataDir: dir, demo: false, network: "mainnet" });
  return dir;
}

/** Make the sponsor's redeem submission behave however the case needs. */
const realSend = chain.sendAsSponsorFor;
function sponsorSays(behaviour) {
  const seen = [];
  chain.sendAsSponsorFor = async (key, ops, opts) => {
    seen.push({ key, ops, opts });
    return behaviour(seen.length);
  };
  return seen;
}

(async () => {
  /* --- 1. the happy path: the sponsor lands it, the user taps nothing --- */
  {
    parked();
    const seen = sponsorSays(() => "0x1220sponsorredeem");
    await funding.tick();
    const j = funding.job(ACCOUNT);
    assert.strictEqual(j.status, "done", "a sponsor-submitted redeem finishes the job");
    assert.strictEqual(j.redeemId, "0x1220sponsorredeem");
    assert.strictEqual(j.koinReceived, RECORD.amount, "the record's amount is what landed");
    assert.strictEqual(j.taps || 0, 0, "and it cost the user no passkey taps");
    assert.strictEqual(seen[0].key, null, "the account key is not involved — sponsor only");
    assert.deepStrictEqual(seen[0].ops, [FAKE_OP]);
    console.log("✓ sponsor-driven redeem lands with zero taps");
  }

  /* --- 2. the chain wants the recipient after all --- */
  {
    parked();
    sponsorSays(() => { throw new Error("account 1Land... has not authorized transaction"); });
    await funding.tick();
    let j = funding.job(ACCOUNT);
    assert.strictEqual(j.status, "awaiting_redeem", "the job stays put, ready for the tap");
    assert.strictEqual(j.needsTap, true, "and is marked as needing the passkey");

    /* Once marked, the driver must stop retrying — otherwise it burns mana
       every tick on a transaction the chain has already refused. */
    const again = sponsorSays(() => "0xshould-not-happen");
    await funding.tick();
    assert.strictEqual(again.length, 0, "the driver leaves a tap-marked job alone");

    const tap = await funding.prepareTapOps(ACCOUNT);
    assert.strictEqual(tap.step, "redeem");
    assert.deepStrictEqual(tap.ops, [FAKE_OP], "the passkey signs the same redeem operation");
    funding.onTapDone(ACCOUNT, "redeem", "0x1220passkeyredeem");
    j = funding.job(ACCOUNT);
    assert.strictEqual(j.status, "done");
    assert.strictEqual(j.redeemId, "0x1220passkeyredeem");
    assert.strictEqual(j.koinReceived, RECORD.amount);
    assert.strictEqual(j.taps, 1, "that one counted as a tap");
    console.log("✓ chain refuses sponsor-only → falls back to the passkey tap, then lands");
  }

  /* --- 3. without that refusal, nothing offers a pointless tap --- */
  {
    parked();
    await assert.rejects(() => funding.prepareTapOps(ACCOUNT), /landing on its own/,
      "a normal redeem must not ask for a signature");
    console.log("✓ a normal redeem refuses to hand the user a pointless tap");
  }

  /* --- 4. the reply was lost but the transfer went through --- */
  {
    parked();
    sponsorSays(() => { throw new Error("transfer has been completed already"); });
    await funding.tick();
    const j = funding.job(ACCOUNT);
    assert.strictEqual(j.status, "done", "an already-completed transfer is a success, not an error");
    assert.strictEqual(j.koinReceived, RECORD.amount);
    console.log("✓ 'already completed' settles as landed (no stranded funds)");
  }

  /* --- 5. a blip retries; it does not strand or fake a landing --- */
  {
    parked();
    sponsorSays((n) => { if (n === 1) throw new Error("koinos rpc timeout (chain.submit_transaction)"); return "0x1220later"; });
    await funding.tick();
    let j = funding.job(ACCOUNT);
    assert.strictEqual(j.status, "awaiting_redeem", "a transient failure keeps the job alive");
    assert.strictEqual(j.needsTap, undefined, "and does NOT mistake a blip for an authority refusal");
    assert.strictEqual(j.redeemAttempts, 1);
    await funding.tick();
    j = funding.job(ACCOUNT);
    assert.strictEqual(j.status, "done", "the retry lands it");
    assert.strictEqual(j.redeemId, "0x1220later");
    console.log("✓ a transient failure retries and lands (never mistaken for a refusal)");
  }

  /* --- 6. expired guardian signatures go back for fresh ones --- */
  {
    parked({ record: { ...RECORD, expiration: String(Date.now() - 1000) } });
    const seen = sponsorSays(() => "0xexpired-should-not-submit");
    await funding.tick();
    const j = funding.job(ACCOUNT);
    assert.strictEqual(j.status, "awaiting_signatures", "expired signatures must not be submitted");
    assert.strictEqual(seen.length, 0);
    console.log("✓ expired guardian signatures re-poll instead of submitting");
  }

  chain.sendAsSponsorFor = realSend;
  console.log("\nALL REDEEM-FALLBACK CHECKS PASSED");
})().catch((e) => { console.error("FAILED:", e.message, "\n", e.stack); process.exit(1); });
