/* ============================================================
   Veive smart-account lifecycle for the Bio Wallet.

   One record per account in data/accounts.json:
     { address, credentialId, publicKey, name, bootstrapWif,
       step: 'pending' | 'active' | 'conflict', ts, txs, error? }

   · createOrResume() answers fast — the two on-chain bootstrap
     transactions (upload Account.wasm, then install modules + register
     the passkey in ONE atomic transaction) run in the background; the
     client polls status().
   · Bootstrap is chain-driven and idempotent: every attempt re-reads
     what is actually on-chain and only performs the missing steps, so a
     crash or timeout anywhere leaves nothing to corrupt — reconcile()
     resumes half-done accounts at boot.
   · The bootstrap key is the ONLY copy of the account's temporary
     authority. Once the validator module is live the passkey governs and
     the key is powerless; we keep it solely to heal interrupted
     bootstraps. The file is 0600 inside a 0700 dir and never leaves the
     server.
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const chain = require('./chain');

const S = {
  dataDir: path.join(__dirname, '..', 'data'),
  demo: false,
  store: { accounts: {}, byCredential: {} },
};
const RUNNING = new Set();

const file = () => path.join(S.dataDir, 'accounts.json');

function configure(opts) {
  Object.assign(S, opts || {});
  fs.mkdirSync(S.dataDir, { recursive: true, mode: 0o700 });
  try {
    S.store = JSON.parse(fs.readFileSync(file(), 'utf8'));
    S.store.accounts ||= {}; S.store.byCredential ||= {};
  } catch (_) { S.store = { accounts: {}, byCredential: {} }; }
  /* v0.2.0 records had a single credentialId — lift them into the
     credentials list (id, label, kind, ts) that backups introduced. */
  let migrated = false;
  for (const rec of Object.values(S.store.accounts)) {
    if (!rec.credentials) {
      rec.credentials = rec.credentialId
        ? [{ id: rec.credentialId, label: rec.name || 'passkey', kind: 'passkey', ts: rec.ts }]
        : [];
      migrated = true;
    }
    for (const c of rec.credentials) {
      if (S.store.byCredential[c.id] !== rec.address) { S.store.byCredential[c.id] = rec.address; migrated = true; }
    }
  }
  if (migrated) { try { persist(); } catch (_) {} }
}

function persist() {
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(S.store, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

/* ---------------- input validation ---------------- */

const CRED_ID = /^[A-Za-z0-9_-]{16,400}$/;

/* An uncompressed P-256 key in DER SPKI form — exactly what
   credential.response.getPublicKey() returns for ES256, and the format
   the sign module stores (it uses the last 64 bytes = X‖Y). */
const SPKI_P256_HEADER = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
function validPublicKey(b64u) {
  try {
    const der = Buffer.from(require('koilib').utils.decodeBase64url(String(b64u || '')));
    return der.length === 91 &&
      der.subarray(0, SPKI_P256_HEADER.length).equals(SPKI_P256_HEADER) &&
      der[SPKI_P256_HEADER.length] === 0x04;
  } catch (_) { return false; }
}

const publicView = (rec) => rec && ({
  address: rec.address,
  step: rec.step,
  txs: rec.txs || {},
  error: rec.error || undefined,
  name: rec.name || undefined,
  credentials: (rec.credentials || []).map((c) => ({ id: c.id, label: c.label, kind: c.kind, ts: c.ts })),
});

/* ---------------- lifecycle ---------------- */

/** Fast path for the create button: mint the record, kick the on-chain
    bootstrap in the background, hand back the address immediately. */
function createOrResume({ credentialId, publicKey, name }) {
  if (!CRED_ID.test(String(credentialId || ''))) throw new Error('credential id looks wrong');
  if (!validPublicKey(publicKey)) throw new Error('the passkey did not return a P-256 public key this chain can verify');

  const existingAddr = S.store.byCredential[credentialId];
  if (existingAddr) {
    const rec = S.store.accounts[existingAddr];
    if (rec && rec.step !== 'active' && !S.demo) runBootstrap(rec);
    return publicView(rec);
  }

  const key = chain.newAccountKey();
  const label = String(name || 'passkey').slice(0, 40);
  const rec = {
    address: key.getAddress(),
    credentialId,
    publicKey: String(publicKey),
    name: label,
    credentials: [{ id: credentialId, label, kind: 'passkey', ts: Date.now() }],
    bootstrapWif: key.getPrivateKey('wif'),
    step: S.demo ? 'active' : 'pending',
    ts: Date.now(),
    txs: {},
  };
  S.store.accounts[rec.address] = rec;
  S.store.byCredential[credentialId] = rec.address;
  persist();
  /* Every account is born with its Ethereum deposit address too. */
  try { require('./funding').enable(rec.address); } catch (_) {}
  if (!S.demo) runBootstrap(rec);
  return publicView(rec);
}

/** A registered-and-mined extra credential (backup passkey or recovery key). */
function addCredential(address, { id, label, kind }) {
  const rec = S.store.accounts[String(address || '')];
  if (!rec) return null;
  if (!rec.credentials.some((c) => c.id === id)) {
    rec.credentials.push({ id, label: String(label || 'backup').slice(0, 40), kind: kind === 'recovery' ? 'recovery' : 'passkey', ts: Date.now() });
  }
  S.store.byCredential[id] = rec.address;
  persist();
  return publicView(rec);
}

function hasCredential(address, id) {
  const rec = S.store.accounts[String(address || '')];
  return !!(rec && rec.credentials.some((c) => c.id === id));
}
function credentialCount(address) {
  const rec = S.store.accounts[String(address || '')];
  return rec ? rec.credentials.length : 0;
}

async function runBootstrap(rec) {
  if (RUNNING.has(rec.address) || rec.step === 'active' || rec.step === 'conflict' || !rec.bootstrapWif) return;
  RUNNING.add(rec.address);
  try {
    const key = chain.keyFromWif(rec.bootstrapWif);
    const r = await chain.bootstrapSmartAccount(key, {
      credential_id: rec.credentialId,
      public_key: rec.publicKey,
      name: rec.name,
    });
    rec.txs = { upload: r.uploadTx || rec.txs.upload, setup: r.setupTx || rec.txs.setup };
    rec.step = 'active';
    rec.error = undefined;
    console.log(`[veive] account ${rec.address} active${r.healed ? ' (healed)' : ''}`);
  } catch (e) {
    rec.error = chain.humanChainError(e).slice(0, 240);
    if (/different passkey/i.test(rec.error)) rec.step = 'conflict';
    if (e && e.uploadTx) rec.txs = { ...rec.txs, upload: e.uploadTx };
    console.error(`[veive] bootstrap ${rec.address}: ${rec.error}`);
  } finally {
    RUNNING.delete(rec.address);
    try { persist(); } catch (_) {}
  }
}

/** Ground truth from the chain for one account — what actually exists,
    versus what the local store believes. */
async function inspect(address) {
  const rec = S.store.accounts[String(address || '')];
  const out = {
    address, known: !!rec, step: rec ? rec.step : undefined,
    demo: S.demo || undefined, createdAt: rec ? rec.ts : undefined,
  };
  if (S.demo || !chain.veiveReady()) { out.note = 'smart-account chain access not configured'; return out; }
  const mods = await chain.accountModules(address);
  out.contractExists = mods !== null;
  out.modules = mods || [];
  out.signModuleInstalled = !!mods && mods.includes(chain.K.modules.modSign);
  out.validatorInstalled = !!mods && mods.includes(chain.K.modules.modValidation);
  out.localCredentials = rec ? rec.credentials.map((c) => c.id) : [];
  /* Check each local credential through the credential→address index — the
     per-user credential list is not safely readable (see chain.js). */
  const owned = [];
  for (const id of out.localCredentials) {
    if (await chain.credentialRegisteredFor(address, id).catch(() => false)) owned.push(id);
  }
  out.registeredCredentials = owned;
  out.credentialRegistered = owned.length > 0;
  out.ready = !!(out.contractExists && out.signModuleInstalled && out.validatorInstalled && out.credentialRegistered);
  return out;
}

/** Refuse to build a transaction for an account the chain doesn't actually
    govern yet — and repair it. Accounts created while the app ran in demo
    (or whose bootstrap was interrupted) exist only in the local store; the
    chain would fall back to plain key recovery and reject the passkey with
    a baffling low-level error. Cached, so the hot path stays cheap. */
async function ensureReady(address) {
  if (S.demo) return;
  const rec = S.store.accounts[String(address || '')];
  if (!rec) throw new Error('unknown account');
  if (rec.verifiedAt && Date.now() - rec.verifiedAt < 10 * 60000) return;
  const info = await inspect(address);
  if (info.ready) { rec.verifiedAt = Date.now(); persist(); return; }
  if (!rec.bootstrapWif) {
    throw new Error('this account was never finished on-chain and can no longer be repaired automatically — create a fresh one');
  }
  rec.step = 'pending'; rec.error = null; rec.verifiedAt = 0;
  persist();
  runBootstrap(rec);
  throw new Error(info.contractExists
    ? 'your account is missing part of its on-chain setup — finishing it now, try again in a minute'
    : 'your account was never written on-chain (it predates this deployment) — creating it now, try again in a minute');
}

function status(credentialId) {
  const addr = S.store.byCredential[String(credentialId || '')];
  return addr ? publicView(S.store.accounts[addr]) : null;
}

/** Same view, looked up by the account address instead of a credential —
    the address is what a person actually has in front of them. */
function statusByAddress(address) {
  const rec = S.store.accounts[String(address || '')];
  return rec ? publicView(rec) : null;
}

/** credential → account. The store answers first; the chain's own
    reverse index (get_address_by_credential_id) covers accounts created
    elsewhere against the same shared modules. */
async function whoami(credentialId) {
  const id = String(credentialId || '');
  if (!CRED_ID.test(id)) return null;
  const local = status(id);
  if (local) return local;
  if (S.demo || !chain.veiveReady()) return null;
  const addr = await chain.credentialAddress(id).catch(() => null);
  if (!addr) return null;
  const rec = S.store.accounts[addr] || {
    address: addr, credentialId: id, publicKey: '', name: 'passkey',
    credentials: [], bootstrapWif: '', step: 'active', ts: Date.now(), txs: {}, external: true,
  };
  if (!rec.credentials.some((c) => c.id === id)) {
    rec.credentials.push({ id, label: 'passkey', kind: 'passkey', ts: Date.now() });
  }
  S.store.accounts[addr] = rec;
  S.store.byCredential[id] = addr;
  persist();
  return publicView(rec);
}

/** Expected credential ids for an address — the submit-path allowlist. */
function credentialsFor(address) {
  const rec = S.store.accounts[String(address || '')];
  return rec ? rec.credentials.map((c) => c.id) : [];
}

function isSmartAccount(address) {
  return !!S.store.accounts[String(address || '')];
}

function accountsCreatedSince(ms) {
  const cutoff = Date.now() - ms;
  return Object.values(S.store.accounts).filter((r) => r.ts >= cutoff && !r.external).length;
}

/** Resume every half-bootstrapped account at boot, oldest first. */
function reconcile() {
  /* Anything claiming to be active is re-checked against the chain in the
     background — a record written while the app ran in demo has no contract
     behind it and must be really bootstrapped before it can sign. */
  const claimed = Object.values(S.store.accounts).filter((r) => r.step === 'active' && r.bootstrapWif && !r.external);
  if (claimed.length) {
    (async () => {
      for (const rec of claimed) {
        try {
          const info = await inspect(rec.address);
          if (!info.ready) {
            console.log(`[veive] ${rec.address} is not live on-chain (contract:${!!info.contractExists} sign:${!!info.signModuleInstalled} validator:${!!info.validatorInstalled} credential:${!!info.credentialRegistered}) — repairing`);
            rec.step = 'pending'; rec.error = null; rec.verifiedAt = 0;
            persist();
            await runBootstrap(rec);
          } else if (!rec.verifiedAt) { rec.verifiedAt = Date.now(); persist(); }
        } catch (_) { /* transient — the next boot or tap re-checks */ }
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
  }
  const pending = Object.values(S.store.accounts)
    .filter((r) => r.step === 'pending' && r.bootstrapWif)
    .sort((a, b) => a.ts - b.ts);
  if (!pending.length) return 0;
  console.log(`[veive] resuming ${pending.length} unfinished account bootstrap(s)`);
  (async () => {
    for (const rec of pending) {
      await runBootstrap(rec);
      await new Promise((r) => setTimeout(r, 3000));
    }
  })();
  return pending.length;
}

module.exports = {
  configure, createOrResume, status, statusByAddress, whoami, credentialsFor, isSmartAccount,
  accountsCreatedSince, reconcile, addCredential, hasCredential, credentialCount,
  inspect, ensureReady,
  CRED_ID, validPublicKey,
};
