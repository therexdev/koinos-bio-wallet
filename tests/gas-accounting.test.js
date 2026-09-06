"use strict";
const assert = require("node:assert/strict");
const A = require("../tools/eth/gas-accounting");
const { ethers } = require("ethers");
const eth = (n) => ethers.parseEther(String(n));

const job = {
  feePlan: { version: 2, sponsorMaxWei: eth("0.001"), riskBps: 2000, serviceWei: eth("0.00001") },
  ethReceipts: {
    first: { sponsored: true, success: true, advanceWei: eth("0.0003"), gasWei: eth("0.000021") },
    approve: { sponsored: false, success: true, gasWei: eth("0.00005") },
    failed: { sponsored: true, success: false, gasWei: eth("0.00004"), advanceWei: eth("0.0003") },
  },
};
assert.equal(A.costs(job).sponsor, eth("0.000361"));
assert.equal(A.costs(job).userGas, eth("0.00005"), "gas funded by an advance is not charged as another sponsor expense");
assert.equal(A.repayment(job).total, eth("0.0004432"));
job.ethReceipts.repaid = { sponsored: false, success: true, gasWei: eth("0.000021"), recoveredWei: eth("0.000361") };
assert.equal(A.costs(job).debt, 0n);
job.settlementComplete = true;
assert.deepEqual(A.exposure([job]), { debt: 0n, unspent: 0n, total: 0n });
assert.throws(() => A.gasPaid({ gasUsed: 21000 }), /missing/);
assert.equal(A.gasPaid({ gasUsed: 21000, effectiveGasPrice: 2 }), 42000n);
assert.equal(A.bps(1n, 1), 1n, "liability rounding never silently drops a wei");
assert.throws(() => A.config({ FUND_SPONSOR_MIN_ETH: "-1" }), /Negative/);
assert.throws(() => A.config({ FUND_ETH_CONFIRMATIONS: "0" }), /Invalid/);

const cfg = A.config({});
for (let i = 0; i < 100; i++) {
  const requested = BigInt(i) * 10n ** 12n;
  const balance = BigInt(cfg.floorWei) + requested;
  A.admit({ balance, jobs: [], requested, cfg });
  if (requested) assert.throws(() => A.admit({ balance: balance - 1n, jobs: [], requested, cfg }), /protected reserve/);
}
console.log("✓ advance principal, actual gas, reverted costs, repayment and reserved exposure reconcile in integer wei");
console.log("✓ admissions preserve the protected reserve at the exact wei boundary");
