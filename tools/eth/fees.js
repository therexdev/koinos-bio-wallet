"use strict";

// What a conversion costs, and how the platform gets it back.
//
// The gas sponsor pays for the steps a deposit cannot pay for itself: a top-up
// when the deposit address holds no ether, and the Wormhole redeem, which has
// to happen BEFORE a Solana deposit has any ether of its own. Left alone that
// float only ever drains. The fee here replaces it.
//
//   fee = what the sponsor actually spent on this job, plus a buffer
//         + a percentage of what is being converted
//
// The first part keeps the float level; the second is what makes it a
// business rather than a subsidy. Both are configurable and either can be
// switched off by setting it to zero.
//
// This file is PURE — no chain, no network — so the arithmetic that decides
// what people are charged can be read and tested on its own.

const { ethers } = require("ethers");

/** Settings, read once. Percentages are whole numbers. */
function config(env = process.env) {
  return {
    /* on top of the measured sponsor cost, for the gas the recovery itself
       burns and for the price moving between quote and execution */
    bufferPct: num(env.FUND_FEE_BUFFER_PCT, 20),
    /* of the amount being converted */
    ratePct: num(env.FUND_FEE_PCT, 1),
    /* Nothing is ever absorbed: the fee always covers the full cost plus the
       buffer, or the conversion does not happen. These decide when to WARN
       and when to stop lending the float instead. */
    warnUsd: num(env.FUND_FEE_WARN_USD, 10),
    warnPct: num(env.FUND_FEE_WARN_PCT, 10),
    /* Above this the platform will not front the gas at all — the deposit
       address has to hold its own ether. It is the per-job cap on how much
       of the float a single conversion can borrow. */
    maxSponsoredUsd: num(env.FUND_FEE_MAX_SPONSORED_USD, 20),
    /* where token-denominated fees accrue; ETH fees go to the sponsor itself */
    treasury: String(env.FUND_FEE_TREASURY || "").trim(),
    /* accrued tokens are swapped to ether only when they are worth more than
       this many times the swap's own gas — per job it costs almost as much as
       it recovers, batched it is a rounding error */
    sweepMultiple: num(env.FUND_FEE_SWEEP_MULTIPLE, 12),
  };
}
function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** The fee for a job, in the units of whatever it is taken from.

    `sponsorWei` is what the sponsor has actually spent on it — measured, not
    guessed. Nothing is capped away: the float must come back whole, plus the
    buffer, or the conversion is refused rather than subsidised. Whether it is
    too expensive to be worth doing is a separate judgement, made by
    `assess` against real dollars. */
function feeWei({ sponsorWei = 0n, valueWei = 0n, cfg = config() }) {
  const sponsor = BigInt(sponsorWei);
  const value = BigInt(valueWei);
  const recovery = (sponsor * BigInt(100 + Math.round(cfg.bufferPct))) / 100n;
  const rate = (value * BigInt(Math.round(cfg.ratePct * 100))) / 10000n;
  return { fee: recovery + rate, recovery, rate };
}

/** What to tell someone about a fee, and whether the float may fund it.

    Three outcomes: quiet (say the number and move on), warn (say it loudly,
    because a fee that is a tenth of the deposit deserves a second look), or
    refuse to sponsor (the float will not lend this much to one conversion —
    the deposit address has to hold its own ether). */
function assess({ feeUsd, valueUsd, sponsoredUsd = 0, cfg = config() }) {
  const pct = valueUsd > 0 ? (feeUsd / valueUsd) * 100 : 0;
  const reasons = [];
  if (feeUsd >= cfg.warnUsd) reasons.push(`the fee is $${feeUsd.toFixed(2)}`);
  if (valueUsd > 0 && pct >= cfg.warnPct) reasons.push(`that is ${pct.toFixed(1)}% of what you are converting`);
  const sponsorRefused = sponsoredUsd > cfg.maxSponsoredUsd;
  return {
    pct, warn: reasons.length > 0, reasons,
    sponsorRefused,
    sponsorLimitUsd: cfg.maxSponsoredUsd,
    level: sponsorRefused ? "refused" : reasons.length ? "warn" : "ok",
  };
}

/** How much ether the float needs to hold.

    A sponsored job takes its cost out of the float at once and pays it back
    only when the fees it accrued are swept — so the exposure is however many
    jobs fit under the sweep threshold. Each accrues about (1 + buffer) times
    what it cost, so the number of jobs cancels out and the exposure is simply
    the sweep threshold discounted by the buffer, whatever the job size. The
    concurrency term covers jobs already in flight when a sweep fires. */
function floatPlan({ swapCostWei, maxSponsoredWei, concurrent = 5, cfg = config() }) {
  const swap = BigInt(swapCostWei);
  const sweepAt = swap * BigInt(Math.round(cfg.sweepMultiple));
  const exposure = (sweepAt * 100n) / BigInt(100 + Math.round(cfg.bufferPct));
  const inFlight = BigInt(maxSponsoredWei) * BigInt(concurrent);
  const required = exposure + inFlight;
  const perJob = BigInt(maxSponsoredWei) || 1n;
  return {
    sweepAtWei: sweepAt, exposureWei: exposure, inFlightWei: inFlight,
    requiredWei: required,
    /* how many worst-case jobs the float covers before a sweep must land */
    jobsBeforeSweep: Number(exposure / perJob),
  };
}

/** Is a job's fee worth collecting at all? A transfer costs gas too, so a fee
    smaller than the transfer that carries it is better skipped than paid. */
function worthCollecting(fee, transferCostWei) {
  return BigInt(fee) > BigInt(transferCostWei) * 2n;
}

/** Should accrued token fees be swapped back to ether yet? Per job the swap
    costs about what it recovers; batched over many it is negligible. */
function worthSweeping({ accruedWei, swapCostWei, cfg = config() }) {
  return BigInt(accruedWei) >= BigInt(swapCostWei) * BigInt(Math.round(cfg.sweepMultiple));
}

/** A plain-language line for the card. */
function describe({ fee, recovery, rate }) {
  const eth = (w) => Number(ethers.formatEther(w));
  return {
    feeEth: ethers.formatEther(fee),
    recoveryEth: ethers.formatEther(recovery),
    rateEth: ethers.formatEther(rate),
    /* what a person actually wants to know: is this mostly gas, or mostly us */
    mostlyGas: eth(recovery) > eth(rate),
  };
}

module.exports = { config, feeWei, assess, floatPlan, worthCollecting, worthSweeping, describe };
