/* ============================================================
   Koinos chain facade for the Bio Wallet — the slim, battle-tested
   subset of the Discover Koinos gateway's facade.

   The model:
     · The visitor's key lives in (and is re-derivable from) their
       passkey. The browser signs; the server never sees a key.
     · The SPONSOR wallet pays for everything through mana sharing:
       every transaction is payer = sponsor, payee = visitor, so the
       visitor's balance is never touched by fees — there are none.
     · The server builds the EXACT transaction (prepareUserTx), the
       browser signs it, the server verifies id + header + signature
       byte-for-byte (submitCosigned), co-signs as payer, broadcasts.

   Send-path hardening carried over from the gateway (learned on
   mainnet): a node's "request timeout" reply does not mean rejection —
   waitMined() is the arbiter; every poll error is transient; error
   bodies are unwrapped to human text.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { Signer, Provider, Contract, Transaction, utils } = require('koilib');
const { NETWORKS, rpcCandidates } = require('./rpc');

function sanitizeAbi(abi) {
  const out = JSON.parse(JSON.stringify(abi));
  const koinos = out.koilib_types?.nested?.koinos?.nested;
  if (koinos) { delete koinos.btype; delete koinos._btype; }
  return out;
}
const TOKEN_ABI = sanitizeAbi(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'abi', 'token-abi.json'))));

const K = {
  network: 'harbinger',
  rpcs: [],
  sponsorWif: '',
  /* rc_limit CEILING for a co-signed transfer — mana is only charged for
     what the transaction actually burns (~0.3–1 KOIN for a transfer). */
  rcLimit: '300000000',
};

let _provider = null, _sponsor = null, _sponsorAddr = '', _chainId = '';

function configure(opts) {
  Object.assign(K, opts || {});
  if (!K.rpcs.length) K.rpcs = rpcCandidates(K.network);
  _provider = null; _sponsor = null; _sponsorAddr = ''; _chainId = '';
}

const net = () => NETWORKS[K.network];
const enabled = () => !!K.sponsorWif;

function provider() {
  if (!_provider) {
    _provider = new Provider(K.rpcs.slice());
    // koilib's fetch has no timeout: race every call against a 25s clock.
    const rawCall = _provider.call.bind(_provider);
    _provider.call = (method, params) => Promise.race([
      rawCall(method, params),
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error(`koinos rpc timeout (${method})`)), 25000);
        if (t.unref) t.unref();
      }),
    ]);
  }
  return _provider;
}

function sponsor() {
  if (!_sponsor && K.sponsorWif) {
    _sponsor = Signer.fromWif(K.sponsorWif);
    _sponsor.provider = provider();
  }
  return _sponsor;
}
function sponsorAddress() {
  if (!_sponsorAddr && K.sponsorWif) _sponsorAddr = Signer.fromWif(K.sponsorWif).getAddress();
  return _sponsorAddr || null;
}

function isAddr(a) {
  const s = String(a || '');
  if (!/^1[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(s)) return false;
  try { return utils.decodeBase58(s).length >= 20 && utils.isChecksumAddress(s); }
  catch (_) { return false; }
}

async function chainId() {
  if (!_chainId) _chainId = await provider().getChainId();
  return _chainId;
}

/* ---------------- reads ---------------- */

const koinContract = () => new Contract({ id: net().koinContract, abi: TOKEN_ABI, provider: provider() });

async function koinBalance(addr) {
  const { result } = await koinContract().functions.balance_of({ owner: addr });
  return Number(result?.value || 0) / 1e8;
}
async function koinBalanceSats(addr) {
  const { result } = await koinContract().functions.balance_of({ owner: addr });
  return String(result?.value || '0');
}
async function mana(addr) {
  const rc = await provider().getAccountRc(addr);
  return Number(rc) / 1e8;
}
async function headInfo() {
  return provider().call('chain.get_head_info', {});
}

/* ---------------- error + confirmation hardening ---------------- */

function humanChainError(e) {
  let msg = String((e && e.message) || e || 'transaction failed');
  for (let i = 0; i < 3; i++) {
    try {
      const j = JSON.parse(msg);
      if (j && typeof j.error === 'string') { msg = j.error; continue; }
      if (j && j.error && typeof j.error.message === 'string') { msg = j.error.message; continue; }
    } catch (_) {}
    break;
  }
  return msg;
}

const TRANSIENT_SEND = /request timeout|timed? ?out|unexpected token|invalid json|fetch|network|econn|socket|hang up|abort|bad gateway|gateway time|service unavailable|too many request|(^|[^0-9])(429|500|502|503|504)([^0-9]|$)/i;

async function sendTolerant(tx) {
  try { await tx.send(); }
  catch (e) {
    const msg = humanChainError(e);
    if (!TRANSIENT_SEND.test(msg)) { const err = new Error(msg); err.cause = e; throw err; }
    // Ambiguous — the mined-check below is the arbiter.
  }
}

async function waitMined(txId, timeoutMs = 90000) {
  const p = provider();
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const { transactions } = await p.getTransactionsById([txId]);
      const t = transactions && transactions[0];
      if (t && t.containing_blocks && t.containing_blocks.length) return { blockId: t.containing_blocks[0] };
    } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, 2500));
  }
  const why = lastErr ? ` (last poll error: ${humanChainError(lastErr).slice(0, 120)})` : '';
  throw new Error(`not seen in a block within ${Math.round(timeoutMs / 1000)}s${why}`);
}

/* ---------------- the co-sign pipeline ---------------- */

let _txQueue = Promise.resolve();
function queueTx(fn) {
  const run = _txQueue.then(fn, fn);
  _txQueue = run.catch(() => {});
  return run;
}

async function opKoinTransfer(from, to, valueSats) {
  const { operation } = await koinContract().functions.transfer(
    { from, to, value: String(valueSats) }, { onlyOperation: true });
  return operation;
}

/** Build the exact transaction the visitor must sign: sponsor pays,
    visitor is payee (their nonce, their authority). */
async function prepareUserTx(userAddr, ops) {
  const tx = new Transaction({
    provider: provider(),
    options: { payer: sponsorAddress(), payee: userAddr, rcLimit: K.rcLimit },
  });
  for (const op of ops) await tx.pushOperation(op);
  await tx.prepare({ chainId: await chainId() });
  return tx.transaction;
}

/** Verify the visitor-signed copy is byte-identical to what we prepared,
    co-sign as payer, broadcast, resolve once mined. */
async function submitCosigned(signedTx, preparedId, userAddr) {
  if (!signedTx || signedTx.id !== preparedId) throw new Error('transaction does not match the prepared action');
  const recomputed = Transaction.computeTransactionId(signedTx.header);
  if (recomputed !== preparedId) throw new Error('transaction header was altered');
  const signers = await Signer.recoverAddresses(signedTx);
  if (!signers.includes(userAddr)) throw new Error('missing your signature');
  const clean = {
    id: signedTx.id, header: signedTx.header,
    operations: signedTx.operations, signatures: signedTx.signatures,
  };
  return queueTx(async () => {
    await sponsor().signTransaction(clean);
    const tx = new Transaction({ provider: provider() });
    tx.transaction = clean;
    await sendTolerant(tx);
    try { await waitMined(clean.id); }
    catch (e) {
      const err = new Error(`transaction ${clean.id} not confirmed: ${humanChainError(e)}`);
      err.txId = clean.id;
      err.broadcast = true;
      throw err;
    }
    return clean.id;
  });
}

/** Does this signature over `message` belong to `addr`?
    (signMessage = sign(sha256(message)) in koilib.) */
function verifyAuthSignature(message, signatureB64, addr) {
  try {
    const sig = new Uint8Array(Buffer.from(String(signatureB64), 'base64'));
    const hash = new Uint8Array(require('crypto').createHash('sha256').update(message).digest());
    return Signer.recoverAddress(hash, sig) === addr;
  } catch (_) { return false; }
}

module.exports = {
  configure, net, enabled, K,
  provider, sponsor, sponsorAddress, isAddr, chainId,
  koinBalance, koinBalanceSats, mana, headInfo,
  humanChainError, waitMined,
  opKoinTransfer, prepareUserTx, submitCosigned, verifyAuthSignature,
};
