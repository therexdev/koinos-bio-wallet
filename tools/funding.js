/* ============================================================
   Fund with ETH / USDC / USDT — the smart-account adaptation of Koinos
   Node Desktop's two-route ETH→KOIN pipeline.

   Every account gets a TRANSIT Ethereum address (a server-held key, like
   the bootstrap key — data/funding.json, mode 600). Deposits sent there
   are swapped to KOIN through whichever route currently yields more:

     Route B: ETH → Vortex (vETH) → KoinDX vETH/KOIN → KOIN
     Route C: ETH → USDT → vKOIN (Uniswap v4) → Vortex 1:1 → KOIN
     USDC/USDT deposits always take Route C's tail (USDC adds one deep
     stable-pair hop).

   The server drives the Ethereum legs with the transit key. The KOINOS
   legs (bridge redeem; Route B's KoinDX swap) mint/spend on the SMART
   ACCOUNT, so they pause at `awaiting_redeem` / `awaiting_swap` until the
   PASSKEY signs the prepared transaction — the chain, not this server,
   authorizes the landing. Custody is therefore transit-only: funds are
   server-held exactly while they cross, and land under passkey authority.

   Jobs persist after every transition (crash/restart resumes from
   on-chain reality), amounts are read from actual balances (never
   assumed), every swap carries an on-chain min-out, and each Ethereum
   step is one transaction awaited to its receipt — all inherited from the
   desktop orchestrators this is ported from.
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const chain = require("./chain");
const RC = require("./eth/route-constants");
const routes = require("./eth/fund-routes");
const ethSwap = require("./eth/eth-swap");
const swap = require("./eth/eth-swap-exec");
const { makeProvider } = require("./eth/eth-bridge");
const ethBridge = require("./eth/eth-bridge");
const { buildTransferTokensTx, bridgePaused } = require("./eth/eth-bridge-token");
const { fetchEthDepositRecord, isRedeemable, weiToVethSats } = require("./eth/bridge");
const { opCompleteTransfer, DEFAULT_REDEEM_RC } = require("./eth/koinos-bridge");
const koindx = require("./eth/koindx");
const U = require("./eth/units");

const S = {
  dataDir: path.join(__dirname, "..", "data"),
  demo: false,
  network: "mainnet",
  maxEth: process.env.FUND_MAX_ETH || "0.05",
  maxStable: process.env.FUND_MAX_STABLE || "150",
  slippageBps: parseInt(process.env.FUND_SLIPPAGE_BPS || "150", 10),
  gasSponsorKey: (process.env.ETH_GAS_SPONSOR_KEY || "").trim(),
  gasTopupEth: process.env.ETH_GAS_TOPUP || "0.0015",
  gasMinEth: process.env.ETH_GAS_MIN || "0.0012",
  store: { transit: {}, jobs: {} },
};

const PERMIT2_EXPIRY_SEC = 3600;
const SWAP_DEADLINE_SEC = 1800;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;
const TICK_MS = 4000;

const TERMINAL = new Set(["done", "error"]);
/* States the server drives with the transit key on Ethereum. */
const ETH_STATES = new Set([
  "front_gas", "approve_v3_usdc", "swap_usdc_usdt", "swap_eth_usdt",
  "approve_permit2", "approve_ur", "swap_usdt_vkoin", "approve_bridge",
  "bridge_token", "deposit_eth",
]);
/* States that wait on the user's passkey. */
const TAP_STATES = new Set(["awaiting_redeem", "awaiting_swap"]);

const file = () => path.join(S.dataDir, "funding.json");
const BUSY = new Set();
let _timer = null, _ethProvider = null;

function configure(opts) {
  Object.assign(S, opts || {});
  fs.mkdirSync(S.dataDir, { recursive: true, mode: 0o700 });
  try {
    S.store = JSON.parse(fs.readFileSync(file(), "utf8"));
    S.store.transit ||= {}; S.store.jobs ||= {};
  } catch (_) { S.store = { transit: {}, jobs: {} }; }
  if (!_timer) {
    _timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
    if (_timer.unref) _timer.unref();
  }
}

function persist() {
  const tmp = file() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(S.store, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

/* ---------------- transit addresses ---------------- */

function enable(account) {
  let t = S.store.transit[account];
  if (!t) {
    const w = ethers.Wallet.createRandom();
    t = { ethAddress: w.address, ethPriv: w.privateKey, ts: Date.now() };
    S.store.transit[account] = t;
    persist();
  }
  return { ethAddress: t.ethAddress };
}
const transitFor = (account) => S.store.transit[account] || null;

async function ethProvider() {
  if (!_ethProvider) _ethProvider = await makeProvider();
  return _ethProvider;
}
function dropProvider() { _ethProvider = null; }

async function transitWallet(account) {
  const t = transitFor(account);
  if (!t) throw new Error("Funding is not enabled for this account");
  return new ethers.Wallet(t.ethPriv, await ethProvider());
}

/* ---------------- balances + quotes ---------------- */

const BAL_CACHE = new Map(); // account → { at, balances }
async function balances(account) {
  const t = transitFor(account);
  if (!t) return null;
  if (S.demo) return demoBalances(account);
  const hit = BAL_CACHE.get(account);
  if (hit && Date.now() - hit.at < 10000) return hit.balances;
  const p = await ethProvider();
  const [eth, usdc, usdt, vkoin] = await Promise.all([
    p.getBalance(t.ethAddress),
    swap.balanceOf(p, RC.USDC, t.ethAddress),
    swap.balanceOf(p, RC.USDT, t.ethAddress),
    swap.balanceOf(p, RC.VKOIN, t.ethAddress),
  ]);
  const out = {
    eth: ethers.formatEther(eth), ethWei: eth.toString(),
    usdc: U.formatUsdc(usdc), usdcSats: usdc.toString(),
    usdt: U.formatUsdt(usdt), usdtSats: usdt.toString(),
    vkoin: U.formatVkoin(vkoin), vkoinSats: vkoin.toString(),
  };
  BAL_CACHE.set(account, { at: Date.now(), balances: out });
  return out;
}

/* What a given deposit would yield, per route, using the ported comparison. */
async function quotes(account) {
  const bal = await balances(account);
  if (!bal) return null;
  if (S.demo) return demoQuotes(bal);
  const out = {};
  const p = await ethProvider();
  const gasReserve = ethers.parseEther(S.gasMinEth);

  const spendableWei = BigInt(bal.ethWei) > gasReserve * 2n ? BigInt(bal.ethWei) - gasReserve * 2n : 0n;
  if (spendableWei > 0n) {
    const capWei = ethers.parseEther(S.maxEth);
    const amtWei = spendableWei > capWei ? capWei : spendableWei;
    const amountEth = ethers.formatEther(amtWei);
    const qs = [];
    try {
      const c = await ethSwap.quoteEthToVkoin({ amountEth, slippageBps: S.slippageBps, provider: p });
      qs.push({ ...routes.descriptor("C"), koinOut: c.koinOut, koinOutMin: c.koinOutMin });
    } catch (e) { qs.push({ ...routes.descriptor("C"), koinOut: null, error: String(e.message || e) }); }
    try {
      const veth = weiToVethSats(amtWei).sats;
      const b = await koindx.quoteSwap({ amountInSats: veth, slippageBps: S.slippageBps, network: S.network, provider: chain.provider() });
      qs.push({ ...routes.descriptor("B"), koinOut: b.amountOut, koinOutMin: b.amountOutMin });
    } catch (e) { qs.push({ ...routes.descriptor("B"), koinOut: null, error: String(e.message || e) }); }
    out.eth = { amount: amountEth, ...routes.compareRoutes(qs) };
  }
  for (const [asset, sats, cap, quoteFn] of [
    ["usdc", bal.usdcSats, U.parseUsdc(S.maxStable), (v) => ethSwap.quoteUsdcToVkoin({ usdcSats: v, slippageBps: S.slippageBps, provider: p })],
    ["usdt", bal.usdtSats, U.parseUsdt(S.maxStable), async (v) => {
      const koin = await ethSwap.quoteVkoinOut({ usdtSats: v, provider: p });
      return { koinOut: koin.toString(), koinOutMin: ethSwap.applySlippage(koin, S.slippageBps).toString() };
    }],
  ]) {
    if (BigInt(sats) <= 0n) continue;
    const amt = BigInt(sats) > cap ? cap : BigInt(sats);
    try {
      const q = await quoteFn(amt);
      out[asset] = { amountSats: amt.toString(), koinOut: q.koinOut, koinOutMin: q.koinOutMin, route: "C" };
    } catch (e) { out[asset] = { amountSats: amt.toString(), koinOut: null, error: String(e.message || e) }; }
  }
  return out;
}

/* ---------------- jobs ---------------- */

const job = (account) => S.store.jobs[account] || null;
function saveJob(account, j) {
  S.store.jobs[account] = j ? { ...j, updatedAt: Date.now() } : null;
  if (!j) delete S.store.jobs[account];
  persist();
}

function publicJob(j) {
  if (!j) return null;
  const { record, ...rest } = j;
  return { ...rest, recordAmount: record ? String(record.amount) : undefined };
}

/** One-click start: swap the account's whole (capped) balance of `asset`. */
async function start(account, { asset } = {}) {
  const cur = job(account);
  if (cur && !TERMINAL.has(cur.status)) throw new Error("A swap is already in progress");
  const t = transitFor(account);
  if (!t) throw new Error("Funding is not enabled for this account");
  if (!["eth", "usdc", "usdt"].includes(asset)) throw new Error("asset must be eth, usdc or usdt");

  if (S.demo) return demoStart(account, asset);

  const p = await ethProvider();
  if (await bridgePaused(p, S.network)) throw new Error("The Vortex bridge is currently paused");
  const bal = await balances(account);
  BAL_CACHE.delete(account);
  const common = {
    asset, slippageBps: S.slippageBps, koinosRecipient: account,
    ethFrom: t.ethAddress, pendingTx: null, startedAt: Date.now(), taps: 0,
  };

  if (asset === "eth") {
    const gasReserve = ethers.parseEther(S.gasMinEth) * 2n;
    let amtWei = BigInt(bal.ethWei) > gasReserve ? BigInt(bal.ethWei) - gasReserve : 0n;
    const capWei = ethers.parseEther(S.maxEth);
    if (amtWei > capWei) amtWei = capWei;
    if (amtWei <= 0n) throw new Error(`Deposit at least ${S.gasMinEth} ETH more — the balance must cover the swap plus gas`);
    /* Route it: quote both, take the better. */
    const q = await quotes(account);
    const best = q.eth && q.eth.best;
    if (!best) throw new Error("No route can be quoted right now — try again in a minute");
    const route = best.id;
    if (route === "C") {
      const usdtBefore = (await swap.balanceOf(p, RC.USDT, t.ethAddress)).toString();
      saveJob(account, {
        ...common, route, status: "swap_eth_usdt",
        amountEth: ethers.formatEther(amtWei), amountWei: amtWei.toString(),
        usdtBefore, estKoinOut: best.koinOut,
      });
    } else {
      saveJob(account, {
        ...common, route, status: "deposit_eth",
        amountEth: ethers.formatEther(amtWei), amountWei: amtWei.toString(),
        estKoinOut: best.koinOut,
      });
    }
    return publicJob(job(account));
  }

  /* Stables — Route C tail. Gas must exist (or be frontable). */
  const sats = BigInt(asset === "usdc" ? bal.usdcSats : bal.usdtSats);
  const cap = asset === "usdc" ? U.parseUsdc(S.maxStable) : U.parseUsdt(S.maxStable);
  const amt = sats > cap ? cap : sats;
  if (amt <= 0n) throw new Error(`No ${asset.toUpperCase()} at the deposit address yet`);
  const needGas = ethers.parseEther(S.gasMinEth);
  const haveGas = BigInt(bal.ethWei);
  let status = asset === "usdc" ? "approve_v3_usdc" : "approve_permit2";
  if (haveGas < needGas) {
    if (!S.gasSponsorKey) {
      throw new Error(`The deposit address needs ~${S.gasMinEth} ETH for Ethereum gas — send a little ETH along with your ${asset.toUpperCase()}`);
    }
    status = "front_gas";
  }
  const base = {
    ...common, route: "C", status,
    [asset + "Sats"]: amt.toString(),
    amountLabel: (asset === "usdc" ? U.formatUsdc(amt) : U.formatUsdt(amt)) + " " + asset.toUpperCase(),
    afterGas: status === "front_gas" ? (asset === "usdc" ? "approve_v3_usdc" : "approve_permit2") : undefined,
  };
  if (asset === "usdt") base.usdtSats = amt.toString();
  const est = await quotes(account).catch(() => null);
  if (est && est[asset] && est[asset].koinOut) base.estKoinOut = est[asset].koinOut;
  saveJob(account, base);
  return publicJob(job(account));
}

function resume(account) {
  const j = job(account);
  if (!j || j.status !== "error" || !j.failedAt) throw new Error("Nothing to resume");
  const back = j.failedAt === "awaiting_redeem" ? "awaiting_signatures" : j.failedAt;
  saveJob(account, { ...j, status: back, error: null, pendingTx: null, sigStartedAt: Date.now() });
  return publicJob(job(account));
}
function reset(account) {
  const j = job(account);
  if (j && !TERMINAL.has(j.status)) throw new Error("A swap is still in progress");
  saveJob(account, null);
  return { ok: true };
}

/* ---------------- the driver ---------------- */

async function tick() {
  for (const account of Object.keys(S.store.jobs)) {
    const j = job(account);
    if (!j || TERMINAL.has(j.status) || TAP_STATES.has(j.status)) continue;
    if (BUSY.has(account)) continue;
    BUSY.add(account);
    try {
      if (S.demo) await demoAdvance(account, j);
      else if (ETH_STATES.has(j.status)) await advanceEth(account, j);
      else if (j.status === "awaiting_signatures") await pollGuardians(account, j);
    } catch (e) {
      const msg = String(e.message || e);
      if (isTransient(msg)) { dropProvider(); }
      else saveJob(account, { ...job(account), status: "error", error: msg, failedAt: j.status });
    } finally {
      BUSY.delete(account);
    }
  }
}

const isTransient = (msg) =>
  /ECONN|ETIMEDOUT|EAI_AGAIN|timeout|network|missing response|fetch failed|socket|throttl|rate limit|\b(429|502|503|504)\b|SERVER_ERROR|could not detect|no ethereum rpc/i.test(String(msg));

async function receipt(hash) {
  const r = await (await ethProvider()).getTransactionReceipt(hash);
  if (!r) return null; // still mining
  if (r.status === 0) throw new Error(`Ethereum tx reverted (${String(hash).slice(0, 10)}…)`);
  return r;
}

async function advanceEth(account, j) {
  const wallet = await transitWallet(account);
  const p = wallet.provider;
  if (j.pendingTx) {
    const r = await receipt(j.pendingTx);
    if (!r) return;
    return onEthConfirmed(account, j);
  }
  const now = Math.floor(Date.now() / 1000);
  switch (j.status) {
    case "front_gas": {
      const sponsor = new ethers.Wallet(S.gasSponsorKey, p);
      const sent = await sponsor.sendTransaction({ to: j.ethFrom, value: ethers.parseEther(S.gasTopupEth) });
      return saveJob(account, { ...j, pendingTx: sent.hash });
    }
    case "approve_v3_usdc": {
      const cur = await swap.allowance(p, RC.USDC, wallet.address, RC.V3_SWAP_ROUTER);
      if (cur >= BigInt(j.usdcSats)) return saveJob(account, { ...j, status: "swap_usdc_usdt" });
      const tx = swap.buildApproveTx(RC.USDC, RC.V3_SWAP_ROUTER, BigInt(j.usdcSats));
      const { hash } = await swap.sendTx(wallet, tx);
      return saveJob(account, { ...j, pendingTx: hash });
    }
    case "swap_usdc_usdt": {
      const { fee, usdt } = await ethSwap.quoteUsdcOut({ usdcSats: j.usdcSats, provider: p });
      const minUsdtOut = ethSwap.applySlippage(usdt, j.slippageBps);
      const usdtBefore = (await swap.balanceOf(p, RC.USDT, wallet.address)).toString();
      const tx = swap.buildUsdcToUsdtTx({ recipient: wallet.address, usdcAmount: j.usdcSats, fee, minUsdtOut });
      const { hash } = await swap.sendTx(wallet, tx);
      return saveJob(account, { ...j, pendingTx: hash, usdtBefore });
    }
    case "swap_eth_usdt": {
      const { usdt, fee } = await ethSwap.quoteUsdtOut({ amountWei: j.amountWei, provider: p });
      const minUsdtOut = ethSwap.applySlippage(usdt, j.slippageBps);
      const tx = swap.buildEthToUsdtTx({ recipient: wallet.address, amountWei: j.amountWei, fee, minUsdtOut });
      const { hash } = await swap.sendTx(wallet, tx);
      return saveJob(account, { ...j, pendingTx: hash });
    }
    case "approve_permit2": {
      const cur = await swap.allowance(p, RC.USDT, wallet.address, RC.PERMIT2);
      if (cur >= BigInt(j.usdtSats)) return saveJob(account, { ...j, status: "approve_ur" });
      const tx = swap.buildApproveTx(RC.USDT, RC.PERMIT2, swap.MAX_UINT256);
      const { hash } = await swap.sendTx(wallet, tx);
      return saveJob(account, { ...j, pendingTx: hash });
    }
    case "approve_ur": {
      const a = await swap.permit2Allowance(p, wallet.address, RC.USDT, RC.UNIVERSAL_ROUTER);
      if (BigInt(a.amount) >= BigInt(j.usdtSats) && Number(a.expiration) > now + 60) {
        return saveJob(account, { ...j, status: "swap_usdt_vkoin" });
      }
      const tx = swap.buildPermit2ApproveTx({ token: RC.USDT, spender: RC.UNIVERSAL_ROUTER, amount: j.usdtSats, expiration: now + PERMIT2_EXPIRY_SEC });
      const { hash } = await swap.sendTx(wallet, tx);
      return saveJob(account, { ...j, pendingTx: hash });
    }
    case "swap_usdt_vkoin": {
      const vkoinExpected = await ethSwap.quoteVkoinOut({ usdtSats: j.usdtSats, provider: p });
      const minVkoinOut = ethSwap.applySlippage(vkoinExpected, j.slippageBps);
      const vkoinBefore = (await swap.balanceOf(p, RC.VKOIN, wallet.address)).toString();
      const tx = swap.buildUsdtToVkoinTx({ usdtAmount: j.usdtSats, minVkoinOut, deadline: now + SWAP_DEADLINE_SEC });
      const { hash } = await swap.sendTx(wallet, tx);
      return saveJob(account, { ...j, pendingTx: hash, minVkoinOut: minVkoinOut.toString(), vkoinBefore });
    }
    case "approve_bridge": {
      const bridgeAddr = require("./eth/bridge-constants").BRIDGE[S.network].ethBridge;
      const cur = await swap.allowance(p, RC.VKOIN, wallet.address, bridgeAddr);
      if (cur >= BigInt(j.vkoinSats)) return saveJob(account, { ...j, status: "bridge_token" });
      const tx = swap.buildApproveTx(RC.VKOIN, bridgeAddr, BigInt(j.vkoinSats));
      const { hash } = await swap.sendTx(wallet, tx);
      return saveJob(account, { ...j, pendingTx: hash });
    }
    case "bridge_token": {
      const tx = buildTransferTokensTx({ token: RC.VKOIN, amountSats: j.vkoinSats, koinosRecipient: j.koinosRecipient, network: S.network });
      const { hash } = await swap.sendTx(wallet, tx);
      return saveJob(account, { ...j, pendingTx: hash });
    }
    case "deposit_eth": { // Route B
      const dep = await ethBridge.sendDeposit({
        ethPrivHex: transitFor(account).ethPriv, amountEth: j.amountEth,
        koinosRecipient: j.koinosRecipient, network: S.network, provider: p, maxEth: S.maxEth,
      });
      return saveJob(account, { ...j, status: "awaiting_signatures", ethTxHash: dep.hash, sigStartedAt: Date.now() });
    }
  }
}

async function onEthConfirmed(account, j) {
  const wallet = await transitWallet(account);
  const p = wallet.provider;
  const confirmedHash = j.pendingTx;
  const base = { ...j, pendingTx: null };
  switch (j.status) {
    case "front_gas":
      return saveJob(account, { ...base, status: j.afterGas, afterGas: undefined });
    case "approve_v3_usdc":
      return saveJob(account, { ...base, status: "swap_usdc_usdt" });
    case "swap_usdc_usdt": {
      const usdtNow = await swap.balanceOf(p, RC.USDT, wallet.address);
      const usdtSats = (usdtNow - BigInt(j.usdtBefore)).toString();
      if (BigInt(usdtSats) <= 0n) throw new Error("USDC→USDT swap produced no USDT");
      return saveJob(account, { ...base, status: "approve_permit2", usdtSats });
    }
    case "swap_eth_usdt": {
      const usdtNow = await swap.balanceOf(p, RC.USDT, wallet.address);
      const usdtSats = (usdtNow - BigInt(j.usdtBefore)).toString();
      if (BigInt(usdtSats) <= 0n) throw new Error("ETH→USDT swap produced no USDT");
      return saveJob(account, { ...base, status: "approve_permit2", usdtSats });
    }
    case "approve_permit2":
      return saveJob(account, { ...base, status: "approve_ur" });
    case "approve_ur":
      return saveJob(account, { ...base, status: "swap_usdt_vkoin" });
    case "swap_usdt_vkoin": {
      const vkoinNow = await swap.balanceOf(p, RC.VKOIN, wallet.address);
      const vkoinSats = (vkoinNow - BigInt(j.vkoinBefore)).toString();
      if (BigInt(vkoinSats) <= 0n) throw new Error("USDT→vKOIN swap produced no vKOIN");
      return saveJob(account, { ...base, status: "approve_bridge", vkoinSats });
    }
    case "approve_bridge":
      return saveJob(account, { ...base, status: "bridge_token" });
    case "bridge_token":
      return saveJob(account, { ...base, status: "awaiting_signatures", ethTxHash: confirmedHash, sigStartedAt: Date.now() });
  }
}

async function pollGuardians(account, j) {
  const record = await fetchEthDepositRecord(j.ethTxHash, { network: S.network });
  if (!record) {
    if (Date.now() - (j.sigStartedAt || j.startedAt || 0) > POLL_TIMEOUT_MS) {
      saveJob(account, { ...j, status: "error", error: "Guardians didn't sign in time. Your deposit is bridged — Retry resumes it.", failedAt: "awaiting_signatures" });
    }
    return;
  }
  const n = Array.isArray(record.validators) && record.validators.length ? record.validators.length : 3;
  if (isRedeemable(record, n)) {
    saveJob(account, { ...j, status: "awaiting_redeem", record });
  } else if (record.expiration && Number(record.expiration) <= Date.now()) {
    await ethBridge.requestNewSignatures({ ethPrivHex: transitFor(account).ethPriv, ethTxHash: j.ethTxHash, network: S.network, provider: await ethProvider() });
    saveJob(account, { ...j, status: "awaiting_signatures", sigStartedAt: Date.now() });
  }
}

/* ---------------- the passkey steps ---------------- */

/** Operations for the step the job is waiting on — the server prepares,
    the PASSKEY authorizes, the chain verifies. */
async function prepareTapOps(account) {
  const j = job(account);
  if (!j) throw new Error("No swap in progress");
  if (j.status === "awaiting_redeem") {
    if (S.demo) return { step: "redeem", ops: null, rcLimit: DEFAULT_REDEEM_RC };
    const ops = [await opCompleteTransfer({ record: j.record, network: S.network, provider: chain.provider() })];
    return { step: "redeem", ops, rcLimit: DEFAULT_REDEEM_RC };
  }
  if (j.status === "awaiting_swap") {
    if (S.demo) return { step: "koindx", ops: null, rcLimit: koindx.DEFAULT_SWAP_RC };
    const q = await koindx.quoteSwap({ amountInSats: j.vethSats, slippageBps: j.slippageBps, network: S.network, provider: chain.provider() });
    const ops = await koindx.opsKoindxSwap({ account, amountInSats: j.vethSats, amountOutMin: q.amountOutMin, network: S.network, provider: chain.provider() });
    return { step: "koindx", ops, rcLimit: koindx.DEFAULT_SWAP_RC, estKoinOut: q.amountOut };
  }
  throw new Error("This swap isn't waiting on your passkey right now");
}

/** Called by the submit path after the passkey-signed step is mined. */
function onTapDone(account, step, txid) {
  const j = job(account);
  if (!j) return;
  if (step === "redeem") {
    if (j.route === "B") {
      /* Redeem minted vETH to the smart account — one more tap swaps it. */
      saveJob(account, { ...j, status: "awaiting_swap", redeemId: txid, vethSats: String(j.record ? j.record.amount : j.vethSats), taps: (j.taps || 0) + 1 });
    } else {
      saveJob(account, { ...j, status: "done", redeemId: txid, koinReceived: String(j.record ? j.record.amount : j.estKoinOut), finishedAt: Date.now(), taps: (j.taps || 0) + 1 });
    }
  } else if (step === "koindx") {
    saveJob(account, { ...j, status: "done", swapId: txid, koinReceived: j.estKoinOut || j.koinReceived, finishedAt: Date.now(), taps: (j.taps || 0) + 1 });
  }
}

/* ---------------- demo simulation ----------------
   The full pipeline with fake balances and instant "chains", so the whole
   UI — including the passkey landing tap — runs anywhere. */

const DEMO_RATE_ETH_KOIN = 4200; // via route C
const DEMO_RATE_ETH_KOIN_B = 1600; // via the shallow KoinDX pool
const DEMO_RATE_USD_KOIN = 1.85;

function demoBalances(account) {
  const t = S.store.transit[account];
  t.demoBal ||= { eth: "0.012", usdc: "18.5", usdt: "0" };
  const b = t.demoBal;
  return {
    eth: b.eth, ethWei: ethers.parseEther(b.eth).toString(),
    usdc: b.usdc, usdcSats: U.parseUsdc(b.usdc).toString(),
    usdt: b.usdt, usdtSats: U.parseUsdt(b.usdt).toString(),
    vkoin: "0", vkoinSats: "0",
  };
}
function demoQuotes(bal) {
  const out = {};
  const sats = (n) => BigInt(Math.round(n * 1e8)).toString();
  if (Number(bal.eth) > 0) {
    const amt = Number(bal.eth) - 0.002;
    out.eth = {
      amount: String(amt.toFixed(6)),
      ...routes.compareRoutes([
        { ...routes.descriptor("C"), koinOut: sats(amt * DEMO_RATE_ETH_KOIN) },
        { ...routes.descriptor("B"), koinOut: sats(amt * DEMO_RATE_ETH_KOIN_B) },
      ]),
    };
  }
  for (const asset of ["usdc", "usdt"]) {
    if (Number(bal[asset]) > 0) {
      out[asset] = { amountSats: bal[asset + "Sats"], koinOut: sats(Number(bal[asset]) * DEMO_RATE_USD_KOIN), route: "C" };
    }
  }
  return out;
}
function demoStart(account, asset) {
  const bal = demoBalances(account);
  if (Number(bal[asset]) <= 0) throw new Error(`No ${asset.toUpperCase()} at the deposit address yet`);
  const q = demoQuotes(bal);
  const route = asset === "eth" ? q.eth.best.id : "C";
  const first = asset === "eth"
    ? (route === "C" ? "swap_eth_usdt" : "deposit_eth")
    : (asset === "usdc" ? "approve_v3_usdc" : "approve_permit2");
  saveJob(account, {
    asset, route, status: first, demo: true, koinosRecipient: account,
    ethFrom: S.store.transit[account].ethAddress,
    amountLabel: bal[asset] + " " + asset.toUpperCase(),
    estKoinOut: asset === "eth" ? q.eth.best.koinOut : q[asset].koinOut,
    startedAt: Date.now(), demoTicks: 0, taps: 0,
  });
  return publicJob(job(account));
}
const DEMO_FLOW_C = ["approve_v3_usdc", "swap_usdc_usdt", "swap_eth_usdt", "approve_permit2", "approve_ur", "swap_usdt_vkoin", "approve_bridge", "bridge_token", "awaiting_signatures", "awaiting_redeem"];
const DEMO_FLOW_B = ["deposit_eth", "awaiting_signatures", "awaiting_redeem"];
async function demoAdvance(account, j) {
  const flow = j.route === "B" ? DEMO_FLOW_B : DEMO_FLOW_C;
  const at = flow.indexOf(j.status);
  if (at < 0) return;
  let next = flow[at + 1];
  while (next === "approve_v3_usdc" && j.asset !== "usdc") next = flow[flow.indexOf(next) + 1];
  if (j.asset !== "usdc" && next === "swap_usdc_usdt") next = j.asset === "eth" ? "swap_eth_usdt" : "approve_permit2";
  if (j.asset !== "eth" && next === "swap_eth_usdt") next = "approve_permit2";
  if (!next) return;
  const upd = { ...j, status: next, demoTicks: 0 };
  if (next === "awaiting_redeem") {
    upd.record = { amount: j.estKoinOut, id: "0xdemo", recipient: account, koinosToken: "demo", signatures: ["a", "b"], expiration: String(Date.now() + 3600000) };
    if (j.route === "B") upd.vethSats = j.estKoinOut;
    const t = S.store.transit[account];
    t.demoBal = { eth: j.asset === "eth" ? "0" : t.demoBal.eth, usdc: j.asset === "usdc" ? "0" : t.demoBal.usdc, usdt: j.asset === "usdt" ? "0" : t.demoBal.usdt };
  }
  saveJob(account, upd);
}

/* ---------------- public status ---------------- */

async function status(account) {
  const t = transitFor(account);
  if (!t) return { enabled: false };
  const j = job(account);
  const out = { enabled: true, ethAddress: t.ethAddress, job: publicJob(j) };
  /* Balances + quotes only while nothing is actively moving (they're for
     the "what would I get" view; an active job shows its own numbers). */
  if (!j || TERMINAL.has(j.status)) {
    try {
      out.balances = await balances(account);
      out.quotes = await quotes(account);
    } catch (e) { out.balancesError = String(e.message || e).slice(0, 160); }
  }
  return out;
}

module.exports = {
  configure, enable, status, start, resume, reset,
  prepareTapOps, onTapDone, transitFor, job, publicJob,
};
