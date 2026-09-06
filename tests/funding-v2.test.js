"use strict";
const assert = require("node:assert/strict");
const { harness, eth, A } = require("./fixtures/funding-v2-harness");
const swap = require("../tools/eth/eth-swap-exec");

(async () => {
  for (const asset of ["usdt", "usdc"]) {
    const h = harness();
    const original = h.balance(h.sponsorWallet.address);
    const { quote } = await h.start(asset);
    assert.ok(Number(quote.feeEth) > 0 && Number(quote.maxFeeEth) >= Number(quote.feeEth));
    const job = await h.run();
    const c = A.costs(job), due = A.repayment(job);
    assert.equal(c.debt, 0n);
    assert.ok(c.sponsor > 0n);
    assert.equal(h.sends.filter((s) => s.state === "front_gas").length, 1);
    assert.equal(h.sends.filter((s) => s.state === "collect_fee").length, 1);
    assert.equal(h.balance(h.sponsorWallet.address) - original, due.premium + due.service,
      "the original sponsor receives every wei advanced, its transfer gas, and the disclosed charges");
    assert.equal(h.sends.find((s) => s.state === "collect_fee").to, h.sponsorWallet.address,
      "a separate treasury never diverts ETH reimbursement");
    assert.ok(h.balance(h.wallets[h.account].address) > 0n, "unused purchased ETH stays with the user");
    assert.equal(job.settlementComplete, true);
    console.log(`✓ ${asset}: full ETH recovery once, then KOIN conversion, with surplus ETH retained`);
  }

  {
    const h = harness({ own: "0.0002" });
    const { job } = await h.start();
    const pre = job.feePlan.preSteps.reduce((v, k) => v + BigInt(job.feePlan.gasLimits[k]), 0n) * BigInt(job.feePlan.maxFeePerGas);
    assert.equal(BigInt(job.feePlan.advanceMaxWei), pre - eth("0.0002"));
    await h.run();
    assert.equal(h.sends.filter((s) => s.state === "front_gas").length, 1);
    console.log("✓ partial ETH receives only the bootstrap shortfall");
  }

  for (const route of ["T", "S"]) {
    const h = harness({ own: "0.03" });
    const { job } = await h.start("sol", route, "0.2");
    assert.equal(job.feePlan.sponsoredRedeem, false);
    h.arriveSol();
    await h.run();
    assert.equal(A.costs(h.jobs[h.account]).sponsor, 0n);
    assert.equal(h.sends.filter((s) => s.state === "collect_fee").length, 1);
    console.log(`✓ SOL ${route} uses existing ETH before the sponsor`);
  }

  {
    const h = harness();
    const original = h.balance(h.sponsorWallet.address);
    await h.start("sol", "T", "0.2"); h.arriveSol();
    const j = await h.run();
    assert.deepEqual(h.sends.filter((s) => s.from === h.sponsorWallet.address).map((s) => s.state), ["wh_redeem"]);
    assert.equal(h.sends.filter((s) => s.state === "collect_fee").length, 1, "no second USDT fee after ETH arrives");
    assert.equal(A.costs(j).debt, 0n);
    assert.ok(h.balance(h.sponsorWallet.address) > original);
    console.log("✓ SOL T sponsors only redemption and immediately repays in native ETH");
  }

  {
    const h = harness();
    await assert.rejects(h.start("sol", "S", "0.2"), /own ETH/);
    h.opts.unavailableRecovery = true;
    await assert.rejects(h.start(), /Recovery pool/);
    assert.equal(h.sends.length, 0);
    console.log("✓ unavailable ETH recovery is rejected before any funds are sent");
  }

  {
    const h = harness({ sponsor: "0.0021" });
    await assert.rejects(h.start(), /protected reserve/);
    assert.equal(h.sends.length, 0);
    console.log("✓ a low funding balance cannot consume the protected ETH reserve");
  }

  {
    const h = harness({ policy: { maxOutstandingWei: eth("0.0005").toString() } });
    await h.start();
    await assert.rejects(h.start("usdt", "C", "100", h.second), /earlier repayments/);
    assert.equal(h.sends.length, 0);
    console.log("✓ reservations prevent a second job from borrowing committed ETH");
  }

  {
    const h = harness();
    await h.start(); h.opts.loseNextSend = true;
    await assert.rejects(h.engine.advance(h.account, h.jobs[h.account]), /network lost/);
    const raw = h.jobs[h.account].pendingEth.raw, hash = h.jobs[h.account].pendingEth.hash;
    h.restart();
    await h.engine.advance(h.account, h.jobs[h.account]);
    assert.equal(h.jobs[h.account].pendingEth.raw, raw);
    assert.equal(h.sends[0].hash, hash);
    await h.run();
    assert.equal(h.sends.filter((s) => s.state === "front_gas").length, 1);
    console.log("✓ a restart after a lost broadcast response reuses the same signed advance");
  }

  {
    const h = harness();
    await h.start("sol", "T", "0.2"); h.arriveSol(); h.opts.revertNext = true;
    await h.engine.advance(h.account, h.jobs[h.account]);
    await h.engine.advance(h.account, h.jobs[h.account]);
    assert.equal(h.jobs[h.account].status, "error");
    assert.ok(A.costs(h.jobs[h.account]).debt > 0n, "reverted sponsored gas remains an outstanding cost");
    assert.equal(h.jobs[h.account].settlementComplete, undefined);
    console.log("✓ reverted sponsored gas is recorded before reporting failure");
  }

  {
    const h = harness();
    await h.start();
    await h.run(h.account, "gas_buy_eth");
    await h.engine.advance(h.account, h.jobs[h.account]);
    const original = swap.receivedInTx;
    swap.receivedInTx = () => { throw new Error("receipt processing interrupted"); };
    try {
      await assert.rejects(h.engine.advance(h.account, h.jobs[h.account]), /processing interrupted/);
      assert.ok(h.jobs[h.account].confirmedEth, "a confirmed spend survives failed postprocessing");
    } finally { swap.receivedInTx = original; }
    h.restart();
    await h.run();
    assert.equal(h.sends.filter((s) => s.state === "gas_buy_eth").length, 1);
    assert.equal(h.sends.filter((s) => s.state === "collect_fee").length, 1);
    console.log("✓ interrupted receipt processing resumes without buying gas or collecting twice");
  }
  {
    const h = harness();
    await h.start();
    await h.start("usdt", "C", "100", h.second);
    h.provider.getTransactionCount = async () => 0; // lagging pending-nonce view
    await Promise.all([
      h.engine.advance(h.account, h.jobs[h.account]),
      h.engine.advance(h.second, h.jobs[h.second]),
    ]);
    assert.deepEqual(h.sends.map((s) => s.nonce), [0, 1]);
    assert.notEqual(h.sends[0].hash, h.sends[1].hash);
    console.log("✓ concurrent jobs reserve distinct sponsor nonces even when the RPC lags");
  }

  {
    const h = harness();
    await h.start(); h.opts.gas *= 10n;
    await assert.rejects(h.engine.advance(h.account, h.jobs[h.account]), /approved maximum/);
    assert.equal(h.sends.length, 0);
    console.log("✓ a gas spike cannot silently increase the accepted fee ceiling");
  }

  {
    const h = harness({ own: "0.01" });
    await h.start();
    assert.equal(h.jobs[h.account].status, "collect_fee");
    await h.run();
    assert.equal(h.sends.filter((s) => ["front_gas", "gas_buy_eth"].includes(s.state)).length, 0);
    console.log("✓ sufficient ETH avoids both sponsorship and an unnecessary recovery swap");
  }
  for (const route of ["B", "C"]) {
    const h = harness({ own: "0.04" });
    const { quote } = await h.start("eth", route, "0.02");
    await h.run();
    assert.equal(A.costs(h.jobs[h.account]).sponsor, 0n);
    assert.equal(h.sends.filter((s) => s.state === "collect_fee").length, 1);
    assert.ok(Number(quote.maxFeeEth) > Number(quote.platformFeeEth));
    console.log(`✓ ETH ${route} quotes and collects one platform fee with its own gas budget`);
  }
  {
    const h = harness();
    await h.start();
    h.setOwn("0.01"); // user deposits ETH after accepting the quote
    await h.run();
    assert.equal(h.sends.filter((s) => ["front_gas", "gas_buy_eth"].includes(s.state)).length, 0);
    console.log("✓ ETH arriving before the bootstrap removes the need to sponsor or buy gas");
  }
  {
    const h = harness();
    const amount = 100000000n;
    const q = await h.engine.quote(h.account, "usdt", amount);
    const quoteId = q.best.quoteId;
    await assert.rejects(h.engine.start(h.account, { asset: "usdt", amount: amount - 1n, route: "C", quoteId }, {}), /does not match/);
    await assert.rejects(h.engine.start(h.second, { asset: "usdt", amount, route: "C", quoteId }, {}), /does not match/);
    await assert.rejects(h.engine.start(h.account, { asset: "usdt", amount, route: "C", quoteId: "missing" }, {}), /expired/);
    assert.equal(h.sends.length, 0);
    console.log("✓ accepted quotes bind the account, asset, route and exact amount");
  }
  console.log("\nALL V2 FUNDING CHECKS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
