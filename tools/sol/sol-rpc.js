"use strict";

// Solana reads and sends for the transit key.
//
// Everything here now runs on tools/sol/{rpc-lite,solana-lite,keys}.js — plain
// JSON-RPC and Node's own crypto — so the rail works on any Node 18 with no
// Solana packages installed. Those primitives are checked byte-for-byte
// against @solana/web3.js in tests/solana-lite.test.js.
//
// The "connection" is just the endpoint list, kept as an object so callers
// read the same as before.

const L = require("./solana-lite");
const rpc = require("./rpc-lite");
const keys = require("./keys");
const { solanaRpcCandidates } = require("./sol-constants");

/** Pick an endpoint that answers. Costs one request, then it is remembered. */
async function makeConnection(urls = solanaRpcCandidates()) {
  let lastErr;
  for (const url of urls) {
    try {
      await rpc.blockHeight({ urls: [url] });
      return { rpcEndpoint: url, urls: [url] };
    } catch (e) { lastErr = e; }
  }
  throw new Error(`No Solana RPC reachable: ${(lastErr && lastErr.message) || lastErr}`);
}
const at = (c) => (c && c.urls ? { urls: c.urls } : undefined);

const newKeypair = keys.newKeypair;
const keypairFrom = (secret) => ({ secret, address: keys.addressOf(secret) });
const isAddress = (s) => keys.looksLikeAddress(s) && L.isOnCurve(L.b58.decode(String(s)));
const ataAddress = (mint, owner) => L.associatedTokenAddress(mint, owner);

const solBalance = (c, address) => rpc.solBalance(address, at(c));
const tokenBalance = (c, mint, owner) => rpc.tokenBalance(mint, owner, at(c));
const ataBalance = (c, mint, owner) => rpc.accountBalance(ataAddress(mint, owner), at(c));
const signatureStatus = (c, sig) => rpc.signatureStatus(sig, at(c));
const blockHeight = (c) => rpc.blockHeight(at(c));
const deliveredByTx = (c, sig, mint, owner) => rpc.deliveredByTx(sig, mint, owner, at(c));
const sendRaw = (c, raw) => rpc.sendRaw(raw, at(c));
const priorityFeeMicroLamports = (c, opts = {}) => rpc.priorityFeeMicroLamports({ ...opts, ...at(c) });
const recentSignatures = async (c, address, limit = 25) =>
  (await rpc.recentSignatures(address, limit, at(c))).map((s) => s.signature);
const scopeSignatures = (list, { stopAt, since } = {}) => {
  const out = [];
  for (const s of list || []) {
    const sig = typeof s === "string" ? s : s.signature;
    const t = typeof s === "string" ? null : s.blockTime;
    if (stopAt && sig === stopAt) break;
    if (since && t && t < since) break;
    out.push(sig);
  }
  return out;
};

/** Sign a transaction built elsewhere (Jupiter's swap) and send it. */
async function signAndSend(c, secret, base64Tx) {
  const { raw, signature } = L.signSerialized(base64Tx, typeof secret === "string" ? secret : secret.secret);
  await rpc.sendRaw(raw, at(c));
  return signature;
}

module.exports = {
  makeConnection, newKeypair, keypairFrom, isAddress, ataAddress, solBalance, tokenBalance, ataBalance,
  signatureStatus, blockHeight, deliveredByTx, signAndSend, sendRaw, recentSignatures, scopeSignatures,
  priorityFeeMicroLamports,
};
