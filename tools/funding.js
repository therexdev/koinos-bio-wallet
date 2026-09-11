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
     Route S: SOL → vKOIN on Solana (Jupiter) → Wormhole → Ethereum → Vortex → KOIN
     Route T: SOL → wETH on Solana (Jupiter) → Wormhole → native ETH on
              Ethereum → Route C's tail → Vortex → KOIN
     A second, Solana transit address takes SOL. Vortex has no Solana side and
     the vKOIN trading there is Wormhole-wrapped Vortex Koin, so either way the
     money rides Wormhole to the Ethereum transit address and finishes through
     Vortex (tools/sol/).

     Route T exists because a Solana deposit must pay for Ethereum. It buys
     wETH instead of vKOIN, and Wormhole's completeTransferAndUnwrapETH hands
     the transit address NATIVE ether — so the deposit funds its own Ethereum
     legs, and it buys vKOIN from the deep Uniswap pool rather than the small
     Solana one. Both routes are quoted and the better one wins.

     The one transaction nobody can pay for out of the deposit is the redeem
     itself, which must happen before that ether exists. A VAA names its
     recipient, so ANYONE may submit it: the sponsor does, for one transaction
     per job, and the money still lands at the transit address.

   The server drives the Ethereum legs with the transit key, then tries to
   complete the bridge redeem itself: the recipient is fixed inside the
   guardian-signed record, so that transaction can only ever deliver to the
   user's own account — the sponsor merely pays for it. If the chain says it
   wants the recipient's signature anyway, the job falls back to a passkey
   tap; we don't guess which, the chain answers. Route B's final KoinDX swap
   always needs the passkey: it SPENDS vETH from the account. Custody is
   transit-only — funds are server-held exactly while they cross, and land on
   an account only the passkey can spend from.

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
const fees = require("./eth/fees");
const gasAccounting = require("./eth/gas-accounting");
const fundingV2 = require("./eth/funding-v2");
/* Route S. Its packages are optional at boot: without them the wallet runs
   exactly as before and the rail reports itself off (see solRail). */
const SC = require("./sol/sol-constants");
const SU = require("./sol/units");
const jup = require("./sol/jupiter");
/* Making and showing the Solana deposit address needs no Solana packages at
   all — see tools/sol/keys.js. Only converting what lands there does, which
   is why this one is a plain require and the two below are not. */
const solKeys = require("./sol/keys");
/* Reading what is AT the deposit address is one HTTP request, so it does not
   go through the Solana packages either — a person must be able to see their
   own money whether or not this host can convert it. */
const solLite = require("./sol/rpc-lite");
/* No optional packages any more: the Solana side is plain JSON-RPC and Node's
   own crypto (tools/sol/*-lite.js), so the rail cannot be switched off by an
   install that skipped something. The guard stays only for the impossible
   case, so a broken file degrades instead of taking the wallet down. */
let sol = null, wormhole = null, SOL_LOAD_ERROR = null;
try { sol = require("./sol/sol-rpc"); wormhole = require("./sol/wormhole"); }
catch (e) { SOL_LOAD_ERROR = String(e.message || e).split("\n")[0]; }
const probeSdk = () => Promise.resolve(!!(sol && wormhole));

const S = {
  dataDir: path.join(__dirname, "..", "data"),
  demo: false,
  network: "mainnet",
  maxEth: process.env.FUND_MAX_ETH || "0.1",
  maxStable: process.env.FUND_MAX_STABLE || "150",
  slippageBps: parseInt(process.env.FUND_SLIPPAGE_BPS || "150", 10),
  gasSponsorKey: (process.env.ETH_GAS_SPONSOR_KEY || "").trim(),
  gasTopupEth: process.env.ETH_GAS_TOPUP || "0.0015",
  gasMinEth: process.env.ETH_GAS_MIN || "0.0012",
  /* What the platform charges, and where token-denominated fees accrue. */
  fee: fees.config(),
  gasPolicy: gasAccounting.config(),
  /* Route S */
  maxSol: process.env.FUND_MAX_SOL || "1",
  /* Ethereum gas sets the real floor for a Solana deposit — below this the
     fees eat the conversion, and the live quote refuses it anyway. */
  minSol: process.env.FUND_MIN_SOL || "0.05",
  solReserve: process.env.SOL_RESERVE || "0.01",
  solRpcUrls: null, // null → SOLANA_RPC, then the public list
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
  "wh_redeem", // Routes S and T: take delivery of what Wormhole holds
  "collect_fee", // the conversion fee, in whatever this route is holding
  "gas_approve_reset", "gas_approve", "gas_buy_eth", "approve_permit2_reset", "request_signatures",
]);
/* States the server drives with the Solana transit key (Routes S and T). */
const SOL_STATES = new Set(["sol_swap", "sol_bridge", "awaiting_vaa"]);
/* The Solana-funded routes, and which token each one buys on the way. */
const SOL_ROUTES = new Set(["S", "T"]);
const railMint = (j) => (j.route === "T" ? SC.WETH_SOL_MINT : SC.VKOIN_SOL_MINT);
const railToken = (j) => (j.route === "T" ? SC.WETH_ETH : SC.VKOIN_ETH);
/* Everything a Solana job does before its money is ether or vKOIN on Ethereum. */
const isSolPhase = (j) => SOL_ROUTES.has(j.route)
  && (SOL_STATES.has(j.status) || j.status === "wh_redeem"
      || SOL_STATES.has(j.failedAt) || j.failedAt === "wh_redeem");
/* Does this job need the user's passkey right now?

   Route B's KoinDX swap always does: it SPENDS vETH from the account, so
   the account must authorize it.

   The bridge redeem is the interesting one. It only MINTS to the recipient
   named in the guardian-signed record, and the bridge carries relayer and
   payment fields precisely so a third party can submit it — which reads
   like nobody's authority but the guardians' is involved. We do not get to
   assume that: whether the deployed contract also demands the recipient's
   authority is a fact about a contract we cannot read from here. So the
   sponsor TRIES first, and if the chain answers "not authorized" the job
   sets `needsTap` and the passkey finishes it (see autoRedeem). Correct
   either way, and the chain — not a guess — decides which. */
function waitsForTap(j) {
  return j.status === "awaiting_swap"
    || (j.status === "awaiting_redeem" && !!j.needsTap);
}

const file = () => path.join(S.dataDir, "funding.json");
const BUSY = new Set();
let _timer = null, _ethProvider = null, _solConn = null;
const STARTING = new Set();
const ownedLocks = new Set();
function lockDataDirectory() {
  if (S.demo) return;
  const lock = path.join(S.dataDir, "funding-worker.lock");
  if (ownedLocks.has(lock)) return;
  try {
    const fd = fs.openSync(lock, "wx", 0o600);
    try { fs.writeFileSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
    ownedLocks.add(lock);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const stat = fs.statSync(lock);
    const pid = Number(fs.readFileSync(lock, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("The funding worker lock needs operator inspection");
    let alive = true;
    try { process.kill(pid, 0); } catch (err) { if (err.code === "ESRCH") alive = false; }
    if (alive) throw new Error("Another funding worker owns this data directory; run only one wallet process per data directory");
    if (fs.statSync(lock).ino !== stat.ino) throw new Error("The funding worker lock changed; retry startup");
    fs.unlinkSync(lock);
    lockDataDirectory();
  }
}
process.once("exit", () => {
  for (const lock of ownedLocks) {
    try { if (fs.readFileSync(lock, "utf8") === String(process.pid)) fs.unlinkSync(lock); } catch (_) {}
  }
});
const v2 = fundingV2.create({ settings: S, provider: ethProvider, transit: (account) => transitFor(account),
  job: (account) => job(account), save: saveJob, koinosProvider: () => chain.provider(), relayer: relayerAddress,
  records: () => {
    const byId = new Map();
    for (const j of [...Object.values(S.store.history || {}), ...Object.values(S.store.jobs || {})]) {
      if (j && j.id) byId.set(j.id, j);
    }
    return [...byId.values()];
  },
});

function configure(opts) {
  Object.assign(S, opts || {});
  fs.mkdirSync(S.dataDir, { recursive: true, mode: 0o700 });
  lockDataDirectory();
  try {
    S.store = JSON.parse(fs.readFileSync(file(), "utf8"));
    S.store.transit ||= {}; S.store.jobs ||= {}; S.store.history ||= {};
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error("The funding ledger could not be read; refusing to replace it with an empty ledger");
    S.store = { transit: {}, jobs: {}, history: {} };
  }
  if (!S.demo) repairSimulatedJobs();
  probeSdk().catch(() => {});
  if (!_timer) {
    _timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
    if (_timer.unref) _timer.unref();
  }
}

/* Ids the simulator writes. A REAL job carrying one was walked forward by
   the demo flow while the server was in demo mode, so its "done" is a
   fiction and the transfer is still sitting in the bridge. */
const SIMULATED_ID = /^0xdemo/;

/** Undo a simulated finish on a real job.

    The Koinos side of a bridge transfer is idempotent and permanent: the
    guardian-signed record stays claimable until someone actually claims it.
    So the repair is simply to stop believing the fiction and go re-read the
    record — pollGuardians fetches it afresh and the job lands for real. */
function repairSimulatedJobs() {
  let repaired = 0;
  for (const account of Object.keys(S.store.jobs || {})) {
    const j = S.store.jobs[account];
    if (!j || j.demo) continue;
    const faked = SIMULATED_ID.test(String(j.redeemId || "")) || SIMULATED_ID.test(String(j.swapId || ""));
    if (!faked) continue;
    const back = j.ethTxHash
      ? { status: "awaiting_signatures", sigStartedAt: Date.now() }
      /* Nothing bridged yet: let Retry work it out from real balances. */
      : { status: "error", failedAt: SOL_ROUTES.has(j.route) ? "sol_swap" : "awaiting_signatures" };
    S.store.jobs[account] = {
      ...j, ...back,
      redeemId: null, swapId: null, koinReceived: null, finishedAt: null,
      demoTicks: 0, redeemAttempts: 0, needsTap: false,
      error: "the server was in demo mode and marked this swap complete without landing it — resuming for real",
      repairedAt: Date.now(),
    };
    repaired += 1;
  }
  if (repaired) {
    persist();
    console.log(`funding:  repaired ${repaired} job(s) a demo-mode server had marked complete`);
  }
}

function persist() {
  const tmp = file() + ".tmp";
  const fd = fs.openSync(tmp, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(S.store, null, 1)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file());
  const directory = fs.openSync(S.dataDir, "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
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
  /* The Solana transit key — added lazily, so accounts from before the
     Solana rail get one the first time they are looked at. Deliberately NOT
     conditional on the Solana packages: an address a person can send SOL to
     is not the same thing as the machinery that converts it, and gating the
     address on that machinery is how the whole feature disappears on a host
     where one optional package did not install. */
  if (!t.solAddress) {
    Object.assign(t, solKeys.newKeypair(), { solTs: Date.now() });
    persist();
  }
  return { ethAddress: t.ethAddress, solAddress: t.solAddress || null };
}
const transitFor = (account) => S.store.transit[account] || null;

async function ethProvider() {
  if (!_ethProvider) _ethProvider = await makeProvider();
  return _ethProvider;
}
function dropProvider() { _ethProvider = null; _solConn = null; _feeData = { at: 0, p: null }; if (wormhole) wormhole.forget(); }

/** Is Route S usable on this server? */
function solRail() {
  if (!sol || !wormhole) {
    return { enabled: false, reason: "the Solana modules failed to load" + (SOL_LOAD_ERROR ? ` (${SOL_LOAD_ERROR})` : "") };
  }
  return { enabled: true };
}
const railOn = () => solRail().enabled;
/** SOL a deposit must reach before any of it can move: reserve + minimum. */
const solFloor = () => SU.formatSol(SU.parseSol(S.solReserve) + SU.parseSol(S.minSol));

/* The assets a deposit address can be converted from, in the order the card
   lists them. */
const FUNDABLE = ["eth", "usdc", "usdt", "sol"];

/** Wormhole normalises to 8 decimals, so one unit of wETH on Solana is
    1e10 wei of ether. */
const WEI_PER_WORMHOLE_UNIT = 10n ** 10n;
const wormholeUnitsToWei = (units) => BigInt(units) * WEI_PER_WORMHOLE_UNIT;

/** What this job has cost the sponsor so far, in wei — measured from real
    receipts, never estimated, because it is what the fee recovers. */
const sponsorSpent = (j) => BigInt(j.sponsorWei || 0);
const addSponsorSpend = (j, wei) => ({ ...j, sponsorWei: (sponsorSpent(j) + BigInt(wei)).toString() });
/** The gas a confirmed transaction actually burned. */
const gasSpent = (r) => BigInt(r.gasUsed || 0) * BigInt(r.gasPrice || r.effectiveGasPrice || 0);

/** Ether fees go back to the sponsor, because that is the float they refill.
    Token fees accrue wherever FUND_FEE_TREASURY points, or the sponsor. */
function feeRecipient() {
  if (S.gasSponsorKey) return new ethers.Wallet(S.gasSponsorKey).address;
  if (S.fee.treasury) return S.fee.treasury;
  return null;
}

/** Who submits the Wormhole redeem — the one step that has to be paid for
    before the deposit's own ether exists. The sponsor normally; a transit
    address already holding gas can pay for itself. Neither can redirect the
    money: the VAA names the recipient, which is why anyone may submit it. */
async function redeemerFor(account, route) {
  const wallet = await transitWallet(account);
  /* A sponsor key is not a sponsor. Trusting the key alone is how a deposit
     gets stranded: the quote succeeds, the SOL is swapped and handed to
     Wormhole, and only THEN does the redeem discover the float is empty —
     with the money already one-way into the bridge. So the float is asked
     whether it can actually pay for this route before the route is offered. */
  /* What this route will ask of whoever pays for it — not just the first
     transaction. Route S arrives holding vKOIN and no ether, so it owes the
     redeem AND the Vortex steps; route T owes only the redeem, because what
     it brings back pays for the rest. Checking just the redeem is how a job
     gets halfway and then stops for want of gas it never had. */
  const units = route === "S" ? WH_REDEEM_GAS_UNITS + VORTEX_TAIL_GAS_UNITS : WH_REDEEM_GAS_UNITS;
  const need = await gasCostWei(units);

  // Legacy jobs may finish with their own ETH. New sponsorship is admitted
  // only through the accepted v2 plan and its durable ETH recovery ledger.
  const own = await wallet.provider.getBalance(wallet.address);
  if (own >= need) return { wallet, sponsored: false, needWei: need.toString() };
  return null;
}

async function solConn() {
  if (!_solConn) _solConn = await sol.makeConnection(S.solRpcUrls || undefined);
  return _solConn;
}

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
  /* Route S balances ride along. A Solana read failing must not take the
     Ethereum numbers down with it: the card keeps those and says the
     Solana side is unavailable. */
  if (t.solAddress) {
    try {
      const [lam, vk, we] = await Promise.all([
        solLite.solBalance(t.solAddress),
        solLite.tokenBalance(SC.VKOIN_SOL_MINT, t.solAddress),
        solLite.tokenBalance(SC.WETH_SOL_MINT, t.solAddress),
      ]);
      out.sol = SU.formatSol(lam); out.solLamports = lam.toString();
      out.solVkoin = U.formatVkoin(vk); out.solVkoinSats = vk.toString();
      /* wETH on Solana is Wormhole-wrapped at 8 decimals: 1 unit = 1e10 wei. */
      out.solWethSats = we.toString();
      out.solWeth = ethers.formatEther(wormholeUnitsToWei(we));
    } catch (e) {
      const why = String(e.message || e).slice(0, 140);
      /* The public endpoint turns away datacenter traffic, which is where
         this runs. Say what to do about it rather than just the status code. */
      out.solError = /\b(403|429)\b|forbidden|too many/i.test(why) && !process.env.SOLANA_RPC
        ? `${why} — the public Solana endpoint refuses server traffic; set SOLANA_RPC to your own endpoint`
        : why;
    }
  }
  BAL_CACHE.set(account, { at: Date.now(), balances: out });
  return out;
}

/* Gas a route actually burns on Ethereum, in units, measured against the
   builders in tools/eth. Route C from an ETH deposit is the long one:
   swap ETH→USDT, approve Permit2, approve the router, swap USDT→vKOIN,
   approve the bridge, transfer to the bridge. */
// Includes fee transfer, a possible USDT allowance reset and one signature
// renewal; Max must leave enough ETH for the new accepted route budget.
const ROUTE_GAS_UNITS = 1016000n;

/** What to hold back for gas, priced from the CURRENT fee — not a fixed
    amount. A flat reserve is wrong in both directions: it strands a job
    when gas spikes, and when gas is cheap it quietly swallows most of a
    small deposit (a 0.0024 ETH reserve left 0.00006 of a 0.00246 balance
    spendable — 2% of the money, for gas that costs a fraction of that). */
/* Ethereum's fee is read once and reused for a few seconds. A single quote
   prices the gas reserve, the redeem, the Vortex tail and the fee transfer;
   asking the node five times for a number that moves once a block turned
   every quote into a stack of round trips.

   It is the in-flight PROMISE that is cached, not the number: those callers
   run concurrently, so caching only the settled value would let every one of
   them miss and fire anyway — the round trips it was meant to remove. A read
   that fails is forgotten rather than remembered as this block's fee. */
let _feeData = { at: 0, p: null };
async function feeData() {
  if (_feeData.p && Date.now() - _feeData.at < 10000) return _feeData.p;
  const pending = (async () => (await ethProvider()).getFeeData())();
  _feeData = { at: Date.now(), p: pending };
  pending.catch(() => { if (_feeData.p === pending) _feeData = { at: 0, p: null }; });
  return pending;
}

async function gasReserveWei() {
  const floor = ethers.parseEther(S.gasMinEth || "0") / 4n;
  try {
    const fee = await feeData();
    const perGas = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
    if (perGas > 0n) {
      const gas = ROUTE_GAS_UNITS + gasAccounting.bps(ROUTE_GAS_UNITS, S.gasPolicy.gasHeadroomBps);
      const price = perGas + gasAccounting.bps(perGas, S.gasPolicy.priceHeadroomBps);
      const est = gas * price;
      return est > floor ? est : floor;
    }
  } catch (_) { /* fee read failed — fall back to the configured floor */ }
  return ethers.parseEther(S.gasMinEth || "0.0012") * 2n;
}

/* What each Solana route burns on Ethereum, in gas units. Route T pays its
   own out of the ether it brings; route S has no ether, so the platform pays
   every one of these. Both are charged against the quote, so the router can
   never prefer a route merely because someone else is paying for it. */
const WH_REDEEM_GAS_UNITS = 150000n;                  // completeTransfer(AndUnwrapETH)
const VORTEX_TAIL_GAS_UNITS = 260000n;                // approve_bridge + bridge_token

/** Price a number of gas units at the current fee, with the same headroom
    the reserve uses. */
async function gasCostWei(units) {
  try {
    const fee = await feeData();
    const perGas = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
    if (perGas > 0n) return (perGas * BigInt(units) * 15n) / 10n;
  } catch (_) { /* fee read failed — fall back to the configured floor */ }
  return (ethers.parseEther(S.gasMinEth || "0.0012") * BigInt(units)) / 900000n;
}

/** How much of an asset a swap may actually spend right now: the balance,
    minus a live gas reserve for ETH, clamped to the safety cap. */
async function spendableOf(asset, bal) {
  if (asset === "eth") {
    const gasReserve = S.demo ? ethers.parseEther("0.0005") : await gasReserveWei();
    let wei = BigInt(bal.ethWei) > gasReserve ? BigInt(bal.ethWei) - gasReserve : 0n;
    const cap = ethers.parseEther(S.maxEth);
    if (wei > cap) wei = cap;
    return { sats: wei, label: ethers.formatEther(wei) };
  }
  if (asset === "sol") {
    if (!bal.solLamports) return { sats: 0n, label: "0" };
    /* The reserve pays Solana's fees and the rent of the accounts the swap
       and the bridge create; below the minimum those would eat the trade. */
    const have = BigInt(bal.solLamports), reserve = SU.parseSol(S.solReserve);
    let lam = have > reserve ? have - reserve : 0n;
    const cap = SU.parseSol(S.maxSol);
    if (lam > cap) lam = cap;
    if (lam < SU.parseSol(S.minSol)) lam = 0n;
    return { sats: lam, label: SU.formatSol(lam) };
  }
  const sats = BigInt(asset === "usdc" ? bal.usdcSats : bal.usdtSats);
  const cap = asset === "usdc" ? U.parseUsdc(S.maxStable) : U.parseUsdt(S.maxStable);
  const amt = sats > cap ? cap : sats;
  return { sats: amt, label: asset === "usdc" ? U.formatUsdc(amt) : U.formatUsdt(amt) };
}

function parseAmount(asset, amount) {
  const s = String(amount == null ? "" : amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Amount must be a positive number");
  const v = asset === "eth" ? ethers.parseEther(s) : asset === "usdc" ? U.parseUsdc(s) : asset === "sol" ? SU.parseSol(s) : U.parseUsdt(s);
  if (v <= 0n) throw new Error("Amount must be greater than 0");
  return v;
}

/** Route comparison for a SPECIFIC amount of one asset — the node app's
    "how much would I get, which way" view. */
async function quoteFor(account, asset, amount) {
  if (!FUNDABLE.includes(asset)) throw new Error("asset must be eth, usdc, usdt or sol");
  const bal = await balances(account);
  if (!bal) throw new Error("Funding is not enabled for this account");
  if (asset === "sol") {
    if (!railOn()) throw new Error(solRail().reason);
    if (bal.solError) throw new Error("Solana is unreachable right now — " + bal.solError);
  }
  const spendable = await spendableOf(asset, bal);
  const amt = parseAmount(asset, amount);
  if (amt > spendable.sats) {
    throw new Error(`Max right now is ${spendable.label} ${asset.toUpperCase()}` +
      (asset === "eth" ? " (after the gas reserve and the safety cap)"
        : asset === "sol" ? " (after the fee reserve and the safety cap)" : " (balance and safety cap)"));
  }
  if (asset === "sol" && amt < SU.parseSol(S.minSol)) throw new Error(`Minimum is ${S.minSol} SOL`);
  if (S.demo) return demoQuoteFor(asset, amt, spendable);

  return v2.quote(account, asset, amt);
}

const short = (s) => String(s).slice(0, 9);

/* What each asset's SPENDABLE balance would yield, per route — the card's
   initial view; the amount box re-quotes through quoteFor as it changes. */
async function quotes(account) {
  const bal = await balances(account);
  if (!bal) return null;
  /* Each asset's routes are priced from nothing but its own balance, so
     pricing them one after another only stacked their round trips: an
     address holding both ETH and SOL waited out the entire ETH quote before
     the first Solana question was asked. A quote that fails still reports
     its own reason and leaves the others alone. */
  const priced = await Promise.all(FUNDABLE.map(async (asset) => {
    const sp = await spendableOf(asset, bal);
    if (sp.sats <= 0n) return null;
    try { return [asset, await quoteFor(account, asset, sp.label)]; }
    catch (e) { return [asset, { asset, amount: sp.label, best: null, routes: [], error: String(e.message || e) }]; }
  }));
  return Object.fromEntries(priced.filter(Boolean));
}

/* ---------------- jobs ---------------- */

const job = (account) => S.store.jobs[account] || null;
function saveJob(account, j) {
  /* When the step last CHANGED, which is not the same as when the record was
     last written: a job retrying the same step every few seconds updates
     constantly while getting nowhere, and telling those apart is the whole
     point of `statusAt`. */
  const prev = S.store.jobs[account];
  S.store.history ||= {};
  if (prev && prev.id) S.store.history[prev.id] = { ...prev, account };
  const moved = !prev || prev.status !== (j && j.status);
  S.store.jobs[account] = j
    ? {
        ...j,
        updatedAt: Date.now(),
        statusAt: moved ? Date.now() : (prev.statusAt || Date.now()),
        /* A step that moved on is not still failing; carrying its last
           complaint forward would make the next stall lie about its cause. */
        ...(moved ? { lastError: undefined, transientCount: undefined } : {}),
      }
    : null;
  if (!j) delete S.store.jobs[account];
  if (S.store.jobs[account]?.id) S.store.history[S.store.jobs[account].id] = { ...S.store.jobs[account], account };
  persist();
}

/* How long a step may sit before the card stops saying "in progress" and
   starts saying "stuck". Generous, because some of these legitimately take
   minutes: Wormhole guardians sign in one or two, an Ethereum transaction
   can wait out a fee spike. Past this, something is wrong and saying so is
   better than a spinner that never ends. */
const STALL_MS = 12 * 60 * 1000;

/** A job that has not moved on in a long time, with the reason if we have
    one. Never a judgement about the money — only about progress. */
function stallOf(j) {
  if (!j || TERMINAL.has(j.status) || waitsForTap(j)) return null;
  const since = Date.now() - (j.statusAt || j.updatedAt || Date.now());
  if (since < STALL_MS) return null;
  return {
    minutes: Math.round(since / 60000),
    /* The last thing that went wrong, even though it was retried rather than
       failed — a swallowed error is exactly what makes a stall unreadable. */
    lastError: j.lastError || undefined,
    /* A transaction that was sent and never mined is its own diagnosis. */
    pendingTx: j.pendingTx || undefined,
  };
}

function publicJob(j) {
  if (!j) return null;
  const { record, vaa, pendingEth, confirmedEth, ethReceipts, feePlan, pendingSolRaw, ...rest } = j;
  return {
    ...rest,
    ...(feePlan ? { feeModel: feePlan.version, estimatedFeeEth: ethers.formatEther(feePlan.estimatedFeeWei),
      maximumFeeEth: ethers.formatEther(feePlan.maxFeeWei), sponsorDebtEth: ethers.formatEther(gasAccounting.costs(j).debt),
      actualEthereumGasEth: ethers.formatEther(Object.values(ethReceipts || {}).reduce((a, r) => a + BigInt(r.gasWei), 0n)) } : {}),
    recordAmount: record ? String(record.amount) : undefined,
    stalled: stallOf(j) || undefined,
  };
}

/** Start a swap of `amount` (default: everything spendable) of `asset`,
    through `route` for ETH ("B"|"C"; default: whichever quotes best). */
async function start(account, args = {}) {
  if (STARTING.has(account)) throw new Error("A conversion is already starting");
  STARTING.add(account);
  try { return await startUnlocked(account, args); }
  finally { STARTING.delete(account); }
}
async function startUnlocked(account, { asset, amount, route, quoteId } = {}) {
  const cur = job(account);
  if (cur && !TERMINAL.has(cur.status)) throw new Error("A swap is already in progress");
  const t = transitFor(account);
  if (!t) throw new Error("Funding is not enabled for this account");
  if (!["eth", "usdc", "usdt", "sol"].includes(asset)) throw new Error("asset must be eth, usdc, usdt or sol");
  if (asset === "sol" && !railOn()) throw new Error(solRail().reason);

  const bal = await balances(account);
  if (asset === "sol" && bal.solError) throw new Error("Solana is unreachable right now — " + bal.solError);
  const spendable = await spendableOf(asset, bal);
  if (spendable.sats <= 0n) {
    throw new Error(asset === "eth"
      ? `Deposit at least ${S.gasMinEth} ETH more — the balance must cover the swap plus gas`
      : asset === "sol"
        ? `Deposit at least ${solFloor()} SOL in total — the balance must cover the swap, Solana's fees and rent`
        : `No ${asset.toUpperCase()} at the deposit address yet`);
  }
  const amt = amount == null || String(amount).trim() === "" ? spendable.sats : parseAmount(asset, amount);
  if (amt > spendable.sats) {
    throw new Error(`Max right now is ${spendable.label} ${asset.toUpperCase()}`);
  }
  if (asset === "sol" && amt < SU.parseSol(S.minSol)) throw new Error(`Minimum is ${S.minSol} SOL`);

  if (S.demo) return demoStart(account, asset, amt, route);

  const p = await ethProvider();
  if (await bridgePaused(p, S.network)) throw new Error("The Vortex bridge is currently paused");
  BAL_CACHE.delete(account);
  return publicJob(await v2.start(account, { asset, amount: amt, route, quoteId }, bal));
}

/** Where is this job REALLY up to?

    A step name is only our record of what we believed; the tokens sitting at
    the transit address are what actually happened. When those disagree — a
    balance read that lagged its block, a reply we lost, a step that landed
    after we gave up on it — the chain wins. Retrying from the step name would
    then re-send a swap whose input is already spent, which is exactly how a
    stale read turns into a second, more confusing failure.

    Returns the corrected step, or null when the balances say nothing useful
    (then the recorded step is the best we have). */
async function reconcileRouteC(account, j) {
  /* Route T finishes through exactly these steps, so it reconciles here too
     once its ether has landed. */
  if ((j.route !== "C" && j.route !== "T") || j.ethTxHash) return null; // already bridged: nothing at the address
  const t = transitFor(account);
  if (!t) return null;
  const p = await ethProvider();
  const [vkoin, usdt, usdc] = await Promise.all([
    swap.balanceOf(p, RC.VKOIN, t.ethAddress),
    swap.balanceOf(p, RC.USDT, t.ethAddress),
    swap.balanceOf(p, RC.USDC, t.ethAddress),
  ]);
  /* vKOIN only ever exists here mid-flow, so all of it belongs to this job
     and all of it must bridge — leaving a remainder would strand it. */
  if (vkoin > 0n) return { status: "approve_bridge", vkoinSats: vkoin.toString() };
  /* USDT and USDC can also be a deposit the user made directly, so never
     sweep more than this job was started for. */
  if (usdt > 0n) {
    const want = j.usdtSats ? BigInt(j.usdtSats) : usdt;
    return { status: "approve_permit2", usdtSats: (usdt < want ? usdt : want).toString() };
  }
  if (j.asset === "usdc" && usdc > 0n) {
    const want = j.usdcSats ? BigInt(j.usdcSats) : usdc;
    return { status: "approve_v3_usdc", usdcSats: (usdc < want ? usdc : want).toString() };
  }
  return null;
}

/** Route S's version of the same question, asked from the end of the route
    backwards — the furthest place the money can be found is where it is:
    Ethereum, then the Wormhole record, then Solana. `probe` reads the
    chains; tests hand in a fake one. Every answer clears the pending
    transaction of the leg it moves away from. */
async function reconcileSol(account, j, probe) {
  if (!SOL_ROUTES.has(j.route) || j.ethTxHash) return null;
  const t = transitFor(account);
  if (!t || !t.solAddress) return null;
  const P = probe || liveProbeS(t, j);
  /* vKOIN on Ethereum: Wormhole delivered for route S. All of it bridges —
     it only ever exists there mid-flow. (Route T's delivery is ether, which
     the transit address may hold for other reasons, so that one is settled
     by the VAA below and by the wh_redeem step itself.) */
  if (j.route === "S") {
    const ethVkoin = await P.ethVkoin();
    if (ethVkoin > 0n) return { status: "approve_bridge", vkoinSats: ethVkoin.toString(), pendingTx: null, pendingSig: null };
  }
  /* A VAA in hand: wh_redeem is where it belongs, whether or not the bridge
     has honoured it — that step is idempotent and knows how to hand off. */
  if (j.vaa) return (await P.vaaRedeemed(j.vaaEvmHash)) && j.route === "S" ? null : { status: "wh_redeem", pendingTx: null };
  /* The message is posted: waiting on the guardians. */
  if (j.whSequence) return { status: "awaiting_vaa", pendingSig: null };
  if (j.solBridgeSig && (await P.sigConfirmed(j.solBridgeSig))) return { status: "awaiting_vaa", pendingSig: null };
  /* vKOIN still on Solana: the bridge step is what is left. */
  const solToken = await P.solToken();
  if (solToken > 0n) return { status: "sol_bridge", solTokenSats: solToken.toString(), pendingSig: null };
  /* No vKOIN anywhere after a bridge attempt: the reply may have been lost
     after the send, but the posted message is on the chain. */
  if (j.status === "sol_bridge" || j.failedAt === "sol_bridge" || j.solBridgeSig) {
    const found = await P.recentTransfer();
    if (found) {
      return { status: "awaiting_vaa", solBridgeSig: found.txid, whEmitter: found.emitter, whSequence: found.sequence, pendingSig: null, vaaStartedAt: Date.now() };
    }
  }
  /* Nothing moved and the swap is still the outstanding step (it never
     confirmed): a send whose confirmation was lost is dropped here and
     re-checked against the vKOIN balance there. A job already past its
     swap is never sent back to it — that would swap the deposit twice. */
  const swapOutstanding = !j.solSwapSig && (j.status === "sol_swap" || j.failedAt === "sol_swap");
  if (swapOutstanding && j.pendingSig && !(await P.sigConfirmed(j.pendingSig))) return { status: "sol_swap", pendingSig: null, pendingSigExpiry: null };
  return null;
}
function liveProbeS(t, j) {
  return {
    ethVkoin: async () => swap.balanceOf(await ethProvider(), RC.VKOIN, t.ethAddress),
    vaaRedeemed: async (evmHash) => wormhole.isRedeemedOnEthereum(await ethProvider(), evmHash),
    sigConfirmed: async (sig) => { const st = await sol.signatureStatus(await solConn(), sig); return !!(st && st.confirmed); },
    solToken: async () => sol.tokenBalance(await solConn(), railMint(j), t.solAddress),
    /* Only transfers newer than this job's swap can be this job's. */
    recentTransfer: async () => wormhole.findRecentTransfer({
      rpcUrl: (await solConn()).rpcEndpoint, address: t.solAddress,
      stopAt: j.solSwapSig || null, since: j.startedAt ? Math.floor(j.startedAt / 1000) - 300 : null,
    }),
  };
}
const reconcile = (account, j) => (isSolPhase(j) ? reconcileSol(account, j) : reconcileRouteC(account, j));

/* Steps that ask the chain whether the work is already done before they do
   it. Re-entering one of these can waste gas but can never do it twice, so
   Retry may clear a transaction still in the mempool for them. Anything not
   on this list is assumed to be a real spend. */
const IDEMPOTENT_STEPS = new Set(["wh_redeem", "awaiting_redeem", "bridge_token"]);

async function resume(account) {
  const j = job(account);
  if (j?.feePlan?.version === 2) return publicJob(await v2.resume(account));
  /* Retry is for a job that has failed OR one that has stopped moving. The
     second case is the one that matters: a step looping on a transient
     error, or waiting on a transaction that will never be mined, never
     reaches "error" — and refusing to resume it was how a conversion sat in
     the bridge with a Retry button that answered "Nothing to resume". */
  const stalled = j ? stallOf(j) : null;
  if (!j || (j.status !== "error" && !stalled)) throw new Error("Nothing to resume");
  const from = j.status === "error" ? j.failedAt : j.status;
  if (!from) throw new Error("Nothing to resume");

  /* A failed job's transaction is finished with. A STALLED one's may still
     be alive, and re-running a step whose spend is in flight would send it
     twice — so ask the chain before dropping it. */
  let keepPending = false;
  if (j.status !== "error" && j.pendingTx && !S.demo) {
    try {
      const p = await ethProvider();
      const [rcpt, tx] = await Promise.all([
        p.getTransactionReceipt(j.pendingTx),
        p.getTransaction(j.pendingTx),
      ]);
      /* Mined after all: leave it alone, the next tick reads the receipt. */
      if (rcpt) keepPending = true;
      /* Still in the mempool. Only a step that checks the chain before it
         spends may be re-entered around it. */
      else if (tx && !IDEMPOTENT_STEPS.has(from)) {
        throw new Error(`That transaction is still waiting to be mined (${String(j.pendingTx).slice(0, 10)}…). Re-sending this step now could spend twice, so it has to be left alone until the network takes it or drops it.`);
      }
      /* Neither: dropped from the mempool, and safe to send again. */
    } catch (e) {
      /* The refusal above is a decision, not a read failure — let it out. */
      if (/still waiting to be mined/.test(String(e.message))) throw e;
      /* A read failure is not permission to re-send a live transaction. */
      keepPending = true;
    }
  }

  let back = { status: from === "awaiting_redeem" ? "awaiting_signatures" : from };
  if (!S.demo) {
    try { back = (await reconcile(account, j)) || back; }
    catch (_) { /* can't read the chain right now — retry from the record */ }
  }
  /* Retry starts its leg clean: the counters back to zero, and the pending
     transaction dropped unless the checks above found it alive. */
  saveJob(account, {
    ...j, ...back, error: null, failedAt: null,
    ...(keepPending ? {} : { pendingTx: null }),
    pendingSig: null, pendingSigExpiry: null,
    lastError: undefined, transientCount: undefined,
    redeemAttempts: 0, resends: 0, gasFronts: 0, sigStartedAt: Date.now(), vaaStartedAt: Date.now(),
  });
  return publicJob(job(account));
}
function reset(account) {
  const j = job(account);
  if (j && !TERMINAL.has(j.status)) throw new Error("A swap is still in progress");
  if (j?.feePlan?.version === 2 && (j.pendingEth || j.confirmedEth || gasAccounting.costs(j).debt > 0n
      || (j.status !== "done" && (Object.keys(j.ethReceipts || {}).length || j.solSwapSig || j.pendingSig)))) {
    throw new Error("This conversion still has transactions or repayment to reconcile. Retry it instead of resetting its history.");
  }
  if (j?.feePlan?.version === 2) saveJob(account, { ...j, reservationReleased: true });
  if (j && !j.feePlan && sponsorSpent(j) > 0n && !j.feePaidWei && !j.feePaidUnits) {
    throw new Error("This older conversion has unreconciled gas funding; its history must be reviewed before it can be reset");
  }
  saveJob(account, null);
  return { ok: true };
}

/* ---------------- the driver ---------------- */

async function tick() {
  for (const account of Object.keys(S.store.jobs)) {
    const j = job(account);
    if (!j || TERMINAL.has(j.status) || waitsForTap(j)) continue;
    if (BUSY.has(account)) continue;
    BUSY.add(account);
    try {
      /* A job is simulated or it is real, and the two must never cross.
         Advancing a REAL job with the simulator marches it to "done" and
         writes a fake redeem id over a transfer that is still sitting in
         the bridge — the user is told their money landed when it has not.
         (That is not hypothetical: it happened on mainnet the first time a
         live server came back up without its sponsor key and fell into
         demo mode.) Running the reverse would spend real gas on invented
         balances. So each side only ever touches its own. */
      if (S.demo !== !!j.demo) continue;
      if (S.demo) await demoAdvance(account, j);
      else if (SOL_STATES.has(j.status)) await advanceSol(account, j);
      else if (ETH_STATES.has(j.status)) await advanceEth(account, j);
      else if (j.status === "awaiting_signatures") await pollGuardians(account, j);
      else if (j.status === "awaiting_redeem") await autoRedeem(account, j);
    } catch (e) {
      const msg = String(e.message || e);
      if (isTransient(msg)) {
        /* Retrying is right — these do pass. Retrying SILENTLY is not: a
           step that has failed this way a hundred times looks exactly like
           one still working, and the card has no way to say otherwise. So
           the reason is kept on the job even though the job carries on. */
        dropProvider();
        const cur = job(account);
        if (cur) saveJob(account, { ...cur, lastError: msg.slice(0, 160), transientCount: (cur.transientCount || 0) + 1 });
      } else await failOrRecover(account, j, msg);
    } finally {
      BUSY.delete(account);
    }
  }
}

/** A step failed. Before calling it an error, ask the chain where the money
    actually is: a step can fail on a read while its transaction succeeded, and
    parking that job at "error" invites a Retry that re-sends a swap whose
    input is already spent. If the balances name a different step, take it and
    carry on; the user never sees a failure that wasn't one. */
const MAX_RECOVERIES = 3;
async function failOrRecover(account, j, msg) {
  if (j.feePlan?.version === 2) {
    return saveJob(account, { ...job(account), status: "error", error: msg, failedAt: j.status });
  }
  if (!S.demo && (j.recoveries || 0) < MAX_RECOVERIES) {
    try {
      const at = await reconcile(account, j);
      /* Only a DIFFERENT step is progress. Re-entering the step that just
         failed — or bouncing between two of them — is a loop, not a
         recovery, so the counter ends it and the user sees the real error. */
      if (at && at.status !== j.status) {
        return saveJob(account, {
          ...job(account), ...at, error: null, pendingTx: null,
          recoveries: (j.recoveries || 0) + 1, recovered: msg.slice(0, 160),
        });
      }
    } catch (_) { /* can't read the chain — report the original failure */ }
  }
  saveJob(account, { ...job(account), status: "error", error: msg, failedAt: j.status });
}

const isTransient = (msg) =>
  /ECONN|ETIMEDOUT|EAI_AGAIN|timeout|network|missing response|fetch failed|socket|throttl|rate limit|\b(429|502|503|504)\b|SERVER_ERROR|could not detect|no ethereum rpc|no solana rpc|block height exceeded|blockhash not found|not confirmed in \d|node is behind|transaction was not confirmed/i.test(String(msg));

async function receipt(hash) {
  const r = await (await ethProvider()).getTransactionReceipt(hash);
  if (!r) return null; // still mining
  if (r.status === 0) throw new Error(`Ethereum tx reverted (${String(hash).slice(0, 10)}…)`);
  return r;
}

async function advanceEth(account, j) {
  if (j.feePlan?.version === 2) return v2.advance(account, j);
  const wallet = await transitWallet(account);
  const p = wallet.provider;
  if (j.pendingTx) {
    const r = await receipt(j.pendingTx);
    if (!r) return;
    return onEthConfirmed(account, j, r);
  }
  const now = Math.floor(Date.now() / 1000);
  switch (j.status) {
    case "front_gas": {
      if (BigInt(await p.getBalance(wallet.address)) >= await gasCostWei(j.route === "S" ? VORTEX_TAIL_GAS_UNITS + 60000n : ROUTE_GAS_UNITS)) {
        return saveJob(account, { ...j, status: j.afterGas, afterGas: undefined });
      }
      throw new Error("This older conversion needs gas. New sponsorship requires an approved ETH recovery plan; add your own ETH or ask the operator to reconcile this job.");
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
    case "wh_redeem": { // Routes S and T: take delivery of what Wormhole holds
      if (!railOn()) throw new Error(solRail().reason);
      const toEther = j.route === "T";
      /* Idempotent — the bridge remembers every VAA it has honoured. */
      if (await wormhole.isRedeemedOnEthereum(p, j.vaaEvmHash)) {
        if (toEther) return handOffToRouteC(account, j, p, wallet);
        const have = await swap.balanceOf(p, RC.VKOIN, wallet.address);
        if (have > 0n) {
          const next = await gasBeforeStep(j, p, wallet, "approve_bridge");
          return saveJob(account, { ...j, ...next, vkoinSats: have.toString() });
        }
        /* Honoured, yet nothing here: this VAA was not this job's transfer
           (an older one from the address history). Drop it and look again
           from Solana, where this job's tokens or its own transfer still
           are — but not forever. */
        if ((j.vaaDrops || 0) >= 2) throw new Error("Wormhole says the transfer was received on Ethereum, but the deposit address holds no vKOIN");
        return saveJob(account, {
          ...j, status: "sol_bridge", vaa: null, vaaEvmHash: null, vaaAmount: null, whEmitter: null, whSequence: null, solBridgeSig: null,
          vaaDrops: (j.vaaDrops || 0) + 1,
        });
      }
      /* Nobody can pay for this out of the deposit — its ether does not
         exist until this very transaction lands. A VAA names its recipient,
         so anyone may submit it: the sponsor does, and the money still goes
         where the guardians said. One transaction per job, and after it a
         route-T deposit pays for everything else itself. */
      const redeemer = await redeemerFor(account, j.route);
      if (!redeemer) {
        throw new Error(`Receiving this from Wormhole needs Ethereum gas — send about ${S.gasMinEth} ETH to your Ethereum deposit address, then Retry`);
      }
      const before = toEther
        ? (await p.getBalance(wallet.address)).toString()
        : (await swap.balanceOf(p, RC.VKOIN, wallet.address)).toString();
      const { hash } = await swap.sendTx(redeemer.wallet, wormhole.buildCompleteTransferTx(j.vaa, { unwrap: toEther }));
      return saveJob(account, { ...j, pendingTx: hash, redeemSponsored: redeemer.sponsored || undefined, ...(toEther ? { ethBefore: before } : { vkoinBefore: before }) });
    }
    case "collect_fee": {
      /* Taken in whatever this route is already holding, so no swap is added
         for it: ether where the deposit became ether, otherwise the token in
         hand. Ether goes straight back to the sponsor and refills the float;
         tokens accrue and are converted in one batch later, because per job
         that swap costs about as much as it recovers. */
      const to = feeRecipient();
      const amount = BigInt(j.feeAmount || 0);
      if (!to || amount <= 0n) return saveJob(account, { ...j, status: j.afterFee, afterFee: undefined });
      if (j.feeToken === "eth") {
        const have = await p.getBalance(wallet.address);
        const reserve = await gasReserveWei();
        /* Never let the fee eat the gas the rest of the route still needs. */
        if (have < reserve + amount) throw new Error("The complete legacy fee and remaining gas must be funded before this conversion continues");
        const send = amount;
        const sent = await wallet.sendTransaction({ to, value: send });
        return saveJob(account, { ...j, pendingTx: sent.hash, feePaidWei: send.toString() });
      }
      /* A token fee: the same value, priced through the same quoter the route
         uses, transferred to the treasury. */
      const token = j.feeToken === "usdt" ? RC.USDT : RC.VKOIN;
      const held = await swap.balanceOf(p, token, wallet.address);
      if (held < amount) throw new Error("The complete legacy fee is not available; this job needs reconciliation");
      const send = amount;
      const { hash } = await swap.sendTx(wallet, swap.buildTransferTx(token, to, send));
      return saveJob(account, { ...j, pendingTx: hash, feePaidUnits: send.toString() });
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
      const tx = buildTransferTokensTx({
        token: RC.VKOIN, amountSats: j.vkoinSats, koinosRecipient: j.koinosRecipient,
        relayer: relayerAddress(), network: S.network,
      });
      const { hash } = await swap.sendTx(wallet, tx);
      return saveJob(account, { ...j, pendingTx: hash });
    }
    case "deposit_eth": { // Route B
      const dep = await ethBridge.sendDeposit({
        ethPrivHex: transitFor(account).ethPriv, amountEth: j.amountEth,
        koinosRecipient: j.koinosRecipient, relayer: relayerAddress(),
        network: S.network, provider: p, maxEth: S.maxEth,
      });
      return saveJob(account, { ...j, status: "awaiting_signatures", ethTxHash: dep.hash, sigStartedAt: Date.now() });
    }
  }
}

/** How much of `token` did the confirmed transaction actually deliver?

    Its own receipt answers first: the Transfer logs are part of the block we
    already have, so nothing can lag. Only if the token logged no standard
    Transfer do we fall back to a balance diff — and even then we read AT the
    transaction's own block, never at whatever "latest" some node believes,
    because a node one block behind reports the swap as producing nothing and
    strands a job that in fact succeeded. */
async function deliveredBy(p, r, token, owner, beforeSats) {
  const fromLogs = swap.receivedInTx(r, token, owner);
  if (fromLogs !== null) return fromLogs;
  const now = await swap.balanceOf(p, token, owner, r.blockNumber);
  return now - BigInt(beforeSats);
}

async function onEthConfirmed(account, j, r) {
  const wallet = await transitWallet(account);
  const p = wallet.provider;
  const confirmedHash = j.pendingTx;
  let base = { ...j, pendingTx: null };
  switch (j.status) {
    case "front_gas": {
      /* The top-up left the sponsor's pocket, and so did its gas. */
      const sent = await p.getTransaction(confirmedHash);
      if (!sent || sent.value == null) throw new Error("Cannot read the original gas advance; refusing to guess from changed configuration");
      const spent = BigInt(sent.value) + gasSpent(r);
      const next = { ...addSponsorSpend(base, spent), status: j.afterGas, afterGas: undefined };
      if (j.asset === "usdt" && !j.feePaidUnits) return saveJob(account, await priceFee(next, { p, value: j.usdtSats, token: "usdt", next: j.afterGas }));
      if (j.route === "S" && j.vkoinSats && !j.feePaidUnits) return saveJob(account, await priceFee(next, { p, value: j.vkoinSats, token: "vkoin", next: j.afterGas }));
      return saveJob(account, next);
    }
    case "approve_v3_usdc":
      return saveJob(account, { ...base, status: "swap_usdc_usdt" });
    case "swap_usdc_usdt":
    case "swap_eth_usdt": {
      const got = await deliveredBy(p, r, RC.USDT, wallet.address, j.usdtBefore);
      if (got <= 0n) throw new Error(`${j.status === "swap_eth_usdt" ? "ETH" : "USDC"}→USDT swap produced no USDT`);
      const withUsdt = { ...base, status: "approve_permit2", usdtSats: got.toString() };
      /* A stablecoin deposit never holds ether of its own, so its fee is taken
         here, in the USDT it is carrying, and swapped back to ether in a batch
         when that is worth the gas. An ETH deposit already paid at the start. */
      if (j.asset === "eth" || j.route === "T") return saveJob(account, withUsdt);
      return saveJob(account, await priceFee(withUsdt, { p, value: got, token: "usdt", next: "approve_permit2" }));
    }
    case "approve_permit2":
      return saveJob(account, { ...base, status: "approve_ur" });
    case "approve_ur":
      return saveJob(account, { ...base, status: "swap_usdt_vkoin" });
    case "swap_usdt_vkoin": {
      const got = await deliveredBy(p, r, RC.VKOIN, wallet.address, j.vkoinBefore);
      if (got <= 0n) throw new Error("USDT→vKOIN swap produced no vKOIN");
      return saveJob(account, { ...base, status: "approve_bridge", vkoinSats: got.toString() });
    }
    case "wh_redeem": {
      /* If the sponsor submitted it, that gas is this job's to repay. */
      if (j.redeemSponsored) { j = addSponsorSpend(j, gasSpent(r)); base = { ...base, sponsorWei: j.sponsorWei }; }
      if (j.route === "T") {
        /* Native ether arrived: no log to read, so measure the balance at the
           block the redeem landed in. */
        const got = (await p.getBalance(wallet.address, r.blockNumber)) - BigInt(j.ethBefore || 0);
        if (got <= 0n) throw new Error("The Wormhole redeem delivered no ether");
        return handOffToRouteC(account, j, p, wallet, { ethReceivedWei: got.toString(), blockTag: r.blockNumber });
      }
      const got = await deliveredBy(p, r, RC.VKOIN, wallet.address, j.vkoinBefore);
      if (got <= 0n) throw new Error("The Wormhole redeem delivered no vKOIN");
      const next = await gasBeforeStep(j, p, wallet, "approve_bridge");
      const withVkoin = { ...base, ...next, vkoinSats: got.toString() };
      /* Nothing here is ether, so the fee is taken in vKOIN and converted in
         a batch later. Only once the gas step is out of the way. */
      if (withVkoin.status !== "approve_bridge") return saveJob(account, withVkoin);
      return saveJob(account, await priceFee(withVkoin, { p, value: got, token: "vkoin", next: "approve_bridge" }));
    }
    case "collect_fee": {
      /* Whatever left as the fee is no longer this job's to convert. */
      const paid = BigInt(j.feePaidUnits || 0);
      const out = { ...base, status: j.afterFee, afterFee: undefined };
      if (paid > 0n && j.feeToken === "usdt") out.usdtSats = String(BigInt(j.usdtSats || 0) - paid);
      if (paid > 0n && j.feeToken === "vkoin") out.vkoinSats = String(BigInt(j.vkoinSats || 0) - paid);
      return saveJob(account, out);
    }
    case "approve_bridge":
      return saveJob(account, { ...base, status: "bridge_token" });
    case "bridge_token":
      return saveJob(account, { ...base, status: "awaiting_signatures", ethTxHash: confirmedHash, sigStartedAt: Date.now() });
  }
}

/* ---------------- Routes S and T: the Solana legs ----------------
   Each leg is one transaction, sent and then tracked by its signature across
   ticks — like the Ethereum legs and their receipts — so a restart resumes
   from the chain, not from memory. The routes differ only in what the SOL is
   swapped into and carried home as: vKOIN for S, wETH for T. */

/** What this job's SOL is being turned into, for the messages. */
const solBuys = (j) => (j.route === "T" ? "ETH" : "vKOIN");
/** Reads the token balance this job started with, under either the current
    field name or the one route S shipped with. */
const solTokenBefore = (j) => BigInt(j.solTokenBefore != null ? j.solTokenBefore : (j.solVkoinBefore || 0));

async function advanceSol(account, j) {
  if (!railOn()) throw new Error(solRail().reason);
  const t = transitFor(account);
  if (!t || !t.solAddress) throw new Error("This account has no Solana deposit address");
  const c = await solConn();
  const mint = railMint(j);
  const bought = solBuys(j);
  if (j.pendingSig) {
    const st = await sol.signatureStatus(c, j.pendingSig);
    if (st && st.err) throw new Error(`Solana transaction failed (${st.err.slice(0, 120)})`);
    if (st && st.confirmed) return onSolConfirmed(account, j);
    /* Unknown, and its blockhash has lapsed: it can never land now. Drop it
       and let the step run again — every step re-reads the chain first, so
       a transaction the node merely lost track of is not sent twice. */
    if (j.pendingSigExpiry && (await sol.blockHeight(c)) > Number(j.pendingSigExpiry)) {
      return saveJob(account, { ...j, pendingSig: null, pendingSolRaw: null, pendingSigExpiry: null, resends: (j.resends || 0) + 1 });
    }
    if (j.pendingSolRaw) await sol.sendRaw(c, Buffer.from(j.pendingSolRaw, "base64"));
    return;
  }
  switch (j.status) {
    case "sol_swap": {
      if (j.feePlan?.version === 2) await v2.assertCapacity(j);
      /* On-chain truth first: a balance above the starting one means an
         earlier send landed after all. */
      const have = await sol.tokenBalance(c, mint, t.solAddress);
      if (have > solTokenBefore(j)) return saveJob(account, { ...j, status: "sol_bridge", solTokenSats: (have - solTokenBefore(j)).toString() });
      /* A swap that confirmed once is never sent again, whatever a lagging
         node says about the balance — the deposit must not be swapped twice. */
      if (j.solSwapSig) throw new Error(`The SOL → ${bought} swap already went through — waiting for it to show at the deposit address`);
      if ((j.resends || 0) > 3) throw new Error(`The SOL → ${bought} swap keeps expiring before it confirms — Retry when Solana is less busy`);
      const q = await jup.quote({ amount: j.solLamports, slippageBps: j.slippageBps, outputMint: mint });
      if (j.feePlan?.version === 2 && BigInt(q.outAmountMin) < BigInt(j.feePlan.minSolOutput)) {
        throw new Error("The SOL price moved below the accepted route minimum; no SOL was sent. Wait and Retry.");
      }
      const tx = await jup.swapTx({ quote: q, userPublicKey: t.solAddress });
      if (j.feePlan?.version === 2) {
        const signed = require("./sol/solana-lite").signSerialized(tx.swapTransaction, t.solSecret);
        saveJob(account, { ...j, pendingSig: signed.signature, pendingSolRaw: signed.raw.toString("base64"),
          pendingSigExpiry: tx.lastValidBlockHeight, minTokenOut: q.outAmountMin, solTokenBefore: have.toString() });
        await sol.sendRaw(c, signed.raw);
        return;
      }
      const sig = await sol.signAndSend(c, t.solSecret, tx.swapTransaction);
      return saveJob(account, { ...j, pendingSig: sig, pendingSigExpiry: tx.lastValidBlockHeight, minTokenOut: q.outAmountMin, solTokenBefore: have.toString() });
    }
    case "sol_bridge": {
      /* The bought token only ever sits on this address mid-flow: all of it
         belongs to this job, and a remainder would be stranded. The bridge
         spends from the associated token account, so that balance is the
         amount; anything in another account of the key is reported, not moved. */
      const total = await sol.tokenBalance(c, mint, t.solAddress);
      const have = await sol.ataBalance(c, mint, t.solAddress);
      if (have <= 0n) {
        throw new Error(total > 0n
          ? `${bought} is at the Solana deposit address but not in the token account the bridge spends from — it needs consolidating by hand`
          : `No ${bought} at the Solana deposit address to bridge`);
      }
      const amount = j.feePlan?.version === 2 ? BigInt(j.solTokenSats) : have;
      if (amount <= 0n || have < amount) throw new Error("The Solana token account does not hold this job's authorized amount");
      const built = await wormhole.buildTransfer({ rpcUrl: c.rpcEndpoint, secret: t.solSecret, mint, amountSats: amount, ethRecipient: t.ethAddress });
      if (j.feePlan?.version === 2) {
        saveJob(account, { ...j, pendingSig: built.signature, pendingSolRaw: built.raw.toString("base64"),
          pendingSigExpiry: built.lastValidBlockHeight, solTokenSats: amount.toString(),
          solTokenElsewhere: total > amount ? (total - amount).toString() : undefined });
        await sol.sendRaw(c, built.raw);
        return;
      }
      await sol.sendRaw(c, built.raw);
      return saveJob(account, {
        ...j, pendingSig: built.signature, pendingSigExpiry: built.lastValidBlockHeight, solTokenSats: have.toString(),
        solTokenElsewhere: total > have ? (total - have).toString() : undefined,
      });
    }
    case "awaiting_vaa": {
      if (!j.whSequence) {
        const id = await wormhole.messageIdFromTx({ rpcUrl: c.rpcEndpoint, txid: j.solBridgeSig });
        if (!id) return; // the node does not have the transaction yet
        return saveJob(account, { ...j, whEmitter: id.emitter, whSequence: id.sequence });
      }
      const got = await wormhole.fetchVaa({ emitter: j.whEmitter, sequence: j.whSequence });
      if (!got) {
        if (Date.now() - (j.vaaStartedAt || j.startedAt || 0) > POLL_TIMEOUT_MS) {
          saveJob(account, { ...j, status: "error", error: `Wormhole's guardians haven't signed the transfer yet. Your ${bought} is in the bridge — Retry keeps waiting.`, failedAt: "awaiting_vaa" });
        }
        return;
      }
      /* The VAA names both the token and the recipient. Check them: the
         recipient must be our Ethereum transit address, and the token must be
         the one this route bridges — a wETH VAA redeemed as vKOIN, or the
         reverse, would take the wrong branch on the Ethereum side. */
      const parsed = await wormhole.parseTransferVaa(got.hex, { expectRecipient: t.ethAddress, expectToken: railToken(j) });
      return saveJob(account, { ...j, status: "wh_redeem", vaa: got.hex, vaaEvmHash: parsed.evmHash, vaaAmount: parsed.amount });
    }
  }
}

async function onSolConfirmed(account, j) {
  const t = transitFor(account);
  const c = await solConn();
  const sig = j.pendingSig;
  const mint = railMint(j);
  const base = { ...j, pendingSig: null, pendingSigExpiry: null, pendingSolRaw: null };
  switch (j.status) {
    case "sol_swap": {
      let got = await sol.deliveredByTx(c, sig, mint, t.solAddress);
      if (got == null) got = (await sol.tokenBalance(c, mint, t.solAddress)) - solTokenBefore(j);
      if (got <= 0n) throw new Error(`SOL → ${solBuys(j)} swap produced no ${solBuys(j)}`);
      return saveJob(account, { ...base, status: "sol_bridge", solSwapSig: sig, solTokenSats: got.toString() });
    }
    case "sol_bridge":
      return saveJob(account, { ...base, status: "awaiting_vaa", solBridgeSig: sig, vaaStartedAt: Date.now() });
  }
}

/** The fee, expressed in the token a route is holding. Priced through the
    same quoters the route itself uses, so it tracks the market it is taken
    from rather than a stale figure. */
async function feeInToken(p, kind, feeWei) {
  const amountEth = ethers.formatEther(feeWei);
  if (kind === "usdt") return BigInt((await ethSwap.quoteUsdtOut({ amountWei: feeWei, provider: p })).usdt);
  if (kind === "vkoin") return BigInt((await ethSwap.quoteEthToVkoin({ amountEth, slippageBps: 0, provider: p })).koinOut);
  throw new Error(`no price for a ${kind} fee`);
}

/** Confirmed ETH, outstanding loans and unspent commitments. Token balances
    are never counted as spendable gas or as a promised future repayment. */
async function floatHealth() {
  if (!S.gasSponsorKey) return { sponsored: false };
  const p = await ethProvider();
  const wallet = new ethers.Wallet(S.gasSponsorKey, p);
  const [balance, rate] = await Promise.all([p.getBalance(wallet.address, "latest"), ethUsd(p)]);
  const byId = new Map();
  for (const j of [...Object.values(S.store.history || {}), ...Object.values(S.store.jobs)]) {
    if (j?.id) byId.set(j.id, j);
  }
  const x = gasAccounting.exposure([...byId.values()]);
  const floor = BigInt(S.gasPolicy.floorWei), required = floor + x.unspent;
  const usd = (w) => rate > 0 ? Number((Number(ethers.formatEther(w)) * rate).toFixed(2)) : undefined;
  return {
    sponsored: true, address: wallet.address, recoveryMode: "per-job-eth",
    balanceEth: ethers.formatEther(balance), balanceUsd: usd(balance),
    requiredEth: ethers.formatEther(required), requiredUsd: usd(required),
    protectedReserveEth: ethers.formatEther(floor), committedEth: ethers.formatEther(x.unspent),
    outstandingDebtEth: ethers.formatEther(x.debt),
    availableToSponsorEth: ethers.formatEther(gasAccounting.shortfall(balance, required)),
    healthy: balance >= required && x.total < BigInt(S.gasPolicy.maxOutstandingWei),
  };
}

/** Ether in dollars, from the same Uniswap pool the routes trade through.
    Cached briefly: every quote wants it and it barely moves. */
let _ethUsd = { at: 0, v: 0 };
async function ethUsd(p) {
  if (Date.now() - _ethUsd.at < 60000 && _ethUsd.v > 0) return _ethUsd.v;
  try {
    const { usdt } = await ethSwap.quoteUsdtOut({ amountWei: ethers.parseEther("1"), provider: p });
    const v = Number(usdt) / 1e6;
    if (v > 0) _ethUsd = { at: Date.now(), v };
  } catch (_) { /* no price — dollar thresholds simply do not fire */ }
  return _ethUsd.v;
}

/** Decide this job's fee, in the units of whatever it will be taken from, and
    put it on the job so every later step and the card agree on one number.

    The arithmetic in tools/eth/fees.js is unit-agnostic, so a token fee is
    priced natively: the sponsor's ether cost is converted into that token
    through the same forward quoter the route uses, and the percentage is
    simply a share of what is being converted. No reverse quote is needed. */
async function priceFee(j, { p, value, token, next }) {
  const skip = (why) => {
    if (sponsorSpent(j) > 0n) throw new Error(`Legacy gas repayment cannot be skipped: ${why}. This job needs reconciliation.`);
    return { ...j, status: next, feeAmount: "0", feeToken: undefined, afterFee: undefined, ...(why ? { feeSkipped: why } : {}) };
  };
  if (!feeRecipient()) return skip("no fee recipient configured");
  let sponsorCost = sponsorSpent(j);
  let transfer = await gasCostWei(60000n);
  if (token !== "eth") {
    try {
      if (sponsorCost > 0n) sponsorCost = await feeInToken(p, token, sponsorCost);
      transfer = await feeInToken(p, token, transfer);
    } catch (_) { return skip("no price for the fee right now"); }
  }
  const { fee } = fees.feeWei({ sponsorWei: sponsorCost, valueWei: BigInt(value), cfg: S.fee });
  if (!fees.worthCollecting(fee, transfer)) return skip("smaller than the transfer that would carry it");
  return { ...j, status: "collect_fee", afterFee: next, feeAmount: fee.toString(), feeToken: token };
}

/** Route T's handoff: the ether that arrived, less what the Ethereum legs
    will burn, becomes Route C's input. Called once the redeem is known to
    have happened, from either the step or its receipt. */
async function handOffToRouteC(account, j, p, wallet, extra = {}) {
  const { blockTag, ...fields } = extra;
  /* Read where the money is, not where a lagging node thinks it is: when the
     redeem's receipt is in hand, its own block is the honest answer. */
  const total = blockTag != null ? await p.getBalance(wallet.address, blockTag) : await p.getBalance(wallet.address);
  /* Spend only what the bridge actually released. The same address takes
     ETH, USDC and USDT deposits, so sweeping the whole balance would convert
     money nobody asked us to convert — and would walk straight past the
     per-swap cap on the way. */
  const arrived = BigInt(fields.ethReceivedWei || wormholeUnitsToWei(j.vaaAmount || 0));
  let usable = arrived > 0n && arrived < total ? arrived : total;
  const cap = ethers.parseEther(S.maxEth);
  if (usable > cap) usable = cap;
  const reserve = await gasReserveWei();
  const spend = usable > reserve ? usable - reserve : 0n;
  if (spend <= 0n) {
    throw new Error(`The ether from Wormhole (${short(ethers.formatEther(usable))}) does not cover the Ethereum gas this route still needs (about ${short(ethers.formatEther(reserve))}) — convert a larger amount, or send a little ETH to the Ethereum deposit address and Retry`);
  }
  const usdtBefore = (await swap.balanceOf(p, RC.USDT, wallet.address)).toString();
  /* The fee comes out of the ether the bridge just released — the one moment
     this route holds any — so nothing extra is swapped to pay it. */
  const priced = await priceFee({ ...j, ...fields }, { p, value: spend, token: "eth", next: "swap_eth_usdt" });
  const fee = BigInt(priced.feeAmount || 0);
  const net = spend > fee ? spend - fee : spend;
  return saveJob(account, {
    ...priced, pendingTx: null,
    amountWei: net.toString(), amountEth: ethers.formatEther(net),
    ethArrivedWei: usable.toString(), gasHeldWei: reserve.toString(), usdtBefore,
  });
}

/** Route S's tail spends from the transit address, which a Solana deposit
    never funded. Put a gas top-up in front of the next step when it is short. */
async function gasBeforeStep(j, p, wallet, nextStatus) {
  return gasDecision(j, nextStatus, await p.getBalance(wallet.address), !!S.gasSponsorKey, S.gasMinEth);
}
/** The decision on its own, so it can be checked without a chain. */
function gasDecision(j, nextStatus, balanceWei, hasSponsor, minEth) {
  if (BigInt(balanceWei) >= ethers.parseEther(minEth)) return { status: nextStatus };
  if (!hasSponsor) {
    throw new Error(`The Ethereum deposit address needs about ${minEth} ETH to finish through Vortex — send a little ETH there, then Retry`);
  }
  if ((j.gasFronts || 0) >= 2) {
    throw new Error(`Gas was fronted twice and the Ethereum deposit address still reads below ${minEth} ETH — check ETH_GAS_TOPUP against ETH_GAS_MIN, then Retry`);
  }
  return { status: "front_gas", afterGas: nextStatus, gasFronts: (j.gasFronts || 0) + 1 };
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
    if (j.feePlan?.version === 2) {
      saveJob(account, { ...j, status: "request_signatures" });
      return;
    }
    await ethBridge.requestNewSignatures({ ethPrivHex: transitFor(account).ethPriv, ethTxHash: j.ethTxHash, network: S.network, provider: await ethProvider() });
    saveJob(account, { ...j, status: "awaiting_signatures", sigStartedAt: Date.now() });
  }
}

/* The bridge already delivered this record (a reply we lost, or a retry). */
const ALREADY_DONE = /already complet|already redeem|already processed|has been completed|already exists/i;
/* The chain refused a sponsor-only redeem: only the recipient may claim.
   The first pattern is the Koinos bridge's own words. */
const NEEDS_RECIPIENT = /claimed by the recipient|recipient or relayer|has not authorized|not authorized|authority|unauthorized/i;

/** Who may submit complete_transfer for this record?

    The Koinos bridge answers "tokens can only be claimed by the recipient or
    relayer", and both names are sealed into the guardian-signed record when
    the Ethereum-side deposit is made. We now put our sponsor in the relayer
    field (see eth-bridge-token.js), so new deposits can be landed by the
    sponsor with no signature from the user at all. Deposits made before that
    carry an empty relayer and can only be claimed by their recipient — the
    user's own account — which means a passkey signature. */
function sponsorMayRedeem(record) {
  try { return !!record && String(record.relayer || "") === chain.sponsorAddress(); }
  catch (_) { return false; }
}
function relayerAddress() {
  try { return chain.sponsorAddress() || ""; } catch (_) { return ""; }
}

/** Try to complete the bridge transfer on the sponsor's own nonce. The
    recipient is fixed inside the guardian-signed record, so this can only
    ever deliver to the user's account — nobody, including us, can redirect
    it. If the chain refuses a sponsor-only redeem, the job switches to the
    passkey tap and stays there (see waitsForTap). */
async function autoRedeem(account, j) {
  const exp = j.record && Number(j.record.expiration);
  if (exp && exp <= Date.now()) {
    saveJob(account, { ...j, status: "awaiting_signatures", sigStartedAt: Date.now() });
    return;
  }
  /* This record names someone else (or nobody) as relayer, so the sponsor
     cannot claim it — don't spend mana proving that, just hand it to the
     passkey. */
  if (!sponsorMayRedeem(j.record)) {
    saveJob(account, { ...j, needsTap: true, redeemNote: "this deposit can only be claimed by your account" });
    return;
  }
  const attempts = (j.redeemAttempts || 0) + 1;
  const ops = [await opCompleteTransfer({ record: j.record, network: S.network, provider: chain.provider() })];
  try {
    const txid = await chain.sendAsSponsorFor(null, ops, { rcLimit: DEFAULT_REDEEM_RC });
    finishRedeem(account, txid);
  } catch (e) {
    const m = chain.humanChainError(e);
    /* Already delivered on an earlier attempt whose reply we lost. */
    if (ALREADY_DONE.test(m)) {
      finishRedeem(account, j.redeemId || "confirmed", "already completed");
      return;
    }
    /* The chain wants the recipient's own authority after all — hand the
       step to the passkey and leave it there for this job. */
    if (NEEDS_RECIPIENT.test(m)) {
      saveJob(account, { ...job(account), needsTap: true, redeemNote: "the bridge asked for your signature" });
      return;
    }
    /* Broadcast but unconfirmed: it may well have landed. Come back and
       let the bridge's own "already completed" answer settle it. */
    if (attempts < 15 && (e.broadcast || isTransient(m) || /nonce/i.test(m))) {
      saveJob(account, { ...job(account), redeemAttempts: attempts });
      return;
    }
    throw e;
  }
}

function finishRedeem(account, txid, note) {
  const j = job(account);
  if (!j) return;
  if (j.route === "B") {
    /* vETH landed on the account — the swap to KOIN spends it, so that
       step needs the passkey. */
    saveJob(account, { ...j, status: "awaiting_swap", redeemId: txid, vethSats: String(j.record ? j.record.amount : j.vethSats), redeemNote: note });
  } else {
    saveJob(account, { ...j, status: "done", redeemId: txid, koinReceived: String(j.record ? j.record.amount : j.estKoinOut), finishedAt: Date.now(), redeemNote: note });
  }
}

/* ---------------- the passkey steps ---------------- */

/** Operations for the step the job is waiting on — the server prepares,
    the PASSKEY authorizes, the chain verifies. */
async function prepareTapOps(account) {
  const j = job(account);
  if (!j) throw new Error("No swap in progress");
  if (j.status === "awaiting_redeem") {
    /* Normally sponsor-driven (see autoRedeem); only reachable once the
       chain has told us it wants the recipient's signature. */
    if (!j.needsTap) throw new Error("Your KOIN is landing on its own — no signature needed");
    if (S.demo) return { step: "redeem", ops: null, rcLimit: DEFAULT_REDEEM_RC };
    /* Guardian signatures live ~60 minutes. If they lapsed while waiting for
       the tap, flip back to polling — that path requests fresh signatures. */
    const exp = j.record && Number(j.record.expiration);
    if (exp && exp <= Date.now()) {
      saveJob(account, { ...j, status: "awaiting_signatures", sigStartedAt: Date.now() });
      throw new Error("The bridge signatures expired while waiting — requesting fresh ones; try again in ~2 minutes");
    }
    const ops = [await opCompleteTransfer({ record: j.record, network: S.network, provider: chain.provider() })];
    return { step: "redeem", ops, rcLimit: DEFAULT_REDEEM_RC };
  }
  if (j.status === "awaiting_swap") {
    if (S.demo) return { step: "koindx", ops: null, rcLimit: koindx.DEFAULT_SWAP_RC };
    const q = await koindx.quoteSwap({ amountInSats: j.vethSats, slippageBps: j.slippageBps, network: S.network, provider: chain.provider() });
    if (j.feePlan?.version === 2) {
      if (BigInt(q.amountOut) < BigInt(j.feePlan.koinOutMin)) throw new Error("The KoinDX price is below your approved minimum; wait and try again");
      q.amountOutMin = gasAccounting.max(BigInt(q.amountOutMin), BigInt(j.feePlan.koinOutMin)).toString();
    }
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
    finishRedeem(account, txid);
    const done = job(account);
    if (done) saveJob(account, { ...done, taps: (j.taps || 0) + 1 });
    return;
  }
  if (step === "koindx") {
    saveJob(account, { ...j, status: "done", swapId: txid, koinReceived: j.estKoinOut || j.koinReceived, finishedAt: Date.now(), taps: (j.taps || 0) + 1 });
  }
}

/* ---------------- demo simulation ----------------
   The full pipeline with fake balances and instant "chains", so the whole
   UI — including the passkey landing tap — runs anywhere. */

const DEMO_RATE_ETH_KOIN = 4200; // via route C
const DEMO_RATE_ETH_KOIN_B = 1600; // via the shallow KoinDX pool
const DEMO_RATE_USD_KOIN = 1.85;
/* Route S buys from the small Solana pool; route T from the deep Uniswap
   one, so it gets more KOIN per SOL — and it pays its own Ethereum gas,
   while route S's is on the platform. Both are charged, as they are live. */
const DEMO_RATE_SOL_KOIN = 330;   // via route S
const DEMO_RATE_SOL_KOIN_T = 355; // via route T
const DEMO_GAS_KOIN_T = 12;       // the ether route T holds back for gas
const DEMO_GAS_KOIN_S = 18;       // what the platform spends finishing route S

function demoBalances(account) {
  const t = S.store.transit[account];
  t.demoBal ||= { eth: "0.012", usdc: "18.5", usdt: "0", sol: "0.35" };
  const b = t.demoBal;
  if (b.sol == null) b.sol = "0.35"; // a record from before Route S
  return {
    eth: b.eth, ethWei: ethers.parseEther(b.eth).toString(),
    usdc: b.usdc, usdcSats: U.parseUsdc(b.usdc).toString(),
    usdt: b.usdt, usdtSats: U.parseUsdt(b.usdt).toString(),
    vkoin: "0", vkoinSats: "0",
    ...(t.solAddress ? {
      sol: b.sol, solLamports: SU.parseSol(b.sol).toString(),
      solVkoin: "0", solVkoinSats: "0", solWeth: "0", solWethSats: "0",
    } : {}),
  };
}
function demoQuoteFor(asset, amt, spendable) {
  const sats = (n) => BigInt(Math.round(n * 1e8)).toString();
  if (asset === "eth") {
    const eth = Number(ethers.formatEther(amt));
    const qs = [
      { ...routes.descriptor("C"), koinOut: sats(eth * DEMO_RATE_ETH_KOIN) },
      { ...routes.descriptor("B"), koinOut: sats(eth * DEMO_RATE_ETH_KOIN_B) },
    ];
    for (const q of qs) q.koinOutMin = ethSwap.applySlippage(q.koinOut, S.slippageBps).toString();
    return { asset, amount: ethers.formatEther(amt), ...routes.compareRoutes(qs) };
  }
  if (asset === "sol") {
    const solAmt = Number(SU.formatSol(amt));
    const qs = [];
    /* The fee always comes out of the deposit, so no route claims otherwise.
       A sponsor key only decides whether the platform fronts the gas first
       and takes it back — which is what the refusal ceiling is measured
       against, in demo as in life. */
    const sponsored = !!S.gasSponsorKey;
    const net = (gross, feeKoin, id, extra) => {
      if (gross - feeKoin <= 0) {
        return { ...routes.descriptor(id), koinOut: null, error: `the Ethereum gas to finish this route costs more than the ${gross.toFixed(2)} KOIN it would buy` };
      }
      /* The simulation shows the same money the live card does — dollars and
         a share of the swap — so the warning thresholds can be seen working. */
      const feeUsd = Number((feeKoin / DEMO_RATE_USD_KOIN).toFixed(2));
      const pct = gross > 0 ? Number(((feeKoin / gross) * 100).toFixed(2)) : 0;
      const said = fees.assess({ feeUsd, valueUsd: gross / DEMO_RATE_USD_KOIN, sponsoredUsd: sponsored ? feeUsd : 0, cfg: S.fee });
      const line = {
        ...routes.descriptor(id), koinOut: sats(gross - feeKoin),
        feeEth: (feeKoin / 3000).toFixed(6), feeUsd, feePct: pct,
        feeWarn: said.warn || undefined, feeLevel: said.level,
        feeReasons: said.reasons.length ? said.reasons : undefined,
        sponsorRefused: said.sponsorRefused || undefined,
        ...extra,
      };
      const min = BigInt(ethSwap.applySlippage(line.koinOut, S.slippageBps));
      line.koinOutMin = (min > 0n ? min : BigInt(line.koinOut)).toString();
      return line;
    };
    qs.push(net(solAmt * DEMO_RATE_SOL_KOIN_T, DEMO_GAS_KOIN_T, "T", {
      priceImpactPct: Math.round(solAmt * 5) / 100, via: ["Meteora"], ethBought: (solAmt / 60).toFixed(6),
    }));
    qs.push(net(solAmt * DEMO_RATE_SOL_KOIN, DEMO_GAS_KOIN_S, "S", {
      priceImpactPct: Math.round(solAmt * 300) / 100, via: ["Raydium"],
    }));
    return { asset, amount: SU.formatSol(amt), ...routes.compareRoutes(qs) };
  }
  const usd = Number(asset === "usdc" ? U.formatUsdc(amt) : U.formatUsdt(amt));
  const line = { ...routes.descriptor("C"), koinOut: sats(usd * DEMO_RATE_USD_KOIN) };
  line.koinOutMin = ethSwap.applySlippage(line.koinOut, S.slippageBps).toString();
  return { asset, amount: String(usd), ...routes.compareRoutes([line]) };
}
function demoStart(account, asset, amt, route) {
  const q = demoQuoteFor(asset, amt);
  const asked = route ? q.routes.find((r) => r.id === route && r.koinOut != null) : null;
  const chosen = asked || q.best;
  if (!chosen) {
    const why = q.routes.map((r) => r.error).filter(Boolean)[0];
    throw new Error(why ? `That can't be converted right now — ${why}` : "No route can be quoted right now");
  }
  const first = asset === "eth"
    ? (chosen.id === "C" ? "swap_eth_usdt" : "deposit_eth")
    : asset === "sol" ? "sol_swap"
    : (asset === "usdc" ? "approve_v3_usdc" : "approve_permit2");
  const estFeeEth = chosen.feeEth;
  saveJob(account, {
    asset, route: chosen.id, status: first, demo: true, koinosRecipient: account,
    ethFrom: S.store.transit[account].ethAddress,
    solFrom: asset === "sol" ? S.store.transit[account].solAddress : undefined,
    priceImpactPct: asset === "sol" ? chosen.priceImpactPct : undefined,
    estFeeEth: asset === "sol" ? estFeeEth : undefined,
    amountLabel: q.amount + " " + asset.toUpperCase(),
    spentSats: amt.toString(),
    estKoinOut: chosen.koinOut,
    startedAt: Date.now(), demoTicks: 0, taps: 0,
  });
  return publicJob(job(account));
}
const DEMO_FLOW_C = ["approve_v3_usdc", "swap_usdc_usdt", "swap_eth_usdt", "collect_fee", "approve_permit2", "approve_ur", "swap_usdt_vkoin", "approve_bridge", "bridge_token", "awaiting_signatures", "awaiting_redeem"];
const DEMO_FLOW_B = ["deposit_eth", "awaiting_signatures", "awaiting_redeem"];
const DEMO_FLOW_S = ["sol_swap", "sol_bridge", "awaiting_vaa", "wh_redeem", "collect_fee", "approve_bridge", "bridge_token", "awaiting_signatures", "awaiting_redeem"];
/* Route T rejoins route C at the ETH swap, because that is what it now holds. */
const DEMO_FLOW_T = ["sol_swap", "sol_bridge", "awaiting_vaa", "wh_redeem", "collect_fee", "swap_eth_usdt", "approve_permit2", "approve_ur", "swap_usdt_vkoin", "approve_bridge", "bridge_token", "awaiting_signatures", "awaiting_redeem"];
async function demoAdvance(account, j) {
  if (j.status === "awaiting_redeem") { finishRedeem(account, "0xdemo-redeem"); return; }
  const flow = j.route === "B" ? DEMO_FLOW_B : j.route === "S" ? DEMO_FLOW_S : j.route === "T" ? DEMO_FLOW_T : DEMO_FLOW_C;
  const at = flow.indexOf(j.status);
  if (at < 0) return;
  let next = flow[at + 1];
  if (j.route === "C") {
    while (next === "approve_v3_usdc" && j.asset !== "usdc") next = flow[flow.indexOf(next) + 1];
    if (j.asset !== "usdc" && next === "swap_usdc_usdt") next = j.asset === "eth" ? "swap_eth_usdt" : "approve_permit2";
    if (j.asset !== "eth" && next === "swap_eth_usdt") next = "approve_permit2";
  }
  if (!next) return;
  const upd = { ...j, status: next, demoTicks: 0 };
  if (next === "awaiting_redeem") {
    upd.record = { amount: j.estKoinOut, id: "0xdemo", recipient: account, koinosToken: "demo", signatures: ["a", "b"], expiration: String(Date.now() + 3600000) };
    if (j.route === "B") upd.vethSats = j.estKoinOut;
    /* The chosen amount left the deposit address. */
    const t = S.store.transit[account];
    const spent = BigInt(j.spentSats || 0);
    const dec = { eth: 18, usdc: 6, usdt: 6, sol: 9 }[j.asset];
    const cur = ethers.parseUnits(t.demoBal[j.asset], dec);
    t.demoBal[j.asset] = ethers.formatUnits(cur > spent ? cur - spent : 0n, dec);
  }
  saveJob(account, upd);
}

/* ---------------- public status ---------------- */

async function status(account) {
  const t = transitFor(account);
  if (!t) return { enabled: false };
  const j = job(account);
  const out = {
    enabled: true, demo: S.demo || undefined, ethAddress: t.ethAddress, job: publicJob(j),
    /* The address always; whether we can convert from it, separately. */
    solAddress: t.solAddress || null, solRail: solRail(),
    caps: { eth: S.maxEth, stable: S.maxStable, sol: S.maxSol },
    solMin: S.minSol, solFloor: solFloor(),
    gasMinEth: S.gasMinEth, gasFronting: !!S.gasSponsorKey,
    feePct: S.fee.ratePct, feeWarnUsd: S.fee.warnUsd, feeWarnPct: S.fee.warnPct,
    feeMaxSponsoredUsd: S.fee.maxSponsoredUsd,
    slippageBps: S.slippageBps,
  };
  /* Balances always (so the card can show what the address holds, zeros
     included); route quotes only while nothing is actively moving. */
  try {
    out.balances = await balances(account);
  } catch (e) { out.balancesError = String(e.message || e).slice(0, 160); }
  if (out.balances) {
    /* What is spendable, what it would buy, and how the float is doing are
       three separate questions about the same moment. Asked in sequence, a
       poll cost as long as all three added together — and it runs every few
       seconds while a swap is moving. Only the first needs the balances.

       Each keeps its own failure: the card gates the whole convert panel on
       `spendable`, so a quote or a float read that falls over must not take
       the amounts — and with them the way to convert — off the screen. */
    const wantQuotes = !j || TERMINAL.has(j.status);
    const [spendable, quoted] = await Promise.all([
      Promise.all(FUNDABLE.map((a) => spendableOf(a, out.balances).then((sp) => sp.label)))
        .catch((e) => { out.balancesError = String(e.message || e).slice(0, 160); return null; }),
      wantQuotes ? quotes(account).catch(() => null) : Promise.resolve(undefined),
      floatHealth().then((f) => { out.float = f; }, () => {}),
    ]);
    if (spendable) out.spendable = Object.fromEntries(FUNDABLE.map((a, i) => [a, spendable[i]]));
    if (wantQuotes) out.quotes = quoted;
  }
  return out;
}

/* ---------------- is the rail actually wired up? ----------------

   ETH_RPC and SOLANA_RPC both fall through to public endpoints when they
   fail, which is right for a deposit that must not go dark — and terrible
   for the operator, because a mistyped key looks exactly like a working
   one until the public node starts refusing datacenter traffic. So this
   probes each configured endpoint BY ITSELF, and says which one actually
   answered.

   It is served unauthenticated, so it must give away nothing an RPC URL
   is hiding: the key lives in the URL's path or query, and RPC errors
   love to echo the whole URL back. Only the host is ever reported, and
   every message is stripped of anything URL-shaped first. */

/** A URL reduced to its host, or null — never the path, never the query. */
function rpcHost(url) {
  try { return new URL(String(url)).host; } catch (_) { return null; }
}

/** An error message with every URL in it replaced by its bare host, so a
    key embedded in one cannot ride out on a diagnostic. */
function scrubUrls(msg) {
  return String(msg || "")
    .replace(/https?:\/\/[^\s"'`,)]+/gi, (u) => rpcHost(u) || "<endpoint>")
    .slice(0, 200);
}

/** Probe one endpoint on its own, so a healthy fallback cannot disguise a
    broken setting. */
async function probeEth(url) {
  const started = Date.now();
  try {
    const p = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
    const n = await p.getBlockNumber();
    try { p.destroy(); } catch (_) { /* older ethers has no destroy */ }
    return { host: rpcHost(url), ok: true, blockNumber: n, ms: Date.now() - started };
  } catch (e) {
    return { host: rpcHost(url), ok: false, error: scrubUrls(e.message || e) };
  }
}

async function probeSol(url) {
  const started = Date.now();
  try {
    const height = await solLite.blockHeight({ urls: [url] });
    return { host: rpcHost(url), ok: true, blockHeight: height, ms: Date.now() - started };
  } catch (e) {
    const why = scrubUrls(e.message || e);
    return {
      host: rpcHost(url), ok: false, error: why,
      /* The one failure with a specific cure, so it is named rather than
         left as a status code. */
      hint: /\b(403|429)\b|forbidden|too many/i.test(why)
        ? "this endpoint refuses server traffic — SOLANA_RPC needs to be your own"
        : undefined,
    };
  }
}

/** What an operator needs to know before trusting the rail: whether each
    setting took, and whether the float can pay for a job. */
async function railHealth() {
  const ethUrls = ethBridge.rpcCandidates ? ethBridge.rpcCandidates() : [];
  const solUrls = SC.solanaRpcCandidates();
  const ethOwn = String(process.env.ETH_RPC || "").split(",").map((u) => u.trim()).filter(Boolean);
  const solOwn = String(process.env.SOLANA_RPC || "").split(",").map((u) => u.trim()).filter(Boolean);

  /* Probing your own endpoints is the point; the public fallbacks are only
     probed when there are no others, so this stays a handful of requests. */
  const ethProbeList = ethOwn.length ? ethOwn : ethUrls.slice(0, 1);
  const solProbeList = solOwn.length ? solOwn : solUrls.slice(0, 1);
  const [ethProbes, solProbes, float] = await Promise.all([
    Promise.all(ethProbeList.map(probeEth)),
    Promise.all(solProbeList.map(probeSol)),
    /* A float reading needs a live node, and the address does not. When the
       node is the thing that is broken, the operator still has to be told
       WHERE to send the ether — so the address survives the failure. */
    floatHealth().catch((e) => ({
      sponsored: !!S.gasSponsorKey,
      address: S.gasSponsorKey ? new ethers.Wallet(S.gasSponsorKey).address : undefined,
      error: scrubUrls(e.message || e),
    })),
  ]);

  const verdict = (own, probes) => {
    if (!own.length) return "using the public endpoints — set your own before any real traffic";
    if (probes.every((r) => r.ok)) return "your endpoint answered";
    if (probes.some((r) => r.ok)) return "one of your endpoints is down; the rest answered";
    return "your endpoint did NOT answer — the rail is silently running on public nodes";
  };

  return {
    caps: { eth: S.maxEth, stable: S.maxStable, sol: S.maxSol },
    ethRpc: { configured: ethOwn.length, endpoints: ethProbes, verdict: verdict(ethOwn, ethProbes) },
    solanaRpc: { configured: solOwn.length, endpoints: solProbes, verdict: verdict(solOwn, solProbes) },
    /* floatHealth already reports the address, the balance and whether it
       covers a job; the key itself is never echoed anywhere. */
    gasSponsor: float,
    solRail: solRail(),
  };
}

module.exports = {
  configure, enable, status, start, resume, reset, quoteFor,
  prepareTapOps, onTapDone, transitFor, job, publicJob,
  /* the driver, exposed so tests can step it without waiting on the timer */
  tick,
  /* the gas-reserve maths, exposed so a test can price it at a known fee */
  _spendableOf: spendableOf,
  /* the job writer, exposed so a test can move a job on and watch the
     stall bookkeeping follow */
  _saveJob: saveJob,
  /* ages out the cached fee, so a test can price two different gas markets
     back to back without waiting ten real seconds */
  _forgetFeeCache: () => { _feeData = { at: 0, p: null }; },
  /* Route S's where-is-the-money logic, exposed so a test can feed it facts */
  _reconcileRouteS: reconcileSol,
  _solRail: solRail,
  _sdkReady: probeSdk,
  /* the gas decision for a Solana job's Ethereum tail, without a chain */
  _gasDecision: gasDecision,
  /* the sponsor float: what it holds against what it needs, for the operator */
  floatHealth,
  /* did ETH_RPC / SOLANA_RPC / ETH_GAS_SPONSOR_KEY actually take? */
  railHealth,
};
