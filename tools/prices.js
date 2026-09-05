/* ============================================================
   Prices, for the dollar line on the wallet screen.

   A wallet that shows "$0.00" when it does not know the price is lying, so
   every number here is either a real quote with its source and age, or an
   honest null the UI renders as "—". Nothing throws; a price feed being down
   must never break a balance screen.

   Sources, on-chain first — those need no third party and cannot be
   rate-limited away:

     KOIN/USD   the vKOIN/USDT Uniswap v4 pool (vKOIN is KOIN bridged 1:1),
                quoted through the same quoter the funding route uses.
                Fallback: CoinGecko id "koinos".
     ETH/USD    the WETH/USDT Uniswap v3 quoter. Fallback: CoinGecko "ethereum".
     VHP/KOIN   the KoinDX koin/vhp pool's reserves (mid price). VHP/USD is
                then VHP/KOIN × KOIN/USD. No third-party lists VHP.

   Each value is cached; a fresh read is attempted once the cache is older
   than TTL, and if that read fails the last good value is served marked
   stale for up to STALE_MAX before it goes back to unknown.
   ============================================================ */
'use strict';

const { Contract } = require('koilib');
const { ethers } = require('ethers');

const TTL_MS = 60 * 1000;
const STALE_MAX_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

/* KoinDX (mainnet). The periphery keys chain-native tokens by NAMESPACE —
   "koin" and "vhp" — never by address; asking with an address finds nothing. */
const KOINDX_PERIPHERY = '17e1q6Fh5RgnuA8K7v4KvXXH4k9qHgsT5s';
const KOINDX_KOIN = 'koin';
const KOINDX_VHP = 'vhp';

function createPrices(cfg) {
  const { chain, network } = cfg;              // koinos chain module; 'mainnet' | 'harbinger'
  const ethProvider = cfg.ethProvider;        // async () => ethers provider (may throw)
  const ethSwap = cfg.ethSwap;                // tools/eth/eth-swap quote helpers
  const coingecko = cfg.coingecko !== false;  // allow disabling the third party entirely
  const fetchImpl = cfg.fetch || globalThis.fetch;
  const now = cfg.now || (() => Date.now());
  const log = cfg.log || (() => {});
  const periphery = cfg.koindxPeriphery || KOINDX_PERIPHERY;
  const PeripheryAbi = cfg.peripheryAbi || require('./eth/abi/koindx-periphery-abi.json');
  const CoreAbi = cfg.coreAbi || require('./eth/abi/koindx-core-abi.json');
  /* Contract construction is injectable so the KoinDX reads can be tested
     against a fake pool without a chain. */
  const makeContract = cfg.makeContract || ((opts) => new Contract(opts));

  /* ---- the cache: one slot per price ---- */
  const slots = new Map(); // key -> { value, source, at, inflight }

  async function cached(key, read) {
    const slot = slots.get(key) || { value: null, source: null, at: 0, inflight: null };
    slots.set(key, slot);
    const age = now() - slot.at;
    if (slot.value != null && age < TTL_MS) return view(slot, false);
    if (!slot.inflight) {
      slot.inflight = (async () => {
        try {
          const r = await read();
          if (r && r.value != null && Number.isFinite(r.value) && r.value > 0) {
            slot.value = r.value; slot.source = r.source; slot.at = now();
          }
        } catch (e) {
          log(`[prices] ${key}: ${String(e.message || e).slice(0, 120)}`);
        } finally { slot.inflight = null; }
      })();
    }
    await slot.inflight;
    const fresh = now() - slot.at < TTL_MS;
    if (slot.value != null && (fresh || now() - slot.at < STALE_MAX_MS)) return view(slot, !fresh);
    return { value: null, source: null, at: null, stale: false };
  }
  const view = (slot, stale) => ({ value: slot.value, source: slot.source, at: slot.at, stale });

  /* ---- readers ---- */

  async function withTimeout(p, ms = FETCH_TIMEOUT_MS) {
    let t;
    const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timed out')), ms); if (t.unref) t.unref(); });
    try { return await Promise.race([p, timeout]); } finally { clearTimeout(t); }
  }

  async function geckoUsd(id) {
    if (!coingecko || !fetchImpl) throw new Error('coingecko disabled');
    const res = await withTimeout(fetchImpl(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
      { headers: { accept: 'application/json' } }));
    if (!res.ok) throw new Error(`coingecko ${res.status}`);
    const j = await res.json();
    const v = Number(j && j[id] && j[id].usd);
    if (!Number.isFinite(v) || v <= 0) throw new Error('coingecko: no price');
    return { value: v, source: 'coingecko' };
  }

  /** KOIN/USD from the vKOIN/USDT pool: how much vKOIN does 10 USDT buy?
      Ten rather than one so a 6-decimal USDT amount survives the pool's
      rounding; the ratio is the price either way. */
  async function koinUsdOnChain() {
    if (!ethSwap || !ethProvider) throw new Error('no ethereum provider');
    const p = await withTimeout(ethProvider());
    const usdtSats = 10_000_000n;                              // 10 USDT, 6 decimals
    const vkoinSats = await withTimeout(ethSwap.quoteVkoinOut({ usdtSats, provider: p }));
    const out = Number(vkoinSats) / 1e8;                       // vKOIN, 8 decimals
    if (!(out > 0)) throw new Error('empty vKOIN quote');
    return { value: 10 / out, source: 'uniswap vKOIN/USDT' };
  }

  async function ethUsdOnChain() {
    if (!ethSwap || !ethProvider) throw new Error('no ethereum provider');
    const p = await withTimeout(ethProvider());
    const { usdt } = await withTimeout(ethSwap.quoteUsdtOut({ amountWei: ethers.parseEther('1'), provider: p }));
    const v = Number(usdt) / 1e6;
    if (!(v > 0)) throw new Error('empty USDT quote');
    return { value: v, source: 'uniswap WETH/USDT' };
  }

  /** VHP/KOIN from the KoinDX pool's reserves — the mid price. Which reserve
      is which is not implied by ordering, so it is read off the pool's own
      VHP balance, the same way the vETH swap does it. */
  async function vhpKoinOnChain() {
    if (network !== 'mainnet') throw new Error('KoinDX is mainnet-only');
    const provider = chain.provider();
    const router = makeContract({ id: periphery, abi: PeripheryAbi, provider }).functions;
    const pool = (await router.get_pair({ tokenA: KOINDX_KOIN, tokenB: KOINDX_VHP })).result?.value;
    if (!pool) throw new Error('no koin/vhp pool');
    const core = makeContract({ id: String(pool), abi: CoreAbi, provider }).functions;
    const reserves = (await core.get_reserves({})).result || {};
    const vhpInPool = BigInt(await chain.vhpBalanceSats(String(pool)));
    const a = BigInt(reserves.reserveA || 0), b = BigInt(reserves.reserveB || 0);
    if (a <= 0n || b <= 0n) throw new Error('empty reserves');
    const [rVhp, rKoin] = vhpInPool === a ? [a, b] : vhpInPool === b ? [b, a]
      /* Balance and reserve can differ by unsynced dust; pick the closer. */
      : (abs(a - vhpInPool) <= abs(b - vhpInPool) ? [a, b] : [b, a]);
    return { value: Number(rKoin) / Number(rVhp), source: 'koindx koin/vhp' };
  }
  const abs = (x) => (x < 0n ? -x : x);

  /* ---- public: each one on-chain first, then the fallback ---- */

  const koinUsd = () => cached('koinUsd', async () => {
    try { return await koinUsdOnChain(); } catch (e) { log(`[prices] koin on-chain: ${e.message}`); }
    return geckoUsd('koinos');
  });
  const ethUsd = () => cached('ethUsd', async () => {
    try { return await ethUsdOnChain(); } catch (e) { log(`[prices] eth on-chain: ${e.message}`); }
    return geckoUsd('ethereum');
  });
  const vhpKoin = () => cached('vhpKoin', vhpKoinOnChain);

  /** Everything the wallet screen needs, in one read. Off mainnet the
      Koinos-side legs are null: tKOIN is not KOIN, and pricing it at the
      mainnet rate would put dollar totals on a testnet. ETH/USD stays — it
      is an Ethereum price either way. */
  const NONE = { value: null, source: null, at: null, stale: false };
  async function snapshot() {
    if (network !== 'mainnet') {
      return { koinUsd: { ...NONE, source: 'testnet' }, ethUsd: await ethUsd(), vhpKoin: NONE, vhpUsd: NONE };
    }
    const [k, e, v] = await Promise.all([koinUsd(), ethUsd(), vhpKoin()]);
    const vhpUsd = k.value != null && v.value != null
      ? { value: k.value * v.value, source: `${v.source} × ${k.source}`, at: Math.min(k.at, v.at), stale: k.stale || v.stale }
      : { value: null, source: null, at: null, stale: false };
    return { koinUsd: k, ethUsd: e, vhpKoin: v, vhpUsd };
  }

  return { koinUsd, ethUsd, vhpKoin, snapshot, _slots: slots };
}

module.exports = { createPrices, TTL_MS, STALE_MAX_MS };
