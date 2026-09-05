/* What the home screen prints, checked without a browser.

   The two ways a wallet screen misleads people about money are printing
   $0.00 for a price it does not know, and rounding a balance into a number
   that is not the balance. Both are pinned here, against the same code the
   page runs (public/js/portfolio.js, loaded into a bare sandbox).

   Run: node tests/portfolio-model.test.js
*/
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPortfolio() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'portfolio.js'), 'utf8');
  const store = new Map();
  const sandbox = {
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;Portfolio;', sandbox);
  return vm.runInContext('Portfolio', sandbox);
}
const P = loadPortfolio();
const plain = (o) => JSON.parse(JSON.stringify(o));

(() => {
  /* --- 1. amounts are exact --- */
  {
    assert.strictEqual(P.fromSats('12419000001', 8), '124.19000001');
    assert.strictEqual(P.fromSats('1', 8), '0.00000001', 'one satoshi survives');
    assert.strictEqual(P.fromSats('100000000', 8), '1');
    assert.strictEqual(P.fromSats('900719925474099', 8), '9007199.25474099', 'past float precision, still exact');
    assert.strictEqual(P.fromSats('250000', 4), '25');
    assert.strictEqual(P.fromSats('7', 0), '7', 'a zero-decimal token');
    assert.strictEqual(P.fromSats(null, 8), null);
    assert.strictEqual(P.fromSats('abc', 8), null);
    console.log('✓ balances print exactly from the chain integer, any decimals');
  }

  /* --- 2. display never collapses a real balance to zero --- */
  {
    assert.strictEqual(P.fmtAmount('124.19', 4), '124.19');
    assert.strictEqual(P.fmtAmount('1234567.891', 4), '1,234,567.891');
    assert.strictEqual(P.fmtAmount('0', 4), '0');
    assert.strictEqual(P.fmtAmount('0.00000001', 4), '<0.0001', 'dust shows as less-than, not as nothing');
    assert.strictEqual(P.fmtAmount('1.99995', 4), '1.9999', 'cut, never rounded up: the screen never claims more than is there');
    assert.strictEqual(P.fmtAmount('124.19999999', 4), '124.1999');
    assert.strictEqual(P.fmtAmount('0.00019', 4), '0.0001');
    assert.strictEqual(P.fmtAmount(null), '—');
    console.log('✓ display amounts keep dust visible and nulls as a dash');
  }

  /* --- 3. dollars: unknown is a dash, small is not $0.00 --- */
  {
    assert.strictEqual(P.fmtUsd(null), '—', 'an unknown price is never $0.00');
    assert.strictEqual(P.fmtUsd(undefined), '—');
    assert.strictEqual(P.fmtUsd(0), '$0.00', 'a genuine zero is $0.00');
    assert.strictEqual(P.fmtUsd(1.2667), '$1.27');
    assert.strictEqual(P.fmtUsd(1234.5), '$1,234.50');
    assert.strictEqual(P.fmtUsd(0.0034), '$0.0034', 'a few tenths of a cent is not $0.00');
    assert.strictEqual(P.fmtUsd(0.000123), '$0.000123');
    assert.strictEqual(P.fmtPrice(0.0102), '$0.0102');
    assert.strictEqual(P.fmtPrice(2500), '$2,500.00');
    assert.strictEqual(P.fmtPrice(null), null);
    console.log('✓ dollars: unknown → "—", tiny → still visible, big → grouped');
  }

  /* --- 4. the model from a real server answer --- */
  {
    const answer = {
      ok: true, network: 'mainnet', address: '1J2gZWvrR23739vw3y9s8J5DKj7hbJnDv7', mana: 4.2,
      prices: {
        koinUsd: { value: 0.0102, source: 'uniswap vKOIN/USDT', at: 1, stale: false },
        vhpUsd: { value: 0.0098, source: 'koindx koin/vhp × uniswap vKOIN/USDT', at: 1, stale: false },
        vhpKoin: { value: 0.96, source: 'koindx koin/vhp', at: 1, stale: false },
        ethUsd: { value: 2500, source: 'uniswap WETH/USDT', at: 1, stale: false },
      },
      assets: [
        { id: 'koin', symbol: 'KOIN', name: 'Koin', decimals: 8, native: true, sats: '12419000001', amount: '124.19000001', usd: 1.2667 },
        { id: 'vhp', symbol: 'VHP', name: 'Virtual Hash Power', decimals: 8, native: true, sats: '4000000000', amount: '40', usd: 0.392 },
        { id: '1Tok', symbol: 'RKT', name: 'Rocket', address: '1Tok', decimals: 4, native: false, sats: '250000', amount: '25', usd: null },
      ],
      totalUsd: 1.6587, allPriced: false,
    };
    const m = plain(P.model(answer));
    assert.strictEqual(m.koin.amountText, '124.19');
    assert.strictEqual(m.koin.usdText, '$1.27');
    assert.strictEqual(m.koin.priceText, '$0.0102');
    assert.strictEqual(m.vhp.amountText, '40');
    assert.strictEqual(m.vhp.usdText, '$0.39');
    assert.strictEqual(m.others.length, 1);
    assert.strictEqual(m.others[0].amountText, '25');
    assert.strictEqual(m.others[0].usdText, '—', 'an unpriced token shows a dash, not $0.00');
    assert.strictEqual(m.totalUsdText, '$1.66');
    assert.strictEqual(m.partialTotal, true, 'and the total admits it is partial');
    assert.strictEqual(m.priceSource, 'uniswap vKOIN/USDT');
    console.log('✓ the model prints every row correctly and flags a partial total');
  }

  /* --- 5. no prices at all --- */
  {
    const m = plain(P.model({
      prices: { koinUsd: { value: null }, vhpUsd: { value: null } },
      assets: [{ id: 'koin', symbol: 'KOIN', name: 'Koin', decimals: 8, native: true, sats: '100000000', amount: '1', usd: null }],
      totalUsd: null, allPriced: false,
    }));
    assert.strictEqual(m.totalUsdText, '—', 'no price → no dollar total, not $0.00');
    assert.strictEqual(m.koin.usdText, '—');
    assert.strictEqual(m.koin.priceText, null);
    assert.strictEqual(m.koin.amountText, '1', 'the balance itself is still shown');
    assert.strictEqual(m.partialTotal, false);
    console.log('✓ with no price feed the balance still shows and dollars are a dash');
  }

  /* --- 6. an unreadable balance is "—", not 0 --- */
  {
    const m = plain(P.model({
      prices: {}, assets: [{ id: 'koin', symbol: 'KOIN', decimals: 8, native: true, sats: null, amount: null, usd: null, unavailable: true }],
    }));
    assert.strictEqual(m.koin.amountText, '—', 'an RPC failure must not read as an empty wallet');
    assert.strictEqual(m.koin.unavailable, true);
    console.log('✓ an unreadable balance is a dash, never a zero');
  }

  /* --- 7. custom tokens: validated, capped, deduplicated, persisted --- */
  {
    const GOOD = '1J2gZWvrR23739vw3y9s8J5DKj7hbJnDv7';
    assert.deepStrictEqual(plain(P.customTokens()), []);
    assert.deepStrictEqual(plain(P.addToken(GOOD)), [GOOD]);
    assert.deepStrictEqual(plain(P.addToken(GOOD)), [GOOD], 'adding twice keeps one');
    assert.throws(() => P.addToken('0xdeadbeef'), /not a Koinos contract address/);
    assert.throws(() => P.addToken(''), /not a Koinos/);
    assert.deepStrictEqual(plain(P.removeToken(GOOD)), []);
    /* Synthetic addresses drawn from the base58 alphabet (no 0, O, I, l). */
    const fake = (i) => '1' + 'BCDEFGHJKLMNPQRSTUVWXYZ'[i] + 'abcdefghijkmnopqrstuvwxyzABC';
    for (let i = 0; i < P.MAX_TOKENS; i++) P.addToken(fake(i));
    assert.strictEqual(P.customTokens().length, P.MAX_TOKENS);
    assert.throws(() => P.addToken(fake(P.MAX_TOKENS)), /up to/);
    console.log('✓ custom tokens are validated, deduplicated, capped and persisted');
  }

  console.log('\nALL PORTFOLIO-MODEL CHECKS PASSED');
})();
