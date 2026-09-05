/* The dollar line must be honest.

   A wallet that prints "$0.00" because a price feed was down is lying about
   someone's money. So every price here is a real quote with its source and
   age, or an honest null — and these checks pin how it gets there:

     1. on-chain quotes are the first choice and are converted correctly
        (10 USDT → N vKOIN gives a KOIN/USD price, not its reciprocal);
     2. when the chain quote fails, CoinGecko is the fallback — and when
        that fails too, the answer is null, never 0;
     3. a good value is cached, then served STALE (and marked so) while a
        refresh keeps failing, and finally expires back to unknown;
     4. VHP/USD is derived from VHP/KOIN × KOIN/USD, with the KoinDX reserve
        sides identified from the pool's own VHP balance, not by ordering.

   Run: node tests/prices.test.js
*/
'use strict';
const assert = require('node:assert');
const { createPrices, TTL_MS, STALE_MAX_MS } = require('../tools/prices');

/** A clock we control, so cache ages are exact. */
let T = 1_000_000;
const now = () => T;

/** Minimal koilib-shaped stubs for the KoinDX reads. */
function fakeKoindx({ pool = '1PoolAddrXXXXXXXXXXXXXXXXXXXXXXXX', reserveA = '1000000000000', reserveB = '960000000000', vhpInPool = '1000000000000' } = {}) {
  const chain = {
    provider: () => ({}),
    vhpBalanceSats: async (owner) => (owner === pool ? vhpInPool : '0'),
  };
  return { chain, pool, reserveA, reserveB };
}

/* prices.js constructs koilib Contracts for the KoinDX reads through an
   injectable factory; this one answers from the fake pool above. */
let KOINDX_STATE = null;
const makeContract = ({ id }) => ({
  id,
  functions: {
    get_pair: async () => ({ result: { value: KOINDX_STATE.pool } }),
    get_reserves: async () => ({ result: { reserveA: KOINDX_STATE.reserveA, reserveB: KOINDX_STATE.reserveB } }),
  },
});

function make({ vkoinPer10Usdt = 980_00000000n, usdtPerEth = 2500_000000n, ethFails = false, gecko = null, koindx = fakeKoindx() } = {}) {
  KOINDX_STATE = koindx;
  const calls = { vkoin: 0, eth: 0, gecko: [] };
  const ethSwap = {
    quoteVkoinOut: async () => { calls.vkoin++; if (ethFails) throw new Error('rpc down'); return vkoinPer10Usdt; },
    quoteUsdtOut: async () => { calls.eth++; if (ethFails) throw new Error('rpc down'); return { usdt: usdtPerEth, fee: 500 }; },
  };
  const fetchImpl = async (url) => {
    calls.gecko.push(url);
    if (!gecko) throw new Error('network down');
    const id = /ids=([a-z]+)/.exec(url)[1];
    return { ok: true, json: async () => ({ [id]: { usd: gecko[id] } }) };
  };
  const prices = createPrices({
    chain: koindx.chain, network: 'mainnet',
    ethProvider: async () => ({}), ethSwap, fetch: fetchImpl, now, log: () => {},
    peripheryAbi: {}, coreAbi: {}, makeContract,
  });
  return { prices, calls };
}

(async () => {
  /* --- 1. on-chain first, converted the right way round --- */
  {
    const { prices, calls } = make({ vkoinPer10Usdt: 980_00000000n });   // 10 USDT buys 980 vKOIN
    const k = await prices.koinUsd();
    assert.ok(Math.abs(k.value - 10 / 980) < 1e-12, `KOIN/USD must be 10/980, got ${k.value}`);
    assert.strictEqual(k.source, 'uniswap vKOIN/USDT');
    assert.strictEqual(k.stale, false);
    assert.strictEqual(calls.gecko.length, 0, 'CoinGecko is not consulted when the chain answers');
    const e = await prices.ethUsd();
    assert.strictEqual(e.value, 2500, 'ETH/USD from 1 ETH → 2500 USDT');
    console.log('✓ on-chain quotes come first, and KOIN/USD is 10/vKOIN-out, not its reciprocal');
  }

  /* --- 2. fallback to CoinGecko; and null — never 0 — when both fail --- */
  {
    const { prices, calls } = make({ ethFails: true, gecko: { koinos: 0.0123, ethereum: 2600 } });
    const k = await prices.koinUsd();
    assert.strictEqual(k.value, 0.0123);
    assert.strictEqual(k.source, 'coingecko');
    assert.ok(calls.gecko.some(u => /ids=koinos/.test(u)));

    const dead = make({ ethFails: true, gecko: null });
    const k2 = await dead.prices.koinUsd();
    assert.strictEqual(k2.value, null, 'no source at all must yield null');
    assert.notStrictEqual(k2.value, 0, 'and never a zero that looks like a price');
    console.log('✓ CoinGecko is the fallback, and with nothing at all the answer is null, not $0');
  }

  /* --- 3. cache, stale-while-error, then expiry --- */
  {
    let fail = false;
    /* A quote that can be made to fail after its first success. */
    const p = createPrices({
      chain: fakeKoindx().chain, network: 'mainnet', ethProvider: async () => ({}),
      ethSwap: { quoteVkoinOut: async () => { if (fail) throw new Error('down'); return 1000_00000000n; }, quoteUsdtOut: async () => ({ usdt: 1n }) },
      fetch: async () => { throw new Error('down'); }, now, log: () => {}, peripheryAbi: {}, coreAbi: {}, makeContract,
    });
    T = 1_000_000;
    let k = await p.koinUsd();
    assert.strictEqual(k.value, 0.01);
    assert.strictEqual(k.stale, false);

    T += TTL_MS - 1;                                   // still fresh
    fail = true;
    k = await p.koinUsd();
    assert.strictEqual(k.value, 0.01);
    assert.strictEqual(k.stale, false, 'inside TTL the cached value is fresh and no refresh is attempted');

    T += 2;                                            // just past TTL, refresh fails
    k = await p.koinUsd();
    assert.strictEqual(k.value, 0.01, 'a failed refresh serves the last good value');
    assert.strictEqual(k.stale, true, '…and says it is stale');

    T += STALE_MAX_MS;                                 // too old to trust
    k = await p.koinUsd();
    assert.strictEqual(k.value, null, 'past STALE_MAX a stale value goes back to unknown');

    fail = false;
    k = await p.koinUsd();
    assert.strictEqual(k.value, 0.01);
    assert.strictEqual(k.stale, false, 'and recovers as soon as the source does');
    console.log('✓ cached, served stale-and-marked while the source fails, expired past an hour, recovers after');
  }

  /* --- 4. VHP: reserve sides by pool balance, USD derived --- */
  {
    // reserveA is the VHP side here (pool holds 10,000 VHP = reserveA); 9,600 KOIN on the other side
    const kd = fakeKoindx({ reserveA: '1000000000000', reserveB: '960000000000', vhpInPool: '1000000000000' });
    const { prices } = make({ vkoinPer10Usdt: 1000_00000000n, koindx: kd });   // KOIN = $0.01
    const v = await prices.vhpKoin();
    assert.ok(Math.abs(v.value - 0.96) < 1e-12, `VHP/KOIN must be 9600/10000 = 0.96, got ${v.value}`);
    const snap = await prices.snapshot();
    assert.ok(Math.abs(snap.vhpUsd.value - 0.0096) < 1e-12, `VHP/USD = 0.96 × 0.01, got ${snap.vhpUsd.value}`);
    assert.match(snap.vhpUsd.source, /koindx koin\/vhp × uniswap/);

    // same pool with the reserves the other way round — the answer must not flip
    const flipped = fakeKoindx({ reserveA: '960000000000', reserveB: '1000000000000', vhpInPool: '1000000000000' });
    const { prices: p2 } = make({ koindx: flipped });
    const v2 = await p2.vhpKoin();
    assert.ok(Math.abs(v2.value - 0.96) < 1e-12, 'reserve order must not change the price');
    console.log('✓ VHP/KOIN reads the right reserve side either way; VHP/USD derives from it');
  }

  /* --- 5. VHP with KOIN price unknown: VHP/USD is unknown too, not a number --- */
  {
    const { prices } = make({ ethFails: true, gecko: null });
    const snap = await prices.snapshot();
    assert.ok(snap.vhpKoin.value > 0, 'VHP/KOIN itself is still known (it is on Koinos)');
    assert.strictEqual(snap.vhpUsd.value, null, 'but VHP/USD cannot be, without KOIN/USD');
    console.log('✓ without a KOIN/USD price, VHP/USD is honestly unknown');
  }

  console.log('\nALL PRICE CHECKS PASSED');
})().catch((e) => { console.error('FAILED:', e.message, '\n', e.stack); process.exit(1); });
