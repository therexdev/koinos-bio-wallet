"use strict";

// New jobs share one accepted fee plan from quote through ETH settlement.
// The existing funding driver still owns the Solana and Koinos bridge waits.
const crypto = require("crypto");
const { ethers } = require("ethers");
const A = require("./gas-accounting");
const recovery = require("./gas-recovery");
const RC = require("./route-constants");
const BC = require("./bridge-constants");
const swap = require("./eth-swap-exec");
const quotes = require("./eth-swap");
const bridge = require("./eth-bridge");
const { buildTransferTokensTx } = require("./eth-bridge-token");
const koindx = require("./koindx");
const routes = require("./fund-routes");
const jup = require("../sol/jupiter");
const SC = require("../sol/sol-constants");
const wormhole = require("../sol/wormhole");

// Conservative route estimates; each actual transaction is estimated again
// and may only spend within the accepted per-step and aggregate ceilings.
const GAS = {
  front_gas: 21000n, collect_fee: 21000n,
  gas_approve_reset: 45000n, gas_approve: 65000n, gas_buy_eth: 220000n,
  wh_redeem: 200000n,
  approve_v3_usdc: 65000n, swap_usdc_usdt: 160000n,
  swap_eth_usdt: 180000n, approve_permit2_reset: 45000n,
  approve_permit2: 65000n, approve_ur: 65000n,
  swap_usdt_vkoin: 260000n, approve_bridge: 65000n,
  bridge_token: 250000n, deposit_eth: 180000n,
  request_signatures: 65000n,
};
const STABLE = new Set(["usdc", "usdt"]);
const NATIVE_C = ["swap_eth_usdt", "approve_permit2_reset", "approve_permit2", "approve_ur", "swap_usdt_vkoin", "approve_bridge", "bridge_token"];
const TOKEN_C = ["approve_permit2_reset", "approve_permit2", "approve_ur", "swap_usdt_vkoin", "approve_bridge", "bridge_token"];
const sum = (a) => a.reduce((x, y) => x + BigInt(y), 0n);
const eth = (n) => ethers.formatEther(n);
const units = (asset, n) => ethers.formatUnits(n, asset === "eth" ? 18 : asset === "sol" ? 9 : 6);
const positive = (n, why) => { if (n <= 0n) throw new Error(why); return n; };

function create(ctx) {
  const S = ctx.settings;
  const accepted = new Map();
  let queue = Promise.resolve();
  // Admission, nonce allocation and sending share one lock. The parent holds
  // a process lock on the data directory so a second server cannot race it.
  const locked = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };
  const cfg = () => S.gasPolicy;
  const walletFor = async (account) => ctx.wallet
    ? ctx.wallet(account) : new ethers.Wallet(ctx.transit(account).ethPriv, await ctx.provider());
  const sponsorFor = async () => ctx.sponsorWallet
    ? ctx.sponsorWallet() : new ethers.Wallet(S.gasSponsorKey, await ctx.provider());
  const sponsorAddress = () => S.gasSponsorKey ? new ethers.Wallet(S.gasSponsorKey).address : null;
  const recipient = () => sponsorAddress() || (S.fee.treasury ? ethers.getAddress(S.fee.treasury) : null);
  const records = () => ctx.records();
  const save = (account, job) => { ctx.save(account, A.serialize(job)); return ctx.job(account); };

  async function market() {
    const p = await ctx.provider();
    const f = await p.getFeeData();
    const current = BigInt(f.maxFeePerGas ?? f.gasPrice ?? 0);
    positive(current, "Ethereum gas cannot be priced right now; try again before starting");
    const price = BigInt((await quotes.quoteUsdtOut({ amountWei: 10n ** 18n, provider: p })).usdt);
    positive(price, "ETH price is unavailable; no gas will be sponsored");
    return { current, expected: BigInt(f.gasPrice ?? current),
      ceiling: current + A.bps(current, cfg().priceHeadroomBps),
      priority: BigInt(f.maxPriorityFeePerGas ?? 0), price };
  }
  function stepCosts(steps, m) {
    const gasLimits = {};
    for (const s of steps) gasLimits[s] = GAS[s] + A.bps(GAS[s], cfg().gasHeadroomBps);
    return { gasLimits, maxGasWei: sum(Object.values(gasLimits)) * m.ceiling,
      estimatedGasWei: sum(steps.map((s) => GAS[s])) * m.expected };
  }
  async function capacity(maxSponsor, m, ignoreId) {
    if (maxSponsor <= 0n) return;
    if (!S.gasSponsorKey) throw new Error("Send ETH to your deposit address to pay for the first transaction");
    const usdLimit = BigInt(Math.round(S.fee.maxSponsoredUsd * 1e6));
    if (maxSponsor * m.price / 10n ** 18n > usdLimit) throw new Error("The estimated gas exceeds the sponsorship limit; use your own ETH or try when gas is lower");
    const p = await ctx.provider();
    const block = await p.getBlockNumber();
    const confirmedBlock = Math.max(0, ...records().flatMap((j) => Object.values(j.ethReceipts || {}))
      .filter((r) => r.from?.toLowerCase() === sponsorAddress().toLowerCase() || r.to?.toLowerCase() === sponsorAddress().toLowerCase())
      .map((r) => Number(r.blockNumber || 0)));
    if (block < confirmedBlock) throw new Error("The Ethereum node is behind the funding ledger; sponsorship is paused");
    A.admit({ balance: await p.getBalance(sponsorAddress(), block),
      jobs: records().filter((j) => j.id !== ignoreId), requested: maxSponsor, cfg: cfg() });
  }

  async function makePlan(account, asset, amount, route, m, solQuote) {
    const p = await ctx.provider(), t = ctx.transit(account);
    const own = BigInt(await p.getBalance(t.ethAddress, "latest"));
    const value = asset === "eth" ? amount : asset === "sol"
      ? BigInt(solQuote.valueWei) : A.ceilDiv(amount * 10n ** 18n, m.price);
    const rateBps = Math.round(S.fee.ratePct * 100);
    if (!Number.isSafeInteger(rateBps) || rateBps < 0 || rateBps > 10000) throw new Error("Invalid conversion fee setting");
    const serviceWei = A.bps(value, rateBps);
    const payTo = recipient();
    if (serviceWei > 0n && !payTo) throw new Error("The conversion fee recipient is not configured");
    let tail = route === "B" ? ["deposit_eth"] : route === "S" ? ["approve_bridge", "bridge_token"]
      : asset === "usdc" ? ["approve_v3_usdc", "swap_usdc_usdt", ...TOKEN_C]
      : asset === "usdt" ? [...TOKEN_C] : [...NATIVE_C];
    // Existing allowances remove unnecessary gas from the estimate. Permit2's
    // own expiration is checked separately; later reads still verify it.
    if (tail.includes("approve_permit2")) {
      const allowance = await swap.allowance(p, RC.USDT, t.ethAddress, RC.PERMIT2);
      if (BigInt(allowance) >= swap.MAX_UINT160) tail = tail.filter((s) => !s.startsWith("approve_permit2"));
      else if (BigInt(allowance) === 0n) tail = tail.filter((s) => s !== "approve_permit2_reset");
    }
    let steps = [...tail], preSteps = [], sponsoredRedeem = false;
    let advance = 0n, sponsorMax = 0n, recoveryWei = 0n, recoveryQuote = null;
    if (asset === "sol") {
      const redeem = stepCosts(["wh_redeem"], m).maxGasWei;
      // A direct sponsor redeem avoids sending an additional funding transfer.
      // Existing ETH sufficient for this transaction always takes precedence.
      sponsoredRedeem = own < redeem;
      if (route === "S" && sponsoredRedeem) throw new Error("Route S needs your own ETH; choose Route T to recover gas directly in ETH");
      if (sponsoredRedeem) sponsorMax = redeem;
      steps.unshift("wh_redeem");
    }
    if (serviceWei > 0n || sponsorMax > 0n) steps.push("collect_fee");
    if (STABLE.has(asset)) {
      const ordinary = stepCosts([...steps, "request_signatures"], m).maxGasWei + serviceWei;
      if (own < ordinary) {
        // An approval reset is included only for USDT when allowance is nonzero
        // and cannot cover the entire authorized input (and hence any slice).
        const allowance = BigInt(await swap.allowance(p, recovery.stableToken(asset), t.ethAddress, RC.V3_SWAP_ROUTER));
        if (allowance < amount) {
          if (asset === "usdt" && allowance > 0n) preSteps.push("gas_approve_reset");
          preSteps.push("gas_approve");
        }
        preSteps.push("gas_buy_eth");
        const pre = stepCosts(preSteps, m).maxGasWei;
        advance = A.shortfall(pre, own);
        if (advance > 0n) sponsorMax = advance + stepCosts(["front_gas"], m).maxGasWei;
        if (!steps.includes("collect_fee") && sponsorMax > 0n) steps.push("collect_fee");
        const required = sponsorMax + A.bps(sponsorMax, cfg().riskBps) + serviceWei + stepCosts([...steps, "request_signatures"], m).maxGasWei;
        recoveryWei = A.shortfall(required, A.shortfall(own + advance, pre));
        recoveryQuote = await recovery.quote({ asset, outputWei: recoveryWei, slippageBps: S.slippageBps, provider: p });
        if (recoveryQuote.maxInput >= amount) throw new Error("This deposit is too small to cover gas, ETH repayment and the conversion fee");
        steps.unshift(...preSteps);
        if (advance > 0n) steps.unshift("front_gas");
      }
    }
    const cost = stepCosts([...steps, "request_signatures"], m);
    // A renewal is a contingency reserve, not part of the expected fee.
    cost.estimatedGasWei -= GAS.request_signatures * m.expected;
    const premiumMax = A.bps(sponsorMax, cfg().riskBps);
    const estimatedSponsor = sponsoredRedeem ? GAS.wh_redeem * m.expected
      : advance > 0n ? advance + GAS.front_gas * m.expected : 0n;
    const estimatedFee = cost.estimatedGasWei + serviceWei + A.bps(estimatedSponsor, cfg().riskBps);
    const maxFee = cost.maxGasWei + serviceWei + premiumMax;
    if (asset === "eth" && own < amount + cost.maxGasWei) throw new Error("Leave more ETH available for this route's maximum gas budget");
    if (route === "S" && own < maxFee) throw new Error("Route S requires enough existing ETH for redemption, the complete route and its fee; choose Route T otherwise");
    await capacity(sponsorMax, m);
    const tailGasWei = stepCosts([...tail, "request_signatures"], m).maxGasWei;
    const collectionGasWei = cost.gasLimits.collect_fee ? cost.gasLimits.collect_fee * m.ceiling : 0n;
    const repaymentMax = sponsorMax + serviceWei + premiumMax;
    let input = amount, output;
    if (asset === "eth") {
      input = positive(amount - serviceWei, "The conversion fee exceeds the amount");
    } else if (route === "T") {
      input = positive(BigInt(solQuote.outAmount) * 10n ** 10n - tailGasWei - collectionGasWei - repaymentMax,
        "The ETH arriving from Solana cannot cover this route and repayment; convert more at once");
      if (input > ethers.parseEther(S.maxEth)) throw new Error("Choose a smaller SOL amount to stay within the ETH conversion limit");
    } else if (STABLE.has(asset) && recoveryQuote) input = amount - recoveryQuote.maxInput;
    if (route === "B") {
      const q = await koindx.quoteSwap({ amountInSats: input / 10n ** 10n, slippageBps: S.slippageBps,
        network: S.network, provider: ctx.koinosProvider() });
      output = { koinOut: String(q.amountOut), koinOutMin: String(q.amountOutMin) };
    } else if (route === "S") output = { koinOut: String(solQuote.outAmount), koinOutMin: String(solQuote.outAmountMin) };
    else if (asset === "usdc") output = await quotes.quoteUsdcToVkoin({ usdcSats: input, slippageBps: S.slippageBps, provider: p });
    else if (asset === "usdt") {
      const k = await quotes.quoteVkoinOut({ usdtSats: input, provider: p });
      output = { koinOut: String(k), koinOutMin: String(quotes.applySlippage(k, S.slippageBps)) };
    } else output = await quotes.quoteEthToVkoin({ amountEth: eth(input), slippageBps: S.slippageBps, provider: p });
    if (route === "T") {
      const worst = positive(BigInt(solQuote.outAmountMin) * 10n ** 10n - tailGasWei - collectionGasWei - repaymentMax,
        "The minimum Solana output would not cover gas and repayment");
      const q = await quotes.quoteEthToVkoin({ amountEth: eth(worst), slippageBps: S.slippageBps, provider: p });
      output.koinOutMin = q.koinOutMin;
    }
    const ownEthRequiredWei = asset === "eth" ? cost.maxGasWei : route === "S" ? maxFee
      : asset === "sol" ? (sponsoredRedeem ? 0n : stepCosts(["wh_redeem"], m).maxGasWei)
      : (recoveryQuote ? own : maxFee);
    // Authorization also covers ETH added while a job is in flight, so it can
    // avoid a previously quoted advance without silently changing fee sources.
    const ownEthMaxWei = asset === "eth" ? cost.maxGasWei : asset === "sol" && route === "T"
      ? stepCosts(["wh_redeem"], m).maxGasWei : maxFee;
    // Rank routes on output minus fees paid from an existing ETH balance as
    // well. The displayed delivery amount itself must not subtract them twice.
    const externalCost = ownEthRequiredWei > 0n
      ? BigInt((await quotes.quoteEthToVkoin({ amountEth: eth(ownEthRequiredWei), slippageBps: 0, provider: p })).koinOut) : 0n;
    const comparisonKoinOut = A.shortfall(BigInt(output.koinOut), externalCost);
    const now = Date.now();
    return A.serialize({ version: 2, id: crypto.randomUUID(), account, asset, route, inputAmount: amount,
      createdAt: now, expiresAt: now + cfg().quoteSeconds * 1000, priceTimestamp: now,
      feeRecipient: payTo, sponsorAddress: sponsorMax > 0n ? sponsorAddress() : null,
      maxFeePerGas: m.ceiling, priorityFeePerGas: m.priority, ethUsdUnits: m.price,
      gasLimits: cost.gasLimits, gasMaxWei: cost.maxGasWei, estimatedFeeWei: estimatedFee, maxFeeWei: maxFee,
      serviceWei, riskBps: cfg().riskBps, sponsorMaxWei: sponsorMax, advanceMaxWei: advance,
      sponsoredRedeem, recoveryWei, recovery: recoveryQuote, preSteps, tail, tailGasWei, collectionGasWei,
      koinOut: output.koinOut, koinOutMin: output.koinOutMin, comparisonKoinOut, nativeInputWei: input, valueWei: value,
      minSolOutput: solQuote ? solQuote.outAmountMin : null,
      expectedNativeArrivalWei: route === "T" ? BigInt(solQuote.outAmount) * 10n ** 10n : 0n,
      // Existing ETH used for SOL redemption / route S is paid separately;
      // ETH input excludes its gas reserve; stables use the ETH balance first.
      ownEthMaxWei, ownEthRequiredWei,
    });
  }

  function line(plan, extra = {}) {
    const usd = (w) => Number(BigInt(w) * BigInt(plan.ethUsdUnits) / 10n ** 18n) / 1e6;
    const valueUsd = plan.asset === "eth" ? usd(plan.inputAmount) : plan.asset === "sol"
      ? usd(plan.valueWei) : Number(plan.inputAmount) / 1e6;
    const feeUsd = usd(plan.estimatedFeeWei), pct = valueUsd > 0 ? feeUsd / valueUsd * 100 : undefined;
    const warnings = [];
    if (feeUsd >= S.fee.warnUsd) warnings.push(`estimated fees are $${feeUsd.toFixed(2)}`);
    if (pct != null && pct >= S.fee.warnPct) warnings.push(`that is ${pct.toFixed(1)}% of this conversion`);
    return { ...routes.descriptor(plan.route), ...extra,
      quoteId: plan.id, quoteExpiresAt: plan.expiresAt, feeModel: 2,
      koinOut: plan.koinOut, koinOutMin: plan.koinOutMin, comparisonKoinOut: plan.comparisonKoinOut, minimumConditional: true,
      feeEth: eth(plan.estimatedFeeWei), feeUsd: Number(feeUsd.toFixed(2)), feePct: pct,
      maxFeeEth: eth(plan.maxFeeWei), maxFeeUsd: Number(usd(plan.maxFeeWei).toFixed(2)),
      platformFeeEth: eth(plan.serviceWei), networkMaxEth: eth(plan.gasMaxWei),
      sponsorMaxEth: eth(plan.sponsorMaxWei), recoveryInputMax: plan.recovery ? units(plan.asset, plan.recovery.maxInput) : null,
      sponsorshipPremiumMaxEth: eth(A.bps(plan.sponsorMaxWei, plan.riskBps)),
      ownEthMax: eth(plan.ownEthMaxWei), expectedOwnEth: eth(plan.ownEthRequiredWei), unusedGasStaysInWallet: true,
      solReserve: plan.asset === "sol" ? S.solReserve : undefined,
      feeWarn: warnings.length > 0, feeReasons: warnings, feeLevel: warnings.length ? "warn" : "ok" };
  }
  async function quote(account, asset, amount) {
    const m = await market();
    const choices = asset === "sol" ? ["T", "S"] : asset === "eth" ? ["C", "B"] : ["C"];
    const solResults = asset === "sol" ? await Promise.allSettled(choices.map((route) =>
      jup.quote({ amount, slippageBps: S.slippageBps, outputMint: route === "T" ? SC.WETH_SOL_MINT : SC.VKOIN_SOL_MINT }))) : [];
    const tQuote = solResults[0] && solResults[0].status === "fulfilled" ? solResults[0].value : null;
    const solValue = tQuote ? BigInt(tQuote.outAmount) * 10n ** 10n : 0n;
    const all = await Promise.all(choices.map(async (route, i) => {
      try {
        let sq;
        if (asset === "sol") {
          if (!solValue || solResults[i].status !== "fulfilled") throw new Error("The SOL route cannot be priced right now");
          sq = { ...solResults[i].value, valueWei: solValue };
        }
        const plan = await makePlan(account, asset, amount, route, m, sq);
        for (const [id, old] of accepted) if (old.expiresAt < Date.now()) accepted.delete(id);
        if (accepted.size >= 2000) accepted.delete(accepted.keys().next().value);
        accepted.set(plan.id, plan);
        return line(plan, sq ? { via: sq.via, priceImpactPct: sq.priceImpactPct, ethBought: route === "T" ? eth(solValue) : undefined } : {});
      } catch (e) { return { ...routes.descriptor(route), koinOut: null, error: String(e.message || e) }; }
    }));
    return { asset, amount: units(asset, amount), ...routes.compareRoutes(all) };
  }

  async function start(account, { asset, amount, route, quoteId }, balances) {
    return locked(async () => {
      const plan = accepted.get(quoteId);
      if (!plan || plan.expiresAt < Date.now()) throw new Error("The fee quote expired; refresh the quote and confirm again");
      if (plan.account !== account || plan.asset !== asset || plan.route !== route || BigInt(plan.inputAmount) !== amount) throw new Error("The fee quote does not match this conversion; refresh it");
      const prior = ctx.job(account);
      if (prior && prior.status !== "done") throw new Error("Finish or safely reset the previous conversion first");
      const p = await ctx.provider(), t = ctx.transit(account);
      const own = BigInt(await p.getBalance(t.ethAddress, "latest"));
      const input = STABLE.has(asset) ? BigInt(await swap.balanceOf(p, recovery.stableToken(asset), t.ethAddress)) : null;
      if (input != null && input < amount) throw new Error("The deposit balance changed; refresh the quote");
      if (own < BigInt(plan.ownEthRequiredWei) + (asset === "eth" ? amount : 0n)) throw new Error("The available ETH changed; refresh the quote");
      await capacity(BigInt(plan.sponsorMaxWei), { price: BigInt(plan.ethUsdUnits) });
      const job = { id: crypto.randomUUID(), asset, route, feePlan: plan, ethReceipts: {},
        ethFrom: t.ethAddress, koinosRecipient: account, startedAt: Date.now(), taps: 0,
        amountLabel: units(asset, amount) + " " + asset.toUpperCase(), slippageBps: S.slippageBps,
        estKoinOut: plan.koinOut, estFeeEth: eth(plan.estimatedFeeWei),
        status: asset === "sol" ? "sol_swap" : BigInt(plan.advanceMaxWei) > 0n ? "front_gas"
          : plan.recovery ? (plan.preSteps[0] || "gas_buy_eth") : "collect_fee",
        ...(asset === "eth" ? { amountWei: plan.nativeInputWei, amountEth: eth(plan.nativeInputWei) }
          : asset === "sol" ? { solLamports: amount.toString(), amountSol: units(asset, amount), solFrom: t.solAddress,
            solTokenBefore: (route === "T" ? balances.solWethSats : balances.solVkoinSats) || "0" }
          : { [asset + "Sats"]: amount.toString() }),
      };
      save(account, job); // reservation is durable before any upstream swap
      accepted.delete(quoteId);
      return ctx.job(account);
    });
  }

  return { quote, start, line, locked, makePlan, walletFor, sponsorFor, save, capacity, cfg,
    // Execution methods are installed below to keep quoting free of sends.
    ...executor({ ctx, S, cfg, locked, walletFor, sponsorFor, save, capacity }) };
}

function executor({ ctx, S, cfg, locked, walletFor, sponsorFor, save, capacity }) {
  const setState = (account, j, status, extra = {}) => save(account, { ...j, status,
    confirmedEth: null, pendingEth: null, pendingTx: null, ...extra });
  const allGas = (j) => sum(Object.values(j.ethReceipts || {}).map((r) => r.gasWei));
  const requestFee = (plan, f) => {
    const current = BigInt(f.maxFeePerGas ?? f.gasPrice ?? 0);
    positive(current, "Ethereum gas is unavailable; no transaction was sent");
    if (current > BigInt(plan.maxFeePerGas)) throw new Error("Gas rose above your approved maximum. Wait for lower gas, then Retry; your fee limit will not be increased automatically");
    return f.maxFeePerGas != null
      ? { maxFeePerGas: BigInt(plan.maxFeePerGas), maxPriorityFeePerGas: A.max(BigInt(f.maxPriorityFeePerGas ?? 0), BigInt(plan.priorityFeePerGas)) }
      : { gasPrice: BigInt(f.gasPrice) };
  };

  async function broadcast(account, j) {
    const p = await ctx.provider();
    try { await p.broadcastTransaction(j.pendingEth.raw); }
    catch (e) {
      // A lost response must never produce a second transaction. Keep the raw
      // signed transaction and its nonce even on an ambiguous RPC failure.
      if (!/already known|known transaction|nonce too low/i.test(String(e.message || e))) throw e;
    }
    return ctx.job(account);
  }

  async function send(account, j, req, { sponsored = false, advanceWei = 0n, recoveredWei = 0n } = {}) {
    const p = await ctx.provider(), plan = j.feePlan;
    if (j.pendingEth || j.confirmedEth) throw new Error("The previous transaction must be reconciled first");
    const wallet = sponsored ? await sponsorFor() : await walletFor(account);
    if (sponsored && wallet.address.toLowerCase() !== String(plan.sponsorAddress).toLowerCase()) throw new Error("The original gas sponsor must remain configured until this job is settled");
    const tx = { to: req.to, data: req.data || "0x", value: BigInt(req.value || 0), from: wallet.address };
    const estimate = BigInt(await wallet.estimateGas(tx));
    const limit = estimate + A.bps(estimate, cfg().gasHeadroomBps);
    const stepLimit = BigInt(plan.gasLimits[j.status] || 0);
    if (limit > stepLimit) throw new Error("This step needs more gas than the approved route budget; no transaction was sent");
    const f = requestFee(plan, await p.getFeeData());
    const capPrice = BigInt(f.maxFeePerGas ?? f.gasPrice);
    if (f.maxPriorityFeePerGas != null && f.maxPriorityFeePerGas > capPrice) throw new Error("The network tip exceeds the approved gas cap");
    const maxGas = limit * capPrice;
    if (allGas(j) + maxGas > BigInt(plan.gasMaxWei)) throw new Error("The approved gas budget is exhausted; this job needs review before any more spending");
    const c = A.costs(j);
    if (sponsored) {
      const remaining = A.shortfall(plan.sponsorMaxWei, c.sponsor);
      if (BigInt(advanceWei) + maxGas > remaining) throw new Error("This job has reached its sponsorship limit");
      await capacity(remaining, { price: BigInt(plan.ethUsdUnits) }, j.id);
    }
    const balance = BigInt(await p.getBalance(wallet.address, "latest"));
    if (balance < tx.value + maxGas) throw new Error("There is not enough confirmed ETH for this step; no extra gas will be advanced automatically");
    const network = await p.getNetwork();
    if (BigInt(network.chainId) !== 1n) throw new Error("The funding plan must execute on Ethereum mainnet");
    let nonce = await p.getTransactionCount(wallet.address, "pending");
    for (const job of ctx.records()) {
      const pending = job.pendingEth;
      if (pending && pending.from.toLowerCase() === wallet.address.toLowerCase()) nonce = Math.max(nonce, Number(pending.nonce) + 1);
      for (const receipt of Object.values(job.ethReceipts || {})) {
        if (receipt.from?.toLowerCase() === wallet.address.toLowerCase()) nonce = Math.max(nonce, Number(receipt.nonce) + 1);
      }
    }
    const populated = { to: tx.to, data: tx.data, value: tx.value, nonce, chainId: 1n, gasLimit: limit, ...f };
    const raw = await wallet.signTransaction(populated), hash = ethers.keccak256(raw);
    // Persist before the first broadcast, including exact advance and creditor.
    const current = save(account, { ...j, pendingTx: hash,
      pendingEth: { raw, hash, nonce, from: wallet.address, to: tx.to, valueWei: tx.value,
        state: j.status, sponsored, advanceWei, recoveredWei, maxGasWei: maxGas, createdAt: Date.now() } });
    return broadcast(account, current);
  }

  async function confirmed(account, j, receipt) {
    const pending = j.pendingEth, gas = A.gasPaid(receipt);
    const entry = { hash: pending.hash, nonce: pending.nonce, state: pending.state,
      from: pending.from, to: pending.to, sponsored: pending.sponsored,
      success: Number(receipt.status) === 1, gasWei: gas,
      advanceWei: pending.advanceWei, recoveredWei: pending.recoveredWei,
      blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
    };
    const receipts = { ...j.ethReceipts, [pending.hash]: entry };
    const c = A.costs({ ...j, ethReceipts: receipts });
    const storedReceipt = { status: Number(receipt.status), gasUsed: String(receipt.gasUsed), gasPrice: String(receipt.gasPrice ?? receipt.effectiveGasPrice),
      blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, logs: receipt.logs || [] };
    // Record gas even if the operation reverted. If reading delivered amounts
    // later fails, confirmedEth survives and finish() is resumed without a send.
    const current = save(account, { ...j, pendingTx: null, pendingEth: null,
      ethReceipts: receipts, sponsorWei: c.sponsor.toString(),
      confirmedEth: { ...pending, raw: undefined, receipt: storedReceipt } });
    if (!entry.success) return save(account, { ...current, status: "error", failedAt: pending.state,
      confirmedEth: null, error: "Ethereum transaction reverted. Its gas is recorded; Retry stays within the same approved budget." });
    return finish(account, current);
  }
  async function delivered(j, token, before) {
    const r = j.confirmedEth.receipt;
    const fromLogs = swap.receivedInTx(r, token, j.ethFrom);
    if (fromLogs !== null) return fromLogs;
    return BigInt(await swap.balanceOf(await ctx.provider(), token, j.ethFrom, r.blockNumber)) - BigInt(before || 0);
  }
  function prepareNative(j) {
    const arrived = BigInt(j.vaaAmount || 0) * 10n ** 10n;
    positive(arrived, "The Wormhole native ETH amount is missing");
    const due = A.repayment(j).total;
    const amount = positive(arrived - BigInt(j.feePlan.tailGasWei) - BigInt(j.feePlan.collectionGasWei) - due,
      "The received ETH cannot cover the remaining route and repayment; no further sponsorship will be sent");
    if (amount > ethers.parseEther(S.maxEth)) throw new Error("The received ETH exceeds the authorized conversion limit");
    return { ethReceivedWei: arrived.toString(), amountWei: amount.toString(), amountEth: eth(amount) };
  }
  async function finish(account, j) {
    const state = j.confirmedEth.state, plan = j.feePlan;
    switch (state) {
      case "front_gas": return setState(account, j, plan.preSteps[0]);
      case "gas_approve_reset": return setState(account, j, "gas_approve");
      case "gas_approve": return setState(account, j, "gas_buy_eth");
      case "gas_buy_eth": {
        const change = await delivered(j, recovery.stableToken(j.asset), j.recoveryTokenBefore);
        const spent = -change;
        if (spent <= 0n || spent > BigInt(plan.recovery.maxInput)) throw new Error("The recovery input cannot be reconciled with its approved limit");
        const remaining = BigInt(plan.inputAmount) - spent;
        return setState(account, j, "collect_fee", { [j.asset + "Sats"]: remaining.toString(),
          recoveryInputSpent: spent.toString(), nativeBoughtWei: plan.recoveryWei });
      }
      case "wh_redeem": {
        if (j.route === "T") return setState(account, j, "collect_fee", prepareNative(j));
        const got = positive(await delivered(j, RC.VKOIN, j.vkoinBefore), "No vKOIN was received from Wormhole");
        return setState(account, j, "collect_fee", { vkoinSats: got.toString() });
      }
      case "collect_fee": return setState(account, j, plan.tail[0], {
        settlementComplete: true, settlementTx: j.confirmedEth.hash,
        feePaidWei: j.confirmedEth.valueWei, reservationReleased: true,
      });
      case "approve_v3_usdc": return setState(account, j, "swap_usdc_usdt");
      case "swap_usdc_usdt":
      case "swap_eth_usdt": {
        const got = positive(await delivered(j, RC.USDT, j.usdtBefore), "The swap produced no USDT");
        const next = plan.tail.find((s) => s.startsWith("approve_permit2")) || "approve_ur";
        return setState(account, j, next, { usdtSats: got.toString() });
      }
      case "approve_permit2_reset": return setState(account, j, "approve_permit2");
      case "approve_permit2": return setState(account, j, "approve_ur");
      case "approve_ur": return setState(account, j, "swap_usdt_vkoin");
      case "swap_usdt_vkoin": {
        const got = positive(await delivered(j, RC.VKOIN, j.vkoinBefore), "The swap produced no vKOIN");
        if (got < BigInt(plan.koinOutMin)) throw new Error("The output is below the accepted KOIN minimum; reconciliation is required");
        return setState(account, j, "approve_bridge", { vkoinSats: got.toString() });
      }
      case "approve_bridge": return setState(account, j, "bridge_token");
      case "bridge_token":
      case "deposit_eth": return setState(account, j, "awaiting_signatures", {
        ethTxHash: j.confirmedEth.hash, sigStartedAt: Date.now(),
      });
      case "request_signatures": return setState(account, j, "awaiting_signatures", { sigStartedAt: Date.now() });
      default: throw new Error(`Unknown confirmed funding step ${state}`);
    }
  }

  async function advance(account, snapshot) {
    return locked(async () => {
      let j = ctx.job(account);
      if (!j || j.id !== snapshot.id || j.status !== snapshot.status) return;
      if (j.confirmedEth) return finish(account, j);
      const p = await ctx.provider(), wallet = await walletFor(account), plan = j.feePlan;
      if (j.pendingEth) {
        const r = await p.getTransactionReceipt(j.pendingEth.hash);
        if (!r) return broadcast(account, j);
        if (await p.getBlockNumber() - Number(r.blockNumber) + 1 < cfg().confirmations) return;
        return confirmed(account, j, r);
      }
      const now = Math.floor(Date.now() / 1000);
      // Every tail spend is gated by ETH settlement, including retries. A token
      // balance can never be interpreted as evidence that a fee was paid.
      if (plan.tail.includes(j.status) && !j.settlementComplete) throw new Error("ETH repayment must be confirmed before the conversion can continue");
      switch (j.status) {
        case "front_gas": {
          const pre = sum(plan.preSteps.map((s) => plan.gasLimits[s])) * BigInt(plan.maxFeePerGas);
          const available = BigInt(await p.getBalance(wallet.address, "latest"));
          const selfFunded = A.repayment(j).total + BigInt(plan.tailGasWei) + BigInt(plan.collectionGasWei);
          if (available >= selfFunded) return setState(account, j, "collect_fee");
          const amount = A.shortfall(pre, available);
          if (amount === 0n) return setState(account, j, plan.preSteps[0]);
          if (amount > BigInt(plan.advanceMaxWei)) throw new Error("The ETH shortfall increased; refresh the fee plan before funding");
          if (Object.values(j.ethReceipts).some((r) => r.success && BigInt(r.advanceWei || 0) > 0n)) throw new Error("This job already received its gas advance; no duplicate top-up will be sent");
          return send(account, j, { to: wallet.address, value: amount }, { sponsored: true, advanceWei: amount });
        }
        case "gas_approve_reset":
        case "gas_approve": {
          const token = recovery.stableToken(j.asset), current = BigInt(await swap.allowance(p, token, wallet.address, RC.V3_SWAP_ROUTER));
          const need = BigInt(plan.recovery.maxInput);
          if (current >= need) return setState(account, j, "gas_buy_eth");
          if (j.status === "gas_approve_reset" && current === 0n) return setState(account, j, "gas_approve");
          return send(account, j, swap.buildApproveTx(token, RC.V3_SWAP_ROUTER, j.status === "gas_approve_reset" ? 0n : need));
        }
        case "gas_buy_eth": {
          const fresh = await recovery.quote({ asset: j.asset, outputWei: plan.recoveryWei, slippageBps: 0, provider: p });
          if (fresh.amountIn > BigInt(plan.recovery.maxInput)) throw new Error("The ETH recovery price moved above your approved token limit; wait and Retry");
          const held = BigInt(await swap.balanceOf(p, recovery.stableToken(j.asset), wallet.address));
          if (held < BigInt(plan.inputAmount)) throw new Error("The authorized token deposit is no longer available");
          j = save(account, { ...j, recoveryTokenBefore: held.toString() });
          return send(account, j, recovery.build({ asset: j.asset, recipient: wallet.address,
            outputWei: plan.recoveryWei, maxInput: plan.recovery.maxInput, fee: fresh.fee, deadline: now + 300 }));
        }
        case "wh_redeem": {
          if (await wormhole.isRedeemedOnEthereum(p, j.vaaEvmHash)) {
            // Our own sends always have a durable journal; without one an
            // outside party redeemed this VAA. Never invent sponsor spending.
            const extra = j.route === "T" ? prepareNative(j) : { vkoinSats: (BigInt(j.vaaAmount || 0)).toString() };
            return setState(account, j, "collect_fee", extra);
          }
          const native = j.route === "T";
          j = save(account, { ...j, vkoinBefore: native ? undefined : String(await swap.balanceOf(p, RC.VKOIN, wallet.address)) });
          // If ETH was deposited while the bridge was in flight, prefer it.
          const own = BigInt(await p.getBalance(wallet.address, "latest"));
          const budget = BigInt(plan.gasLimits.wh_redeem) * BigInt(plan.maxFeePerGas);
          const useSponsor = own < budget;
          if (useSponsor && !plan.sponsoredRedeem) throw new Error("The ETH reserved for redemption is missing; no unapproved sponsorship will be added");
          return send(account, j, wormhole.buildCompleteTransferTx(j.vaa, { unwrap: native }), { sponsored: useSponsor });
        }
        case "collect_fee": {
          if (j.settlementComplete) return setState(account, j, plan.tail[0]);
          const due = A.repayment(j);
          if (due.total === 0n) return setState(account, j, plan.tail[0], { settlementComplete: true, reservationReleased: true, feePaidWei: "0" });
          if (!plan.feeRecipient) throw new Error("The original ETH repayment address is missing");
          const balance = BigInt(await p.getBalance(wallet.address, "latest"));
          const swapInput = j.asset === "eth" || j.route === "T" ? BigInt(j.amountWei || 0) : 0n;
          if (balance < due.total + BigInt(plan.tailGasWei) + BigInt(plan.collectionGasWei) + swapInput) throw new Error("Not enough ETH to repay the full fee and finish the route; repayment will not be silently reduced");
          return send(account, j, { to: plan.feeRecipient, value: due.total }, { recoveredWei: due.principal });
        }
        case "approve_v3_usdc": {
          const need = BigInt(j.usdcSats);
          if (BigInt(await swap.allowance(p, RC.USDC, wallet.address, RC.V3_SWAP_ROUTER)) >= need) return setState(account, j, "swap_usdc_usdt");
          return send(account, j, swap.buildApproveTx(RC.USDC, RC.V3_SWAP_ROUTER, need));
        }
        case "swap_usdc_usdt": {
          const q = await quotes.quoteUsdcOut({ usdcSats: j.usdcSats, provider: p });
          j = save(account, { ...j, usdtBefore: String(await swap.balanceOf(p, RC.USDT, wallet.address)) });
          return send(account, j, swap.buildUsdcToUsdtTx({ recipient: wallet.address, usdcAmount: j.usdcSats,
            fee: q.fee, minUsdtOut: quotes.applySlippage(q.usdt, j.slippageBps) }));
        }
        case "swap_eth_usdt": {
          const q = await quotes.quoteUsdtOut({ amountWei: j.amountWei, provider: p });
          j = save(account, { ...j, usdtBefore: String(await swap.balanceOf(p, RC.USDT, wallet.address)) });
          return send(account, j, swap.buildEthToUsdtTx({ recipient: wallet.address, amountWei: j.amountWei,
            fee: q.fee, minUsdtOut: quotes.applySlippage(q.usdt, j.slippageBps) }));
        }
        case "approve_permit2_reset":
        case "approve_permit2": {
          const current = BigInt(await swap.allowance(p, RC.USDT, wallet.address, RC.PERMIT2));
          if (current >= BigInt(j.usdtSats)) return setState(account, j, "approve_ur");
          if (j.status === "approve_permit2_reset" && current === 0n) return setState(account, j, "approve_permit2");
          return send(account, j, swap.buildApproveTx(RC.USDT, RC.PERMIT2, j.status === "approve_permit2_reset" ? 0n : swap.MAX_UINT256));
        }
        case "approve_ur": {
          const a = await swap.permit2Allowance(p, wallet.address, RC.USDT, RC.UNIVERSAL_ROUTER);
          if (BigInt(a.amount) >= BigInt(j.usdtSats) && Number(a.expiration) > now + 300) return setState(account, j, "swap_usdt_vkoin");
          return send(account, j, swap.buildPermit2ApproveTx({ token: RC.USDT, spender: RC.UNIVERSAL_ROUTER,
            amount: j.usdtSats, expiration: now + 3600 }));
        }
        case "swap_usdt_vkoin": {
          const q = BigInt(await quotes.quoteVkoinOut({ usdtSats: j.usdtSats, provider: p }));
          if (q < BigInt(plan.koinOutMin)) throw new Error("The market moved below your approved KOIN minimum; wait and Retry");
          j = save(account, { ...j, vkoinBefore: String(await swap.balanceOf(p, RC.VKOIN, wallet.address)) });
          return send(account, j, swap.buildUsdtToVkoinTx({ usdtAmount: j.usdtSats,
            minVkoinOut: A.max(BigInt(plan.koinOutMin), quotes.applySlippage(q, j.slippageBps)), deadline: now + 300 }));
        }
        case "approve_bridge": {
          const to = BC.BRIDGE[S.network].ethBridge;
          if (BigInt(await swap.allowance(p, RC.VKOIN, wallet.address, to)) >= BigInt(j.vkoinSats)) return setState(account, j, "bridge_token");
          return send(account, j, swap.buildApproveTx(RC.VKOIN, to, j.vkoinSats));
        }
        case "bridge_token": return send(account, j, buildTransferTokensTx({ token: RC.VKOIN, amountSats: j.vkoinSats,
          koinosRecipient: account, relayer: ctx.relayer(), network: S.network }));
        case "deposit_eth": {
          if (!bridge.validKoinosAddress(account)) throw new Error("Invalid Koinos recipient");
          const b = BC.BRIDGE[S.network];
          const data = new ethers.Interface(bridge.BRIDGE_ABI).encodeFunctionData("wrapAndTransferETH", [0, ctx.relayer(), account, "", b.toChain]);
          return send(account, j, { to: b.ethBridge, data, value: BigInt(j.amountWei) });
        }
        case "request_signatures": {
          const data = new ethers.Interface(bridge.BRIDGE_ABI).encodeFunctionData("RequestNewSignatures", [j.ethTxHash]);
          return send(account, j, { to: BC.BRIDGE[S.network].ethBridge, data, value: 0n });
        }
        default: throw new Error(`Unsupported Ethereum funding step ${j.status}`);
      }
    });
  }
  async function resume(account) {
    return locked(async () => {
      const j = ctx.job(account);
      if (!j || j.status !== "error") throw new Error("The conversion is still in progress; its recorded transaction will be reconciled automatically");
      const status = j.pendingEth?.state || j.confirmedEth?.state || j.failedAt;
      if (!status) throw new Error("This conversion needs reconciliation before retrying");
      return save(account, { ...j, status, failedAt: null, error: null, lastError: null, transientCount: 0 });
    });
  }
  return { advance, resume, finish, send, confirmed, assertCapacity: async (j) => {
    const remaining = A.shortfall(j.feePlan.sponsorMaxWei, A.costs(j).sponsor);
    if (remaining > 0n) {
      if (!S.gasSponsorKey || (await sponsorFor()).address.toLowerCase() !== String(j.feePlan.sponsorAddress).toLowerCase()) {
        throw new Error("The original gas sponsor must remain configured before moving this deposit");
      }
      await capacity(remaining, { price: BigInt(j.feePlan.ethUsdUnits) }, j.id);
    }
  } };
}

module.exports = { create, GAS };
