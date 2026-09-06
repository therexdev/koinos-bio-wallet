"use strict";

// Integer-only accounting for funding plan v2. Advances and the gas they fund
// are different entries: repaying an advance must not charge that gas twice.
const { ethers } = require("ethers");
const wei = (v) => {
  const n = BigInt(v == null ? 0 : v);
  if (n < 0n) throw new Error("Negative funding amount");
  return n;
};
const max = (a, b) => a > b ? a : b;
const ceilDiv = (a, b) => (a + b - 1n) / b;
function bps(amount, points) { return ceilDiv(wei(amount) * wei(points), 10000n); }
function shortfall(required, available) { return max(0n, wei(required) - wei(available)); }
function gasPaid(receipt) {
  const price = receipt.gasPrice ?? receipt.effectiveGasPrice;
  if (receipt.gasUsed == null || price == null) throw new Error("Receipt is missing the actual gas cost");
  return wei(receipt.gasUsed) * wei(price);
}
function config(env = process.env) {
  const ethSetting = (name, fallback) => wei(ethers.parseEther(String(env[name] ?? fallback))).toString();
  const integer = (name, fallback, low, high) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(n) || n < low || n > high) throw new Error(`Invalid ${name}`);
    return n;
  };
  return {
    floorWei: ethSetting("FUND_SPONSOR_MIN_ETH", "0.002"),
    maxJobWei: ethSetting("FUND_SPONSOR_MAX_ETH", "0.005"),
    maxOutstandingWei: ethSetting("FUND_SPONSOR_MAX_OUTSTANDING_ETH", "0.02"),
    quoteSeconds: integer("FUND_QUOTE_TTL_SECONDS", 60, 10, 300),
    confirmations: integer("FUND_ETH_CONFIRMATIONS", 2, 1, 64),
    // A disclosed charge on actual sponsor cost, separately from gas limits.
    // It finances failed attempts; it is never applied to user-paid gas.
    riskBps: integer("FUND_SPONSOR_RISK_BPS", 2000, 0, 10000),
    gasHeadroomBps: integer("FUND_GAS_HEADROOM_BPS", 2000, 0, 10000),
    priceHeadroomBps: integer("FUND_GAS_PRICE_HEADROOM_BPS", 2500, 0, 10000),
  };
}
function costs(job) {
  let sponsor = 0n, userGas = 0n, recovered = 0n;
  for (const tx of Object.values(job.ethReceipts || {})) {
    if (tx.sponsored) sponsor += wei(tx.gasWei) + (tx.success ? wei(tx.advanceWei) : 0n);
    else userGas += wei(tx.gasWei);
    if (tx.success) recovered += wei(tx.recoveredWei);
  }
  return { sponsor, userGas, recovered, debt: shortfall(sponsor, recovered) };
}
function exposure(jobs) {
  let unspent = 0n, debt = 0n;
  for (const j of jobs) {
    if (!j || !j.feePlan || j.feePlan.version !== 2 || j.reservationReleased) continue;
    const c = costs(j);
    debt += c.debt;
    if (!j.settlementComplete) unspent += shortfall(j.feePlan.sponsorMaxWei, c.sponsor);
  }
  return { unspent, debt, total: unspent + debt };
}
function admit({ balance, jobs, requested, cfg }) {
  const x = exposure(jobs);
  const want = wei(requested);
  if (want > wei(cfg.maxJobWei)) throw new Error("This conversion exceeds the per-job ETH sponsorship limit");
  if (x.total + want > wei(cfg.maxOutstandingWei)) throw new Error("Gas sponsorship is waiting for earlier repayments; use your own ETH or try later");
  if (wei(balance) < wei(cfg.floorWei) + x.unspent + want) throw new Error("The gas funding wallet is at its protected reserve; use your own ETH or try later");
  return x;
}
function repayment(job) {
  const c = costs(job), plan = job.feePlan;
  if (c.sponsor > wei(plan.sponsorMaxWei)) throw new Error("Sponsor spending exceeded the approved plan");
  const premium = bps(c.sponsor, plan.riskBps);
  const service = wei(plan.serviceWei);
  return { principal: c.debt, premium, service, total: c.debt + premium + service };
}
function serialize(value) {
  return JSON.parse(JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() : v));
}
module.exports = { wei, max, ceilDiv, bps, shortfall, gasPaid, config, costs, exposure, admit, repayment, serialize };
