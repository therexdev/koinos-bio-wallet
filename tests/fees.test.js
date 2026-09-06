/* What the platform charges, and why.

   tools/eth/fees.js decides what every conversion costs, so the arithmetic is
   pinned here: it recovers what the sponsor actually spent, adds the rate, and
   never takes a share of someone's deposit that a gas spike made absurd.

   Run: node tests/fees.test.js
*/
"use strict";
const assert = require("node:assert");
const { ethers } = require("ethers");
const fees = require("../tools/eth/fees");

const eth = (n) => ethers.parseEther(String(n));
const asEth = (w) => Number(ethers.formatEther(w));
const CFG = fees.config({});

(() => {
  /* --- 1. the defaults --- */
  {
    assert.deepStrictEqual(
      { b: CFG.bufferPct, r: CFG.ratePct, s: CFG.sweepMultiple, w: CFG.warnUsd, wp: CFG.warnPct, max: CFG.maxSponsoredUsd },
      { b: 20, r: 1, s: 12, w: 10, wp: 10, max: 20 });
    const custom = fees.config({ FUND_FEE_PCT: "0", FUND_FEE_BUFFER_PCT: "50" });
    assert.strictEqual(custom.ratePct, 0, "the rate can be switched off entirely");
    assert.strictEqual(custom.bufferPct, 50);
    assert.strictEqual(fees.config({ FUND_FEE_PCT: "nonsense" }).ratePct, 1, "junk falls back to the default");
    assert.strictEqual(fees.config({ FUND_FEE_PCT: "-3" }).ratePct, 1, "and so does a negative");
    console.log("✓ configuration: defaults, overrides, and junk that cannot become a negative fee");
  }

  /* --- 2. cost recovery plus the rate --- */
  {
    /* a route-T job: the sponsor spent one redeem, and $370 is converted */
    const r = fees.feeWei({ sponsorWei: eth(0.001), valueWei: eth(0.1), cfg: CFG });
    assert.strictEqual(asEth(r.recovery), 0.0012, "the sponsor's 0.001 back, plus the 20% buffer");
    assert.strictEqual(asEth(r.rate), 0.001, "1% of the 0.1 being converted");
    assert.strictEqual(asEth(r.fee), 0.0022);

    /* a job the sponsor spent nothing on still pays the rate */
    const noSponsor = fees.feeWei({ sponsorWei: 0n, valueWei: eth(0.1), cfg: CFG });
    assert.strictEqual(asEth(noSponsor.fee), 0.001);
    assert.strictEqual(asEth(noSponsor.recovery), 0);

    /* and with the rate off, the fee is pure cost recovery */
    const costOnly = fees.feeWei({ sponsorWei: eth(0.001), valueWei: eth(0.1), cfg: fees.config({ FUND_FEE_PCT: "0" }) });
    assert.strictEqual(asEth(costOnly.fee), 0.0012);
    console.log("✓ fee = what the sponsor spent (plus buffer) + the rate on the conversion");
  }

  /* --- 3. nothing is ever absorbed --- */
  {
    /* Gas spikes past what the conversion is worth. The fee is still the full
       cost plus the buffer: the float is never asked to donate. Whether the
       conversion should happen at all is assess's judgement, not a silent
       discount here. */
    const r = fees.feeWei({ sponsorWei: eth(0.02), valueWei: eth(0.03), cfg: CFG });
    assert.strictEqual(asEth(r.fee), 0.0243, "0.024 of recovery and 0.0003 of rate, in full");
    assert.ok(asEth(r.fee) >= asEth(r.recovery), "never less than what the sponsor is owed");
    const noValue = fees.feeWei({ sponsorWei: eth(0.001), valueWei: 0n, cfg: CFG });
    assert.strictEqual(asEth(noValue.fee), 0.0012, "with nothing to take a share of, cost recovery still stands");
    console.log("✓ the fee always covers the float in full — nothing is quietly absorbed");
  }

  /* --- 3b. what the person is told, and what the float will lend --- */
  {
    const quiet = fees.assess({ feeUsd: 2, valueUsd: 200, sponsoredUsd: 2, cfg: CFG });
    assert.deepStrictEqual([quiet.level, quiet.warn], ["ok", false]);
    assert.ok(Math.abs(quiet.pct - 1) < 1e-9);

    /* $5 on a $20 swap is a quarter of it — exactly the case worth shouting about */
    const steep = fees.assess({ feeUsd: 5, valueUsd: 20, sponsoredUsd: 5, cfg: CFG });
    assert.strictEqual(steep.level, "warn");
    assert.match(steep.reasons.join(" "), /25\.0% of what you are converting/);

    /* a big fee on a big swap still warns on the dollar threshold alone */
    const dollars = fees.assess({ feeUsd: 12, valueUsd: 400, sponsoredUsd: 12, cfg: CFG });
    assert.strictEqual(dollars.level, "warn");
    assert.match(dollars.reasons.join(" "), /\$12\.00/);
    assert.strictEqual(dollars.sponsorRefused, false, "warned, but the float will still lend it");

    /* past the per-job limit the float stops lending, whatever the swap size */
    const refused = fees.assess({ feeUsd: 25, valueUsd: 3000, sponsoredUsd: 25, cfg: CFG });
    assert.strictEqual(refused.level, "refused");
    assert.strictEqual(refused.sponsorRefused, true);
    assert.strictEqual(refused.sponsorLimitUsd, 20);
    /* and a big fee the DEPOSIT pays for itself is not a refusal */
    const ownGas = fees.assess({ feeUsd: 25, valueUsd: 3000, sponsoredUsd: 0, cfg: CFG });
    assert.strictEqual(ownGas.sponsorRefused, false, "nothing borrowed, nothing to refuse");
    assert.strictEqual(ownGas.level, "warn", "still said out loud, because $25 is $25");
    console.log("✓ warn above $10 or 10%, refuse to sponsor above $20, and judge the two separately");
  }

  /* --- 3c. how much ether the float has to hold --- */
  {
    const swapAt = (gwei) => BigInt(gwei) * 10n ** 9n * 150000n * 15n / 10n;
    const maxJob = eth(0.0054); // ~$20 of gas at $3,700
    const plan = fees.floatPlan({ swapCostWei: swapAt(20), maxSponsoredWei: maxJob, cfg: CFG });
    /* exposure is the sweep threshold discounted by the buffer — the per-job
       size cancels out, which is why this number is stable */
    assert.strictEqual(plan.sweepAtWei, swapAt(20) * 12n);
    assert.strictEqual(plan.exposureWei, (swapAt(20) * 12n * 100n) / 120n);
    assert.ok(plan.requiredWei > plan.exposureWei, "plus whatever is in flight when a sweep lands");
    assert.ok(plan.jobsBeforeSweep >= 5, "and it is expressed in jobs, not just ether");
    /* worse gas needs a bigger float, and it scales linearly */
    const worse = fees.floatPlan({ swapCostWei: swapAt(50), maxSponsoredWei: maxJob, cfg: CFG });
    assert.ok(worse.requiredWei > plan.requiredWei);
    assert.strictEqual(worse.exposureWei, plan.exposureWei * 5n / 2n, "50 gwei needs 2.5x what 20 does");
    /* sweeping sooner needs less float */
    const eager = fees.floatPlan({ swapCostWei: swapAt(20), maxSponsoredWei: maxJob, cfg: fees.config({ FUND_FEE_SWEEP_MULTIPLE: "6" }) });
    assert.ok(eager.requiredWei < plan.requiredWei, "a lower sweep threshold means less ether tied up");
    console.log("✓ the float requirement: sweep threshold over buffer, plus jobs in flight");
  }

  /* --- 4. when collecting or sweeping is worth its own gas --- */
  {
    const transfer = eth(0.0001);
    assert.strictEqual(fees.worthCollecting(eth(0.001), transfer), true);
    assert.strictEqual(fees.worthCollecting(eth(0.00015), transfer), false, "a fee barely above the transfer is not worth sending");
    /* the sweep: per job it is a loss, batched it is not */
    const swap = eth(0.001);
    assert.strictEqual(fees.worthSweeping({ accruedWei: eth(0.002), swapCostWei: swap, cfg: CFG }), false, "two jobs' worth: not yet");
    assert.strictEqual(fees.worthSweeping({ accruedWei: eth(0.012), swapCostWei: swap, cfg: CFG }), true, "twelve times the swap: now it is worth it");
    console.log("✓ neither collecting nor sweeping happens when it would cost more than it moves");
  }

  /* --- 5. what the card is told --- */
  {
    const r = fees.feeWei({ sponsorWei: eth(0.002), valueWei: eth(0.05), cfg: CFG });
    const d = fees.describe(r);
    assert.strictEqual(d.feeEth, ethers.formatEther(r.fee));
    assert.strictEqual(d.mostlyGas, true, "0.0024 of gas against 0.0005 of rate — say so honestly");
    assert.strictEqual(fees.describe(fees.feeWei({ sponsorWei: 0n, valueWei: eth(1), cfg: CFG })).mostlyGas, false);
    console.log("✓ the description says whether a fee is mostly gas or mostly us");
  }

  /* --- 6. the same arithmetic in a token's units, which is how a deposit
         that never holds ether pays --- */
  {
    /* USDT is 6 decimals. The sponsor's ether cost is converted into USDT by
       the caller; from here it is just numbers. */
    const usdt = (n) => BigInt(Math.round(n * 1e6));
    const r = fees.feeWei({ sponsorWei: usdt(5.55), valueWei: usdt(200), cfg: CFG });
    assert.strictEqual(r.recovery, usdt(6.66), "the 5.55 top-up plus the buffer");
    assert.strictEqual(r.rate, usdt(2), "1% of 200 USDT");
    assert.strictEqual(r.fee, usdt(8.66), "so the float comes back and a margin with it");
    assert.ok(r.fee > usdt(5.55), "a sponsored job repays more than it cost — that is the whole point");

    /* a $6 float cost against a $20 swap: the fee is still charged in full,
       and assess is what makes sure nobody walks into it unawares */
    const small = fees.feeWei({ sponsorWei: usdt(5.55), valueWei: usdt(20), cfg: CFG });
    assert.strictEqual(small.fee, usdt(6.86), "6.66 of recovery plus 0.20 of rate — all of it");
    const said = fees.assess({ feeUsd: 6.86, valueUsd: 20, sponsoredUsd: 6.86, cfg: CFG });
    assert.strictEqual(said.level, "warn", "and it is flagged: a third of the deposit");
    console.log("✓ the same maths in USDT units: a sponsored job repays its float, and a tiny one is capped");
  }

  console.log("\nALL FEE CHECKS PASSED");
})();
