"use strict";

// Solana reads and sends for the transit key: balances, signature status,
// what a confirmed transaction delivered, and signing a Jupiter swap.
// Nothing here knows about jobs; tools/funding.js does the deciding.

const { Connection, Keypair, PublicKey, VersionedTransaction } = require("@solana/web3.js");

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const koilib = require("koilib");
const C = require("./sol-constants");

/** First reachable RPC from the candidate list (SOLANA_RPC first). */
async function makeConnection(urls = C.solanaRpcCandidates()) {
  let lastErr;
  for (const url of urls) {
    try {
      const conn = new Connection(url, { commitment: "confirmed", disableRetryOnRateLimit: true });
      await conn.getSlot(); // liveness probe
      return conn;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`No Solana RPC reachable: ${(lastErr && lastErr.message) || lastErr}`);
}

/** A fresh transit keypair. The secret is the 64-byte key in base58 — the
    form every Solana wallet imports — and lives in data/funding.json next to
    the account's Ethereum transit key, with the same 0600 custody. */
function newKeypair() {
  const kp = Keypair.generate();
  return { solAddress: kp.publicKey.toBase58(), solSecret: koilib.utils.encodeBase58(kp.secretKey) };
}
function keypairFrom(secretB58) {
  return Keypair.fromSecretKey(koilib.utils.decodeBase58(String(secretB58)));
}
function isAddress(s) {
  try { return PublicKey.isOnCurve(new PublicKey(String(s)).toBytes()); } catch (_) { return false; }
}

/** Lamports held by `address`. */
async function solBalance(conn, address) {
  return BigInt(await conn.getBalance(new PublicKey(address), "confirmed"));
}

/** Base units of `mint` held by `owner`, across all of its token accounts. */
async function tokenBalance(conn, mint, owner) {
  const r = await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }, "confirmed");
  let total = 0n;
  for (const a of r.value || []) {
    const amt = a && a.account && a.account.data && a.account.data.parsed && a.account.data.parsed.info
      && a.account.data.parsed.info.tokenAmount && a.account.data.parsed.info.tokenAmount.amount;
    if (amt != null) total += BigInt(amt);
  }
  return total;
}

/** The associated token account of `owner` for `mint` — the one account
    the Wormhole transfer spends from. */
function ataAddress(mint, owner) {
  const [ata] = PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), new PublicKey(mint).toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata.toBase58();
}

/** Base units of `mint` in the owner's associated token account only — what
    a bridge transfer can actually move. 0 when the account does not exist. */
async function ataBalance(conn, mint, owner) {
  try {
    const r = await conn.getTokenAccountBalance(new PublicKey(ataAddress(mint, owner)), "confirmed");
    return BigInt((r && r.value && r.value.amount) || 0);
  } catch (e) {
    if (/could not find account|Invalid param|not found/i.test(String(e.message || e))) return 0n;
    throw e;
  }
}

/** Where a sent transaction stands: null while unknown, { confirmed: true }
    once it is in a confirmed block, { confirmed: false, err } if it failed.
    Searches history too, so a signature is never "unknown" merely because
    the node's recent cache rolled over. */
async function signatureStatus(conn, sig) {
  const r = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
  const s = r && r.value && r.value[0];
  if (!s) return null;
  if (s.err) return { confirmed: false, err: JSON.stringify(s.err) };
  const ok = s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized";
  return ok ? { confirmed: true } : null;
}

async function blockHeight(conn) {
  return Number(await conn.getBlockHeight("confirmed"));
}

/** How much of `mint` did a confirmed transaction deliver to `owner`?

    Read from the transaction's own token-balance meta — exact, and never
    behind, unlike a balance read against a node that has not seen the block
    yet (the Solana twin of receivedInTx on the Ethereum side). null when the
    meta says nothing about that owner and mint; the caller then falls back
    to a balance difference. */
async function deliveredByTx(conn, sig, mint, owner) {
  const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx || !tx.meta) return null;
  const mine = (b) => b && b.mint === mint && b.owner === owner && b.uiTokenAmount && b.uiTokenAmount.amount != null;
  const pre = (tx.meta.preTokenBalances || []).filter(mine);
  const post = (tx.meta.postTokenBalances || []).filter(mine);
  if (!pre.length && !post.length) return null;
  const sum = (list) => list.reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(post) - sum(pre);
}

/** Sign a Jupiter swap (a base64 v0 transaction built for our key) and send
    it. Preflight stays ON: a swap that would fail is refused by the node
    before it costs anything. Returns the signature. */
async function signAndSend(conn, keypair, base64Tx) {
  const tx = VersionedTransaction.deserialize(Buffer.from(String(base64Tx), "base64"));
  tx.sign([keypair]);
  return conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3, preflightCommitment: "confirmed" });
}

/** Send an already-signed legacy transaction (the Wormhole transfer). */
async function sendRaw(conn, raw) {
  return conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3, preflightCommitment: "confirmed" });
}

/** Recent successful transactions of `address`, newest first, with the
    block time each landed at (seconds; null when the node has none). */
async function recentSignatures(conn, address, limit = 25) {
  const r = await conn.getSignaturesForAddress(new PublicKey(address), { limit }, "confirmed");
  return (r || []).filter((s) => !s.err).map((s) => ({ signature: s.signature, blockTime: s.blockTime == null ? null : Number(s.blockTime) }));
}

/** The signatures that can belong to THIS job: newer than its swap (the
    list is newest first, so stop at the swap's own signature) and not
    before it started. Pure, so it can be pinned by a test. */
function scopeSignatures(list, { stopAt, since } = {}) {
  const out = [];
  for (const s of list || []) {
    if (stopAt && s.signature === stopAt) break;
    if (since && s.blockTime && s.blockTime < since) break;
    out.push(s.signature);
  }
  return out;
}

/** A priority fee for one of our own transactions: the median of what the
    network paid recently, clamped so a fee spike can never eat the reserve. */
async function priorityFeeMicroLamports(conn, { min = 1000, max = 1000000 } = {}) {
  try {
    const fees = (await conn.getRecentPrioritizationFees()).map((f) => Number(f.prioritizationFee)).filter((n) => isFinite(n)).sort((a, b) => a - b);
    if (!fees.length) return min;
    const med = fees[Math.floor(fees.length / 2)];
    return Math.min(max, Math.max(min, Math.floor(med)));
  } catch (_) { return min; }
}

module.exports = {
  makeConnection, newKeypair, keypairFrom, isAddress, solBalance, tokenBalance, ataAddress, ataBalance, signatureStatus, blockHeight,
  deliveredByTx, signAndSend, sendRaw, recentSignatures, scopeSignatures, priorityFeeMicroLamports,
};
