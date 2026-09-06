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
    /* never charge more than this share of the conversion, whatever the gas
       did — a fee that eats the deposit is worse than no conversion */
    maxPct: num(env.FUND_FEE_MAX_PCT, 25),
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

/** The fee for a job, in wei.

    `sponsorWei` is what the sponsor has actually spent on it — measured, not
    guessed. `valueWei` is the conversion in ether terms. The cap is applied
    last so an unlucky gas spike cannot swallow someone's deposit. */
function feeWei({ sponsorWei = 0n, valueWei = 0n, cfg = config() }) {
  const sponsor = BigInt(sponsorWei);
  const value = BigInt(valueWei);
  const recovery = (sponsor * BigInt(100 + Math.round(cfg.bufferPct))) / 100n;
  const rate = (value * BigInt(Math.round(cfg.ratePct * 100))) / 10000n;
  const raw = recovery + rate;
  const cap = (value * BigInt(Math.round(cfg.maxPct * 100))) / 10000n;
  return { fee: value > 0n && raw > cap ? cap : raw, recovery, rate, capped: value > 0n && raw > cap };
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

module.exports = { config, feeWei, worthCollecting, worthSweeping, describe };
