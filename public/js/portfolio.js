/* ============================================================
   The portfolio model behind the home screen.

   Fetches /api/portfolio and turns it into what the screen prints — and
   nothing else: no DOM here, so the numbers can be tested without a
   browser and the layout can change without touching them.

   Two rules the formatting enforces, because getting them wrong misleads
   people about money:

     · a price that is not known shows as "—", never as $0.00;
     · amounts are printed from the chain's integer with the token's own
       decimals, so a balance is never rounded into something it is not.

   Custom tokens (added by contract address) live in localStorage and ride
   along on the request; the server reads their name/symbol/decimals and
   balance from the chain.
   ============================================================ */
'use strict';

const Portfolio = (() => {
  const LS_TOKENS = 'bw_tokens_v1';
  const MAX_TOKENS = 12;

  /* ---- custom tokens ---- */
  function customTokens() {
    try { const v = JSON.parse(localStorage.getItem(LS_TOKENS) || '[]'); return Array.isArray(v) ? v.slice(0, MAX_TOKENS) : []; }
    catch (_) { return []; }
  }
  function addToken(addr) {
    const a = String(addr || '').trim();
    if (!/^1[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a)) throw new Error('That is not a Koinos contract address');
    const cur = customTokens();
    if (cur.includes(a)) return cur;
    if (cur.length >= MAX_TOKENS) throw new Error(`You can track up to ${MAX_TOKENS} extra tokens`);
    const next = cur.concat(a);
    try { localStorage.setItem(LS_TOKENS, JSON.stringify(next)); } catch (_) {}
    return next;
  }
  function removeToken(addr) {
    const next = customTokens().filter(x => x !== addr);
    try { localStorage.setItem(LS_TOKENS, JSON.stringify(next)); } catch (_) {}
    return next;
  }

  /* ---- formatting ---- */

  /** Exact integer → decimal string, trailing zeros trimmed. BigInt, so a
      balance beyond what a float holds still prints right. */
  function fromSats(sats, decimals) {
    if (sats == null || !/^\d+$/.test(String(sats))) return null;
    const s = BigInt(sats), d = Number(decimals) || 0;
    const base = 10n ** BigInt(d);
    const whole = s / base;
    const frac = d ? String(s % base).padStart(d, '0').replace(/0+$/, '') : '';
    return frac ? `${whole}.${frac}` : String(whole);
  }

  /** A balance for display: thousands separators, up to `dp` decimals,
      but a tiny non-zero balance never collapses to "0". */
  function fmtAmount(amountStr, dp = 4) {
    if (amountStr == null) return '—';
    const n = Number(amountStr);
    if (!Number.isFinite(n)) return String(amountStr);
    if (n === 0) return '0';
    /* The threshold is built as a string: 10**-4 is not exactly 0.0001 in
       floating point, and "<0.00009999999999999999" is not a balance. */
    if (n > 0 && n < Math.pow(10, -dp)) return '<0.' + '0'.repeat(dp - 1) + '1';
    return n.toLocaleString('en-US', { maximumFractionDigits: dp });
  }

  /** Dollars. Null → "—". Small values keep enough decimals to mean
      something (a $0.0034 token is not "$0.00"). */
  function fmtUsd(v) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    const n = Number(v);
    if (n === 0) return '$0.00';
    /* Cents are enough down to a cent; below that, keep the digits that
       make the value visible at all. */
    const dp = n >= 0.01 ? 2 : 6;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: dp });
  }

  /** A price per unit, for the row subtitle: "$0.0102". */
  function fmtPrice(v) {
    if (v == null || !Number.isFinite(Number(v))) return null;
    const n = Number(v);
    const dp = n >= 100 ? 2 : n >= 1 ? 3 : n >= 0.01 ? 4 : 6;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: dp });
  }

  /* ---- the model ---- */

  /** Shape the server's answer into rows the screen prints. */
  function model(p) {
    const prices = p.prices || {};
    const rows = (p.assets || []).map((a) => {
      const amount = a.amount != null ? a.amount : fromSats(a.sats, a.decimals);
      const price = a.id === 'koin' ? prices.koinUsd : a.id === 'vhp' ? prices.vhpUsd : null;
      return {
        id: a.id, symbol: a.symbol, name: a.name, address: a.address, decimals: a.decimals,
        native: !!a.native, sats: a.sats, amount,
        amountText: a.unavailable ? '—' : fmtAmount(amount, a.id === 'koin' || a.id === 'vhp' ? 4 : 6),
        usd: a.usd == null ? null : Number(a.usd),
        usdText: fmtUsd(a.usd),
        priceText: price && price.value != null ? fmtPrice(price.value) : null,
        priceStale: !!(price && price.stale),
        unavailable: !!a.unavailable,
        error: a.error || null,
      };
    });
    const koin = rows.find(r => r.id === 'koin') || null;
    const vhp = rows.find(r => r.id === 'vhp') || null;
    const others = rows.filter(r => r.id !== 'koin' && r.id !== 'vhp');
    return {
      demo: !!p.demo, network: p.network, address: p.address, mana: Number(p.mana || 0),
      koin, vhp, others, rows,
      totalUsd: p.totalUsd == null ? null : Number(p.totalUsd),
      totalUsdText: fmtUsd(p.totalUsd),
      allPriced: !!p.allPriced,
      /* Something is priced but not everything: say so instead of showing a
         total that quietly leaves tokens out. */
      partialTotal: p.totalUsd != null && !p.allPriced,
      priceStale: !!(prices.koinUsd && prices.koinUsd.stale),
      priceSource: prices.koinUsd && prices.koinUsd.source || null,
    };
  }

  /** Fetch + shape. Any failure resolves to a model with `error` set, so
      the screen can keep the last good numbers and show a quiet notice. */
  async function load(address, apiFn) {
    const tokens = customTokens();
    const q = '/api/portfolio?address=' + encodeURIComponent(address)
      + (tokens.length ? '&tokens=' + encodeURIComponent(tokens.join(',')) : '');
    try {
      const p = await apiFn(q);
      return model(p);
    } catch (e) {
      return { error: String(e && e.message || e), rows: [], others: [], koin: null, vhp: null, totalUsdText: '—' };
    }
  }

  return { load, model, fromSats, fmtAmount, fmtUsd, fmtPrice, customTokens, addToken, removeToken, MAX_TOKENS };
})();
