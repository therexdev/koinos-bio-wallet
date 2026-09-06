"use strict";

// Reading a Solana balance over plain JSON-RPC, with no Solana packages.
//
// Seeing what is at your own deposit address is not the same job as bridging
// it, and it must not depend on the machinery that bridges. @solana/web3.js
// and the Wormhole SDK are optional here (see keys.js for the same argument
// about the address itself); a balance is one HTTP request, so this file makes
// it with `fetch` and nothing else. If those packages are missing, the wrong
// Node version, or half-installed, a person still sees their money.

const { solanaRpcCandidates } = require("./sol-constants");

async function call(url, method, params, fetchImpl) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`Solana RPC ${method}: HTTP ${res.status}`);
  const j = await res.json();
  if (j && j.error) throw new Error(`Solana RPC ${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j ? j.result : null;
}

/** Try each endpoint in turn; the last error is the one worth reporting. */
async function anyRpc(method, params, { urls, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!fetchImpl) throw new Error("no fetch available for the Solana RPC");
  const list = urls && urls.length ? urls : solanaRpcCandidates();
  let lastErr;
  for (const url of list) {
    try { return await call(url, method, params, fetchImpl); }
    catch (e) { lastErr = e; }
  }
  throw new Error(String((lastErr && lastErr.message) || lastErr || "no Solana RPC reachable"));
}

/** Lamports held by `address`. */
async function solBalance(address, opts) {
  const r = await anyRpc("getBalance", [String(address), { commitment: "confirmed" }], opts);
  return BigInt((r && r.value) || 0);
}

/** Base units of `mint` held by `owner`, summed across its token accounts. */
async function tokenBalance(mint, owner, opts) {
  const r = await anyRpc(
    "getTokenAccountsByOwner",
    [String(owner), { mint: String(mint) }, { encoding: "jsonParsed", commitment: "confirmed" }],
    opts,
  );
  let total = 0n;
  for (const a of (r && r.value) || []) {
    const amt = a && a.account && a.account.data && a.account.data.parsed
      && a.account.data.parsed.info && a.account.data.parsed.info.tokenAmount
      && a.account.data.parsed.info.tokenAmount.amount;
    if (amt != null) total += BigInt(amt);
  }
  return total;
}

/** Base units in one specific token account (the bridge spends from the ATA). */
async function accountBalance(address, opts) {
  try {
    const r = await anyRpc("getTokenAccountBalance", [String(address), { commitment: "confirmed" }], opts);
    return BigInt((r && r.value && r.value.amount) || 0);
  } catch (e) {
    if (/could not find account|invalid param|not found/i.test(String(e.message || e))) return 0n;
    throw e;
  }
}

async function latestBlockhash(opts) {
  const r = await anyRpc("getLatestBlockhash", [{ commitment: "confirmed" }], opts);
  return { blockhash: r.value.blockhash, lastValidBlockHeight: Number(r.value.lastValidBlockHeight) };
}

const blockHeight = async (opts) => Number(await anyRpc("getBlockHeight", [{ commitment: "confirmed" }], opts));

/** Send a signed transaction. Preflight stays on: one that would fail is
    refused before it costs anything. */
async function sendRaw(raw, opts) {
  return anyRpc("sendTransaction", [Buffer.from(raw).toString("base64"),
    { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }], opts);
}

/** null while unknown, { confirmed:true } once in a confirmed block,
    { confirmed:false, err } when it failed. History is searched, so a
    signature is never "unknown" merely because a cache rolled over. */
async function signatureStatus(sig, opts) {
  const r = await anyRpc("getSignatureStatuses", [[String(sig)], { searchTransactionHistory: true }], opts);
  const st = r && r.value && r.value[0];
  if (!st) return null;
  if (st.err) return { confirmed: false, err: JSON.stringify(st.err) };
  const ok = st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized";
  return ok ? { confirmed: true } : null;
}

const getTransaction = (sig, opts) => anyRpc("getTransaction",
  [String(sig), { maxSupportedTransactionVersion: 0, commitment: "confirmed", encoding: "json" }], opts);

/** Successful signatures for an address, newest first, with block times. */
async function recentSignatures(address, limit = 25, opts) {
  const r = await anyRpc("getSignaturesForAddress", [String(address), { limit }, { commitment: "confirmed" }], opts);
  return (r || []).filter((x) => !x.err).map((x) => ({ signature: x.signature, blockTime: x.blockTime == null ? null : Number(x.blockTime) }));
}

/** A priority fee: the median of what the network paid recently, clamped. */
async function priorityFeeMicroLamports({ min = 1000, max = 1000000, ...opts } = {}) {
  try {
    const r = await anyRpc("getRecentPrioritizationFees", [[]], opts);
    const fees = (r || []).map((f) => Number(f.prioritizationFee)).filter((n) => isFinite(n)).sort((a, b) => a - b);
    if (!fees.length) return min;
    return Math.min(max, Math.max(min, Math.floor(fees[Math.floor(fees.length / 2)])));
  } catch (_) { return min; }
}

/** How much of `mint` a confirmed transaction delivered to `owner`, read from
    the transaction's own balance meta — exact, and never behind a node. */
async function deliveredByTx(sig, mint, owner, opts) {
  const tx = await getTransaction(sig, opts);
  if (!tx || !tx.meta) return null;
  const mine = (b) => b && b.mint === mint && b.owner === owner && b.uiTokenAmount && b.uiTokenAmount.amount != null;
  const pre = (tx.meta.preTokenBalances || []).filter(mine);
  const post = (tx.meta.postTokenBalances || []).filter(mine);
  if (!pre.length && !post.length) return null;
  const sum = (l) => l.reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(post) - sum(pre);
}

/** The Wormhole sequence a transaction posted, from its own log line. */
async function wormholeSequenceFromTx(sig, opts) {
  const tx = await getTransaction(sig, opts);
  if (!tx || !tx.meta) return null;
  for (const line of tx.meta.logMessages || []) {
    const m = /^Program log: Sequence: (\d+)/.exec(line);
    if (m) return m[1];
  }
  return null;
}

module.exports = {
  solBalance, tokenBalance, accountBalance, anyRpc, latestBlockhash, blockHeight, sendRaw,
  signatureStatus, getTransaction, recentSignatures, priorityFeeMicroLamports, deliveredByTx,
  wormholeSequenceFromTx,
};
