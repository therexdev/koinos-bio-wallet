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
      { b: CFG.bufferPct, r: CFG.ratePct, m: CFG.maxPct, s: CFG.sweepMultiple },
      { b: 20, r: 1, m: 25, s: 12 });
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
    assert.strictEqual(r.capped, false);

    /* a job the sponsor spent nothing on still pays the rate */
    const noSponsor = fees.feeWei({ sponsorWei: 0n, valueWei: eth(0.1), cfg: CFG });
    assert.strictEqual(asEth(noSponsor.fee), 0.001);
    assert.strictEqual(asEth(noSponsor.recovery), 0);

    /* and with the rate off, the fee is pure cost recovery */
    const costOnly = fees.feeWei({ sponsorWei: eth(0.001), valueWei: eth(0.1), cfg: fees.config({ FUND_FEE_PCT: "0" }) });
    assert.strictEqual(asEth(costOnly.fee), 0.0012);
    console.log("✓ fee = what the sponsor spent (plus buffer) + the rate on the conversion");
  }

  /* --- 3. the cap, which is the whole point of having one --- */
  {
    /* gas spikes to where the sponsor spent more than a quarter of a small
       conversion: the fee stops at the cap and the rest is the platform's
       problem, not the depositor's */
    const r = fees.feeWei({ sponsorWei: eth(0.02), valueWei: eth(0.03), cfg: CFG });
    assert.strictEqual(r.capped, true);
    assert.strictEqual(asEth(r.fee), 0.0075, "25% of the conversion, not the 0.0243 the gas actually cost");
    assert.ok(asEth(r.fee) < asEth(r.recovery), "the platform eats the difference");
    /* a conversion with no value cannot be capped into nothing */
    const noValue = fees.feeWei({ sponsorWei: eth(0.001), valueWei: 0n, cfg: CFG });
    assert.strictEqual(asEth(noValue.fee), 0.0012, "with nothing to take a share of, cost recovery still stands");
    console.log("✓ the cap keeps a gas spike from eating a quarter-plus of someone's deposit");
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

    /* and the cap protects a small one: a $6 float cost against a $20 swap */
    const small = fees.feeWei({ sponsorWei: usdt(5.55), valueWei: usdt(20), cfg: CFG });
    assert.strictEqual(small.capped, true);
    assert.strictEqual(small.fee, usdt(5), "25% of 20 USDT, and the platform absorbs the rest");
    console.log("✓ the same maths in USDT units: a sponsored job repays its float, and a tiny one is capped");
  }

  console.log("\nALL FEE CHECKS PASSED");
})();
