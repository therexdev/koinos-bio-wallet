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
const { Signer, Provider, Contract, Transaction, Serializer, utils } = require('koilib');
const { NETWORKS, rpcCandidates } = require('./rpc');

function sanitizeAbi(abi) {
  const out = JSON.parse(JSON.stringify(abi));
  const koinos = out.koilib_types?.nested?.koinos?.nested;
  if (koinos) { delete koinos.btype; delete koinos._btype; }
  return out;
}
const TOKEN_ABI = sanitizeAbi(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'abi', 'token-abi.json'))));

/* The Veive smart-account artifacts (see contracts/README.md for provenance). */
const VENDOR = path.join(__dirname, '..', 'contracts', 'vendor');
const ACCOUNT_ABI = sanitizeAbi(JSON.parse(fs.readFileSync(path.join(VENDOR, 'account', 'account-abi.json'))));
const MODSIGN_ABI = sanitizeAbi(JSON.parse(fs.readFileSync(path.join(VENDOR, 'mod-sign-webauthn', 'modsignwebauthn-abi.json'))));
const MODVAL_ABI = sanitizeAbi(JSON.parse(fs.readFileSync(path.join(VENDOR, 'mod-validation-signature', 'modvalidationsignature-abi.json'))));
const ACCOUNT_WASM_PATH = path.join(VENDOR, 'account', 'Account.wasm');

const K = {
  network: 'harbinger',
  rpcs: [],
  sponsorWif: '',
  /* rc_limit CEILING for a co-signed transfer — mana is only charged for
     what the transaction actually burns (~0.3–1 KOIN for a transfer). */
  rcLimit: '300000000',
  /* Ceilings for the smart-account paths. Uploading the 97KB Account.wasm
     burns ~75 mana; a passkey-signed transfer runs the on-chain WebAuthn
     verification (validator → account → sign module → P-256 verifier),
     which costs more compute than a plain transfer. */
  rcLimitUpload: '12000000000',
  rcLimitSmart: '2000000000',
  /* Our deployed module addresses (tools/infra-deploy.js). All three set
     ⇒ the wallet creates Veive-style smart accounts. */
  modules: { verifier: '', modSign: '', modValidation: '' },
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

/** Retry a read/build-only chain call through transient RPC noise (an HTML
    error page, a timeout, a 5xx). Only for idempotent work — never sends. */
async function withRpcRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1200 * i));
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (!TRANSIENT_SEND.test(humanChainError(e))) throw e;
    }
  }
  throw lastErr;
}

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
async function prepareUserTx(userAddr, ops, { rcLimit = K.rcLimit } = {}) {
  const tx = new Transaction({
    provider: provider(),
    options: { payer: sponsorAddress(), payee: userAddr, rcLimit },
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

/* ============================================================
   The Veive smart-account layer.

   Every wallet is its own on-chain contract (Veive's audited
   Account.wasm, uploaded with all three authorize overrides), with
   two modules installed from our shared deployments:
     · mod-sign-webauthn (type 3) — verifies passkey assertions via the
       P-256 verifier contract; the user's credential is registered here.
     · mod-validation-signature (type 1) — routes every authority check
       (contract_call, contract_upload, transaction_application) into
       signature validation with threshold 1.
   After bootstrap the ONLY thing that can move the account is a WebAuthn
   assertion over the transaction id — verified by the chain itself.

   Bootstrap is driven by a throwaway secp256k1 key (the account address
   IS that key's address): while no validator module is installed the
   account contract falls back to checking transaction signatures against
   its own address, exactly how Veive's own test suite installs modules.
   Once the validator lands, that key is powerless; we keep it only to
   heal interrupted bootstraps.
   ============================================================ */

const MODULE_TYPE_VALIDATION = 1;
const MODULE_TYPE_SIGN = 3;

function veiveReady() {
  return enabled() && !!(K.modules.modSign && K.modules.modValidation);
}

const accountContractAt = (addr) => new Contract({ id: addr, abi: ACCOUNT_ABI, provider: provider() });
const modSignContract = () => new Contract({ id: K.modules.modSign, abi: MODSIGN_ABI, provider: provider() });

let _modSignSer = null, _modValSer = null;
const modSignSerializer = () => (_modSignSer ||= new Serializer(MODSIGN_ABI.koilib_types));
const modValSerializer = () => (_modValSer ||= new Serializer(MODVAL_ABI.koilib_types));

async function opUploadContract(contractId, wasmBuffer, flags) {
  const op = {
    upload_contract: {
      contract_id: contractId,
      /* koilib's own encoder — the node's JSON codec wants PADDED base64url. */
      bytecode: utils.encodeBase64url(wasmBuffer),
    },
  };
  /* contractAuthority hands ALL authority checks to the uploaded contract's
     own authorize() — for the Veive account that is the module router. */
  if (flags && flags.contractAuthority) {
    op.upload_contract.authorizes_call_contract = true;
    op.upload_contract.authorizes_transaction_application = true;
    op.upload_contract.authorizes_upload_contract = true;
  }
  return op;
}

/** install_module wrapped in execute_user — the account executes the
    install on itself (Veive's own installation pattern). */
async function opInstallModule(accountAddr, moduleTypeId, moduleAddr, scopes) {
  const acct = accountContractAt(accountAddr).functions;
  const args = { module_type_id: moduleTypeId, contract_id: moduleAddr };
  if (scopes && scopes.length) args.scopes = scopes;
  const { operation: im } = await acct.install_module(args, { onlyOperation: true });
  const { operation: exec } = await acct.execute_user({
    operation: {
      contract_id: im.call_contract.contract_id,
      entry_point: im.call_contract.entry_point,
      args: im.call_contract.args,
    },
  }, { onlyOperation: true });
  return exec;
}

/** register the passkey credential on the sign module — a DIRECT call
    (not execute_user), authorized by the account (Veive's pattern). */
async function opRegisterCredential(accountAddr, credential) {
  const { operation } = await modSignContract().functions.register({
    user: accountAddr,
    credential: {
      credential_id: credential.credential_id,
      public_key: credential.public_key,
      name: credential.name || 'passkey',
    },
  }, { onlyOperation: true });
  return operation;
}

/** The validator's scopes: govern every kind of authority check. */
let _scopes = null;
async function defaultScopes() {
  if (!_scopes) {
    const ser = modValSerializer();
    const list = [];
    for (const operation_type of ['contract_call', 'contract_upload', 'transaction_application']) {
      list.push(utils.encodeBase64url(await ser.serialize({ operation_type }, 'scope')));
    }
    _scopes = list;
  }
  return _scopes;
}

/** Sponsor-paid transaction signed by an account key (bootstrap phase):
    payer = sponsor, payee = the account (its nonce, its authority). */
async function sendAsAccount(key, ops, { rcLimit = K.rcLimit } = {}) {
  key.provider = provider();
  return queueTx(async () => {
    const tx = new Transaction({
      signer: key, provider: provider(),
      options: { payer: sponsorAddress(), payee: key.getAddress(), rcLimit },
    });
    for (const op of ops) await tx.pushOperation(op);
    await tx.prepare();
    await tx.sign();
    /* Sponsor's signature must come FIRST: the chain's payer check walks
       signatures in order doing secp256k1 recovery and stops at the first
       match — and it REJECTS the transaction outright if it trips over a
       non-recoverable entry before matching. Order is load-bearing. */
    const userSigs = tx.transaction.signatures.slice();
    tx.transaction.signatures = [];
    await sponsor().signTransaction(tx.transaction);
    tx.transaction.signatures = tx.transaction.signatures.concat(userSigs);
    const send = new Transaction({ provider: provider() });
    send.transaction = tx.transaction;
    await sendTolerant(send);
    try { await waitMined(tx.transaction.id); }
    catch (e) {
      const err = new Error(`transaction ${tx.transaction.id} not confirmed: ${humanChainError(e)}`);
      err.txId = tx.transaction.id;
      err.broadcast = true;
      throw err;
    }
    return tx.transaction.id;
  });
}

/** Setup transaction for an account that cannot yet authorize anything.

    Uploading Account.wasm with all three authorize overrides routes EVERY
    authority check into the account's authorize() — which, with no modules
    installed, cannot approve its own setup. Veive's own e2e sidesteps this
    by making the account the transaction's PAYER (one check, which an
    unconfigured account grants); we can't, because a new account has no
    mana. So the sponsor is payer AND payee here: the account is neither, so
    the chain never asks it to authorize the transaction at all — only the
    contract_call authority inside, which an unconfigured account grants
    ("[account] no validation found, skip"). The account key co-signs too,
    so any signature-based check inside also passes.

    This ordering is load-bearing: the ops install the sign module and
    register the credential BEFORE the validator, so every op runs while the
    account still grants contract_call. Once the validator lands, the
    passkey governs — including this very path. */
async function sendAsSponsorFor(key, ops, { rcLimit = K.rcLimit } = {}) {
  if (key) key.provider = provider();
  return queueTx(async () => {
    const tx = new Transaction({
      signer: sponsor(), provider: provider(),
      options: { payer: sponsorAddress(), rcLimit },
    });
    for (const op of ops) await tx.pushOperation(op);
    await tx.prepare();
    await tx.sign();                            // sponsor first: the payer check stops here
    if (key) await key.signTransaction(tx.transaction); // account key, belt and braces
    const send = new Transaction({ provider: provider() });
    send.transaction = tx.transaction;
    await sendTolerant(send);
    try { await waitMined(tx.transaction.id); }
    catch (e) {
      const err = new Error(`transaction ${tx.transaction.id} not confirmed: ${humanChainError(e)}`);
      err.txId = tx.transaction.id;
      err.broadcast = true;
      throw err;
    }
    return tx.transaction.id;
  });
}

const MISSING_CONTRACT = /not exist|not found|unable to find|invalid contract|no contract/i;
/* mod-sign-webauthn declares get_credentials read-only, but it lazily
   assigns the caller's storage space and therefore WRITES the first time it
   sees a user — the chain rejects that in a read context. Upstream bug; we
   read the credential→address index instead (a plain map lookup) and treat
   this error as "nothing registered yet". */
const READ_ONLY_WRITE = /read only call|cannot put object/i;

/** Addresses of modules installed on an account — [] for a bare contract,
    null when no contract lives at the address yet. */
async function accountModules(addr) {
  try {
    const { result } = await accountContractAt(addr).functions.get_modules({});
    return (result && result.value) || [];
  } catch (e) {
    if (MISSING_CONTRACT.test(humanChainError(e))) return null;
    throw e;
  }
}

/** Credentials registered for an account on OUR sign module. */
async function accountCredentials(addr) {
  try {
    const { result } = await modSignContract().functions.get_credentials({ user: addr });
    return (result && result.value) || [];
  } catch (e) {
    const msg = humanChainError(e);
    if (MISSING_CONTRACT.test(msg) || READ_ONLY_WRITE.test(msg)) return [];
    throw e;
  }
}

/** Is this credential registered to this account? Uses the credential→address
    index, which is a plain map read (see READ_ONLY_WRITE above). */
async function credentialRegisteredFor(address, credentialId) {
  const owner = await credentialAddress(credentialId);
  return owner === address;
}

/** Reverse lookup: which account does a credential belong to? */
async function credentialAddress(credentialId) {
  try {
    const { result } = await modSignContract().functions.get_address_by_credential_id({ credential_id: credentialId });
    return (result && result.value) || null;
  } catch (e) {
    const msg = humanChainError(e);
    if (MISSING_CONTRACT.test(msg) || READ_ONLY_WRITE.test(msg)) return null;
    throw e;
  }
}

/** Drive an account from any half-done state to fully bootstrapped.
    Reads the chain to decide what is missing, so it heals interrupted
    attempts; each transaction is atomic, so state can't tear mid-step.
    Returns { address, uploadTx, setupTx, healed } — either tx may be
    null when that step was already on-chain. */
async function bootstrapSmartAccount(key, credential) {
  if (!veiveReady()) throw new Error('smart-account infrastructure is not configured');
  const address = key.getAddress();

  let mods = await accountModules(address);
  let uploadTx = null, healed = mods !== null;
  if (mods === null) {
    const wasm = fs.readFileSync(ACCOUNT_WASM_PATH);
    try {
      uploadTx = await sendAsAccount(key,
        [await opUploadContract(address, wasm, { contractAuthority: true })],
        { rcLimit: K.rcLimitUpload });
    } catch (e) {
      if (!e.broadcast) throw e; // ambiguous send: fall through, the re-read decides
      uploadTx = e.txId || null;
    }
    mods = await accountModules(address);
    if (mods === null) throw new Error('account contract did not appear on chain');
  }

  const wantSign = !mods.includes(K.modules.modSign);
  const wantValidator = !mods.includes(K.modules.modValidation);
  const wantCredential = !(await credentialRegisteredFor(address, credential.credential_id));

  if (!wantSign && !wantValidator && !wantCredential) {
    return { address, uploadTx, setupTx: null, healed };
  }
  if (wantCredential && !wantValidator) {
    /* The validator is live, so only the passkey can authorize register —
       the bootstrap key can't help here. (Normal bootstraps never hit
       this: setup is one atomic transaction.) */
    throw new Error('account is already governed by a different passkey');
  }

  const ops = [];
  if (wantSign) ops.push(await opInstallModule(address, MODULE_TYPE_SIGN, K.modules.modSign));
  if (wantCredential) ops.push(await opRegisterCredential(address, credential));
  if (wantValidator) ops.push(await opInstallModule(address, MODULE_TYPE_VALIDATION, K.modules.modValidation, await defaultScopes()));

  let setupTx = null, lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 4000 + attempt * 2000));
    try { setupTx = await sendAsSponsorFor(key, ops, { rcLimit: K.rcLimitSmart }); lastErr = null; break; }
    catch (e) {
      lastErr = e;
      if (e.broadcast) { // timed out but may have mined — the chain decides
        const now = await accountModules(address);
        if (now && now.includes(K.modules.modValidation)) { setupTx = e.txId || 'confirmed'; lastErr = null; break; }
      }
    }
  }
  if (lastErr) {
    const err = new Error(`account ${address} uploaded but module setup failed: ${humanChainError(lastErr)}`);
    err.address = address; err.uploadTx = uploadTx;
    throw err;
  }
  return { address, uploadTx, setupTx, healed };
}

/** Co-sign and broadcast a passkey-signed transaction. The browser sends
    exactly one signature — the 0xFF02 WebAuthn blob; we verify it is
    well-formed, from a credential we expected, over THIS transaction —
    then the sponsor signs as payer and the CHAIN does the real
    verification (P-256, challenge, credential registry). */
/** Ask the DEPLOYED sign module whether it accepts this signature, as a
    read call. Returns { ok, logs } — the module logs exactly why it says no
    ("credential not registered", "invalid signature", "txId mismatch"), so a
    rejection is legible instead of surfacing as the chain's low-level
    recovery assert. Never throws: a diagnostic must not break the path. */
async function verifyPasskeyOnChain(account, sigB64u, txId) {
  try {
    const m = MODSIGN_ABI.methods.is_valid_signature;
    const ser = modSignSerializer();
    const args = await ser.serialize(
      { sender: account, signature: sigB64u, tx_id: txId }, m.argument);
    const res = await withRpcRetry(() => provider().readContract({
      contract_id: K.modules.modSign,
      entry_point: m.entry_point,
      args: utils.encodeBase64url(args),
    }));
    const logs = (res && res.logs) || [];
    let ok = null;
    if (res && res.result) {
      try {
        const out = await ser.deserialize(utils.decodeBase64url(res.result), m.return);
        ok = !!(out && out.value);
      } catch (_) { /* leave ok null — the logs still tell the story */ }
    } else if (res && logs.some((l) => /mod-sign-webauthn/.test(l))) {
      /* protobuf omits `false`, so a rejection comes back with NO result
         bytes — the module's own log line is the whole answer. Requiring
         that line is what keeps a quiet RPC from reading as a rejection. */
      ok = false;
    }
    return { ok, logs };
  } catch (e) {
    return { ok: null, logs: [], error: humanChainError(e) };
  }
}

/** "unexpected signature length" is a symptom, not a cause.

    check_authority (koinos-chain system_calls.cpp) routes to a contract's own
    authorize() only when that account IS a contract with the matching
    authorize-override flag. For anything else it falls back to a loop that
    calls recover_public_key(ecdsa_secp256k1, ...) over the transaction's
    signatures — and that thunk hard-asserts a 65-byte signature. A WebAuthn
    blob is far longer, so the moment the chain checks a PLAIN address while
    our blob is attached, it aborts with this message no matter how good the
    passkey is. Which means: the passkey wasn't accepted by the check that ran
    first. Say that, instead of repeating the chain's words. */
function explainSigLength(msg) {
  if (!/unexpected signature length/i.test(msg)) return msg;
  return `${msg} — the chain fell back to plain-signature checking while your passkey signature was attached, `
    + 'which only happens when the passkey was not accepted by the check before it';
}

/** Read the validator's signature threshold for this account.

    It decides how ModValidationSignature counts the transaction's
    signatures, and 0 is not "no requirement" — it is the strictest setting
    there is:

      threshold 0  → EVERY signature on the transaction must be a valid
                     passkey signature for this account
      threshold n  → at least n of them must be

    Which matters because our transactions carry two: the sponsor's
    secp256k1 signature (it pays the mana) and the passkey blob. Under
    threshold 0 that is one valid out of two, so the validator refuses no
    matter how good the passkey is — and the chain then falls through to a
    plain-signature check that trips over the blob's length. The module sets
    the threshold to 1 in its on_install hook, so a 0 here means that hook
    never ran on this account.

    Returns { value, error } and never throws — a diagnostic must not break
    the path it is diagnosing. */
async function validationThreshold(address) {
  try {
    const m = MODVAL_ABI.methods.get_threshold;
    const ser = modValSerializer();
    const args = await ser.serialize({ user: address }, m.argument);
    const res = await withRpcRetry(() => provider().readContract({
      contract_id: K.modules.modValidation,
      entry_point: m.entry_point,
      args: utils.encodeBase64url(args),
    }));
    if (!res || !res.result) return { value: 0, error: null }; // protobuf omits 0
    const out = await ser.deserialize(utils.decodeBase64url(res.result), m.return);
    return { value: Number((out && out.value) || 0), error: null };
  } catch (e) {
    return { value: null, error: humanChainError(e) };
  }
}

/** Everything about a passkey blob we can check WITHOUT the chain: the
    WebAuthn prefix and protobuf shape, that the credential is one we expect,
    and that its challenge commits to THIS transaction. Cheap, and it catches
    a client bug before any mana is spent. Throws with the reason. */
async function checkPasskeyBlob(sigB64u, preparedId, expectedCredentialIds) {
  let auth;
  try {
    const blob = utils.decodeBase64url(sigB64u);
    if (!(blob.length > 2 && blob[0] === 0xff && blob[1] === 0x02)) throw new Error('missing WebAuthn prefix');
    auth = await modSignSerializer().deserialize(blob.subarray(2), 'authentication_data');
  } catch (e) {
    throw new Error(`not a valid passkey signature: ${e.message}`);
  }
  if (Array.isArray(expectedCredentialIds) && expectedCredentialIds.length &&
      !expectedCredentialIds.includes(auth.credential_id)) {
    throw new Error('signed by an unrecognized passkey');
  }
  const clientData = JSON.parse(Buffer.from(utils.decodeBase64url(auth.client_data)).toString('utf8'));
  const expected = utils.encodeBase64url(Buffer.from(preparedId, 'utf8')).replace(/=+$/, '');
  if (String(clientData.challenge || '').replace(/=+$/, '') !== expected) {
    throw new Error('challenge does not commit to this transaction');
  }
  return auth;
}

/** Build a transaction the ACCOUNT pays for itself.

    The sponsor-as-payer design needs the sponsor's signature alongside the
    passkey's, and ModValidationSignature at threshold 0 rejects any
    transaction where not every signature is a passkey signature — so the
    co-signature is fatal there no matter how good the passkey is. With the
    account as its own payer there is exactly ONE signature on the wire, the
    passkey's, which satisfies BOTH threshold settings. It also keeps the
    chain's authority check inside the account's own authorize(), so nothing
    ever reaches the plain-signature loop that asserts on 65 bytes.

    The price is mana: the account must hold enough KOIN itself. */
async function prepareSelfPaidTx(accountAddr, ops, { rcLimit = K.rcLimit } = {}) {
  const tx = new Transaction({
    provider: provider(),
    options: { payer: accountAddr, rcLimit },   // payer == payee: one check, one signature
  });
  for (const op of ops) await tx.pushOperation(op);
  await tx.prepare({ chainId: await chainId() });
  return tx.transaction;
}

/** Broadcast a self-paid transaction: the passkey blob is the ONLY
    signature — the sponsor deliberately does not co-sign. */
async function submitSelfPaid(signedTx, preparedId, accountAddr, expectedCredentialIds) {
  if (!signedTx || signedTx.id !== preparedId) throw new Error('transaction does not match the prepared action');
  if (Transaction.computeTransactionId(signedTx.header) !== preparedId) throw new Error('transaction header was altered');
  const sigs = (signedTx.signatures || []).slice();
  if (sigs.length !== 1) throw new Error('expected exactly the passkey signature');
  await checkPasskeyBlob(sigs[0], preparedId, expectedCredentialIds);

  const pre = await verifyPasskeyOnChain(accountAddr, sigs[0], preparedId);
  if (pre.ok === false) {
    throw new Error(`the chain rejected your passkey signature: ${pre.logs.length ? pre.logs.join(' | ') : 'the sign module rejected it'}`);
  }
  const clean = { id: signedTx.id, header: signedTx.header, operations: signedTx.operations, signatures: sigs };
  return queueTx(async () => {
    const tx = new Transaction({ provider: provider() });
    tx.transaction = clean;
    try { await sendTolerant(tx); }
    catch (e) {
      const verdict = pre.ok === true ? 'accepted' : pre.error ? `unreadable: ${pre.error}` : 'no verdict';
      throw new Error(`${explainSigLength(humanChainError(e))} [self-paid; sign module: ${verdict}`
        + `${pre.logs && pre.logs.length ? '; ' + pre.logs.join(' | ') : ''}] (payer ${clean.header.payer})`);
    }
    try { await waitMined(clean.id); }
    catch (e) {
      const err = new Error(`transaction ${clean.id} not confirmed: ${humanChainError(e)}`);
      err.txId = clean.id; err.broadcast = true;
      throw err;
    }
    return clean.id;
  });
}

/** Make sure the account can pay `rcLimit` of mana itself, topping it up
    from the sponsor if not. Mana tracks the KOIN balance, so the top-up is
    an ordinary sponsor-authorized transfer — it needs no authority from the
    account, which is the point: it works before the account can sign
    anything. Returns what it did. */
async function ensureManaFor(accountAddr, rcLimitSats) {
  const need = BigInt(rcLimitSats);
  const have = BigInt(Math.floor(await mana(accountAddr) * 1e8));
  if (have >= need) return { toppedUp: false, manaSats: have.toString() };
  const balance = BigInt(await koinBalanceSats(accountAddr));
  /* Mana regenerates toward the balance, so the balance is the ceiling. */
  const short = need > balance ? need - balance : 0n;
  if (short <= 0n) {
    /* Balance is there but mana has not regenerated yet — waiting is the
       only cure, and topping up more KOIN does not speed it. */
    return { toppedUp: false, manaSats: have.toString(), regenerating: true };
  }
  const sponsorKoin = BigInt(await koinBalanceSats(sponsorAddress()));
  if (sponsorKoin < short) throw new Error('the sponsor wallet is out of KOIN to cover this account\'s network fee');
  const op = await opKoinTransfer(sponsorAddress(), accountAddr, short.toString());
  const txId = await sendAsSponsorFor(null, [op], { rcLimit: K.rcLimit });
  return { toppedUp: true, topUpSats: short.toString(), txId };
}

async function submitSmartCosigned(signedTx, preparedId, accountAddr, expectedCredentialIds) {
  if (!signedTx || signedTx.id !== preparedId) throw new Error('transaction does not match the prepared action');
  const recomputed = Transaction.computeTransactionId(signedTx.header);
  if (recomputed !== preparedId) throw new Error('transaction header was altered');
  const sigs = Array.isArray(signedTx.signatures) ? signedTx.signatures : [];
  if (sigs.length !== 1) throw new Error('expected exactly the passkey signature');

  await checkPasskeyBlob(sigs[0], preparedId, expectedCredentialIds);

  /* Ask the chain itself before burning mana — and surface its reason. */
  const pre = await verifyPasskeyOnChain(accountAddr, sigs[0], preparedId);
  if (pre.ok === false) {
    const why = pre.logs.length ? pre.logs.join(' | ') : 'the sign module rejected it';
    throw new Error(`the chain rejected your passkey signature: ${why}`);
  }

  /* The sponsor is about to co-sign to pay the mana. Under threshold 0 that
     co-signature alone guarantees the validator refuses, so say so here
     rather than letting it surface as a signature-length assert. */
  const thr = await validationThreshold(accountAddr);
  if (thr.value === 0) {
    throw new Error(
      "your account's validator is set to require EVERY signature on a transaction to be a passkey "
      + 'signature (threshold 0), but the sponsor has to co-sign to pay the network fee — so the chain '
      + 'will refuse it however good the passkey is. The validator module sets this to 1 in its install '
      + 'hook, so that hook never ran on this account.');
  }

  const clean = {
    id: signedTx.id, header: signedTx.header,
    operations: signedTx.operations, signatures: [],
  };
  return queueTx(async () => {
    /* Sponsor first, blob second — see sendAsAccount for why order matters. */
    await sponsor().signTransaction(clean);
    clean.signatures = clean.signatures.concat(sigs);
    const tx = new Transaction({ provider: provider() });
    tx.transaction = clean;
    try { await sendTolerant(tx); }
    catch (e) {
      /* The pre-flight said yes (or couldn't tell) and the chain still said
         no — carry the module's own log lines and the shapes it saw, so the
         next report names a cause instead of a symptom. */
      const raw = humanChainError(e);
      /* Distinguish "the module accepted it" from "we could not ask" — an
         absent clause used to mean either. */
      const verdict = pre.ok === true ? 'accepted' : pre.error ? `unreadable: ${pre.error}` : 'no verdict';
      const why = ` [sign module: ${verdict}${pre.logs && pre.logs.length ? '; ' + pre.logs.join(' | ') : ''}`
        + `; validator threshold ${thr.value === null ? `unreadable (${thr.error})` : thr.value}]`;
      const sizes = clean.signatures.map((x) => utils.decodeBase64url(x).length).join(',');
      throw new Error(`${explainSigLength(raw)}${why} (sigs ${sizes}; payer ${clean.header.payer}; payee ${clean.header.payee || '-'})`);
    }
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

function newAccountKey() {
  const signer = new Signer({ privateKey: require('crypto').randomBytes(32).toString('hex') });
  return signer;
}
function keyFromWif(wif) {
  return Signer.fromWif(wif);
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
  humanChainError, waitMined, withRpcRetry,
  opKoinTransfer, prepareUserTx, submitCosigned, verifyAuthSignature,
  /* Veive smart-account layer */
  veiveReady, newAccountKey, keyFromWif,
  accountModules, accountCredentials, credentialAddress, credentialRegisteredFor,
  bootstrapSmartAccount, submitSmartCosigned, sendAsAccount, sendAsSponsorFor,
  verifyPasskeyOnChain, validationThreshold,
  prepareSelfPaidTx, submitSelfPaid, ensureManaFor,
  opUploadContract, opInstallModule, opRegisterCredential, defaultScopes,
  modSignSerializer, ACCOUNT_WASM_PATH, VENDOR,
};
