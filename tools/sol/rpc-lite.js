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

module.exports = { solBalance, tokenBalance, anyRpc };
