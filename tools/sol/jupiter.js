"use strict";

// Jupiter swap API client for the SOL → vKOIN leg.
//
// Two calls: /quote prices an exact-in swap and returns the route Jupiter
// would take (for us: through the Raydium KOIN/SOL pool), /swap turns that
// quote into a signed-by-nobody transaction for our transit key to sign. The
// min-out (`otherAmountThreshold`) is enforced INSIDE the transaction, so the
// swap can only ever deliver at least what it quoted less the slippage.
//
// `fetch` is injectable so the parsers and request shapes are testable with
// no network; everything that touches the wire is here.

const { JUPITER, WSOL_MINT, VKOIN_SOL_MINT } = require("./sol-constants");

function headers() {
  const h = { accept: "application/json" };
  if (JUPITER.apiKey) h["x-api-key"] = JUPITER.apiKey;
  return h;
}

async function call(fetchImpl, url, init) {
  const res = await fetchImpl(url, init);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) { /* not JSON */ }
  if (!res.ok) {
    const msg = (body && (body.error || body.message)) || text.slice(0, 200) || `HTTP ${res.status}`;
    const e = new Error(`Jupiter: ${msg}`);
    e.status = res.status;
    throw e;
  }
  if (!body) throw new Error("Jupiter: empty reply");
  return body;
}

/** Build the /quote URL (pure). */
function quoteUrl({ inputMint = WSOL_MINT, outputMint = VKOIN_SOL_MINT, amount, slippageBps, api = JUPITER.api }) {
  const q = new URLSearchParams({
    inputMint, outputMint, amount: String(amount), slippageBps: String(slippageBps),
    swapMode: "ExactIn",
    /* Only routes through well-known intermediate tokens — no exotic hops
       that quote well and then fail to execute. */
    restrictIntermediateTokens: "true",
  });
  return `${api}/quote?${q.toString()}`;
}

/** What the rail needs from a quote reply (pure). */
function parseQuote(j) {
  if (!j || typeof j !== "object") throw new Error("Jupiter: malformed quote");
  const out = BigInt(j.outAmount || 0);
  const min = BigInt(j.otherAmountThreshold || 0);
  if (out <= 0n) throw new Error("Jupiter: no route for that amount");
  const labels = Array.isArray(j.routePlan)
    ? j.routePlan.map((s) => s && s.swapInfo && s.swapInfo.label).filter(Boolean)
    : [];
  return {
    inAmount: String(j.inAmount || ""),
    outAmount: out.toString(),
    outAmountMin: (min > 0n && min <= out ? min : out).toString(),
    priceImpactPct: j.priceImpactPct != null && isFinite(Number(j.priceImpactPct)) ? Number(j.priceImpactPct) * 100 : null,
    via: [...new Set(labels)],
    raw: j,
  };
}

/** Quote an exact-in swap. `amount` in base units of the input mint. */
async function quote({ amount, slippageBps, inputMint, outputMint, fetch: fetchImpl = globalThis.fetch }) {
  if (!fetchImpl) throw new Error("no fetch available for the Jupiter API");
  const j = await call(fetchImpl, quoteUrl({ amount, slippageBps, inputMint, outputMint }), { headers: headers() });
  return parseQuote(j);
}

/** The /swap request body (pure). */
function swapBody({ quoteResponse, userPublicKey, maxPriorityLamports = 500000 }) {
  return {
    quoteResponse,
    userPublicKey,
    /* Native SOL in, so Jupiter wraps to wSOL and unwraps any remainder. */
    wrapAndUnwrapSol: true,
    /* Simulate for the real compute-unit need instead of the 1.4M default,
       which is what makes the priority fee affordable. */
    dynamicComputeUnitLimit: true,
    /* Pay for inclusion, but never more than this many lamports. */
    prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: maxPriorityLamports, priorityLevel: "high" } },
  };
}

/** What the rail needs from a /swap reply (pure). */
function parseSwap(j) {
  if (!j || typeof j !== "object" || !j.swapTransaction) throw new Error("Jupiter: no swap transaction in the reply");
  return {
    swapTransaction: String(j.swapTransaction), // base64 VersionedTransaction
    lastValidBlockHeight: j.lastValidBlockHeight != null ? Number(j.lastValidBlockHeight) : null,
  };
}

/** Turn a quote into an unsigned transaction for `userPublicKey`. */
async function swapTx({ quote: q, userPublicKey, fetch: fetchImpl = globalThis.fetch }) {
  if (!fetchImpl) throw new Error("no fetch available for the Jupiter API");
  const j = await call(fetchImpl, `${JUPITER.api}/swap`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify(swapBody({ quoteResponse: q.raw, userPublicKey })),
  });
  return parseSwap(j);
}

module.exports = { quote, swapTx, quoteUrl, parseQuote, swapBody, parseSwap };
