/* ============================================================
   Koinos Bio Wallet — the Veive smart-account wallet.

   One button, one biometric scan, one REAL smart account on-chain:
   the server uploads Veive's Account contract for the visitor, installs
   the shared WebAuthn sign module + signature validator, and registers
   the visitor's passkey as the account's only authority. From then on
   the CHAIN verifies every action against the passkey (P-256, on-chain)
   — the server can't move a thing.

   The server:
     · serves the page and answers balance/mana reads,
     · runs the account bootstrap, sponsor-paid (mana sharing), and
     · co-signs passkey-signed transactions as the mana PAYER.

   Secrets: the sponsor key, plus each account's bootstrap key (powerless
   once the validator module is live; kept only to heal interrupted
   bootstraps — data/accounts.json, mode 600).

   Zero dependencies beyond koilib. No build step. Runs anywhere Node
   runs (built for Hostinger's Node hosting behind one proxy hop).
   ============================================================ */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const chain = require('./tools/chain');
const veive = require('./tools/veive');
const funding = require('./tools/funding');
const { createPrices } = require('./tools/prices');
const ethSwap = require('./tools/eth/eth-swap');
const { makeProvider: makeEthProvider } = require('./tools/eth/eth-bridge');

/* One Ethereum provider for price reads, dropped on failure so a dead RPC
   does not get reused forever. */
let _priceEthProvider = null;
async function priceEthProvider() {
  if (!_priceEthProvider) _priceEthProvider = await makeEthProvider().catch((e) => { _priceEthProvider = null; throw e; });
  return _priceEthProvider;
}
const { pickRpcs, NETWORKS } = require('./tools/rpc');

const CFG = {
  port: parseInt(process.env.PORT || '3000', 10),
  network: (process.env.KOINOS_NETWORK || 'harbinger').trim(),
  /* trimmed — a stray space or newline pasted into a hosting panel's env
     field must not break the key parse */
  sponsorWif: (process.env.SPONSOR_WIF || '').trim(),
  /* Shared smart-account infrastructure (tools/infra-deploy.js). All three
     must be set for live smart accounts; otherwise the app runs in demo. */
  modules: {
    verifier: (process.env.VERIFIER_ADDR || '').trim(),
    modSign: (process.env.MOD_SIGN_WEBAUTHN_ADDR || '').trim(),
    modValidation: (process.env.MOD_VALIDATION_SIGNATURE_ADDR || '').trim(),
  },
  /* The WebAuthn relying-party id passkeys bind to. Unset = the page's own
     hostname — for buykoin.usekoinos.com that keeps this app's passkeys fully
     separate from other usekoinos apps, which is the point of this
     playground. (Set the apex domain only when you want passkeys shared
     across *.usekoinos.com.) */
  passkeyRpId: (process.env.PASSKEY_RPID || '').trim(),
  /* Where accounts.json lives. A RELATIVE value resolves against the app
     folder itself (not the process cwd), so DATA_DIR=../bio-wallet-data
     always means "a sibling of this checkout" — outside the folder that a
     git redeploy replaces — on any host. */
  dataDir: process.env.DATA_DIR ? path.resolve(__dirname, process.env.DATA_DIR) : path.join(__dirname, 'data'),
  trustProxyHops: parseInt(process.env.TRUST_PROXY_HOPS || '0', 10),
  minSponsorMana: Number(process.env.MIN_SPONSOR_MANA || 5),
  /* Account creation burns ~85 mana (a 97KB contract upload + module
     setup) — the floor keeps a signup from beaching the sharer. */
  minCreateMana: Number(process.env.MIN_CREATE_MANA || 120),
  maxTransfersPerDayAddr: parseInt(process.env.MAX_TRANSFERS_PER_DAY || '30', 10),
  maxAccountsPerDayIp: parseInt(process.env.MAX_ACCOUNTS_PER_DAY || '3', 10),
  maxAccountsPerDayGlobal: parseInt(process.env.MAX_ACCOUNTS_PER_DAY_GLOBAL || '20', 10),
  maxCredentialsPerAccount: parseInt(process.env.MAX_CREDENTIALS_PER_ACCOUNT || '6', 10),
  demo: process.env.DEMO_MODE === '1',
};

let DEMO = CFG.demo;
const prices = createPrices({
  chain, network: CFG.network, ethProvider: priceEthProvider, ethSwap,
  coingecko: process.env.PRICES_COINGECKO !== '0',
  log: (m) => console.log(m),
});
/* Other tokens the wallet lists for everyone, by contract address — the
   chain supplies name/symbol/decimals. The client may add its own on top. */
const WALLET_TOKENS = String(process.env.WALLET_TOKENS || '').split(',').map(t => t.trim()).filter(Boolean);
const MAX_CLIENT_TOKENS = 12;
let BOOT_NOTE = '';
const WARNINGS = [];

/* ---------------- rate limiting (in-memory) ---------------- */

const RATE = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const e = RATE.get(key);
  if (!e || now > e.reset) { RATE.set(key, { n: 1, reset: now + windowMs }); return false; }
  e.n += 1;
  return e.n > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of RATE) if (now > v.reset) RATE.delete(k);
}, 600000).unref();

function clientIp(req) {
  if (CFG.trustProxyHops > 0) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (fwd.length >= CFG.trustProxyHops) return fwd[fwd.length - CFG.trustProxyHops];
  }
  return req.socket.remoteAddress || '0.0.0.0';
}

/* ---------------- auth proof ----------------
   The browser proves it controls an address by signing
   "koinos-bio-wallet:<action>:<ts>" with the wallet key. */
function verifyProof(body, action) {
  const { address, ts, sig } = body || {};
  if (!chain.isAddr(address)) return 'a valid Koinos address is required';
  const t = Number(ts);
  if (!t || Math.abs(Date.now() - t) > 5 * 60000) return 'stale request — check your clock and try again';
  if (!chain.verifyAuthSignature(`koinos-bio-wallet:${action}:${t}`, sig, address)) return 'signature check failed';
  return null;
}

/* Prepared transactions awaiting the visitor's signature (10-min TTL). */
const PREPARED = new Map();
function rememberPrepared(txId, address, extra) {
  const ref = crypto.randomBytes(12).toString('hex');
  PREPARED.set(ref, { txId, address, ...extra, expires: Date.now() + 10 * 60000 });
  return ref;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of PREPARED) if (now > v.expires) PREPARED.delete(k);
}, 60000).unref();

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const demoTxid = () => '0x1220' + crypto.randomBytes(32).toString('hex');
const explorerTx = (txid) => (NETWORKS[CFG.network].explorer ? `${NETWORKS[CFG.network].explorer}/tx/${txid}` : null);

/* ---------------- API ---------------- */

const api = {};

api.config = async () => {
  const net = NETWORKS[CFG.network];
  return {
    ok: true,
    app: 'Koinos Bio Wallet',
    accountKind: 'veive',
    network: CFG.network,
    networkLabel: net.label,
    testnet: !!net.testnet,
    nativeSymbol: net.nativeSymbol,
    explorer: net.explorer,
    demo: DEMO,
    note: BOOT_NOTE || undefined,
    warnings: WARNINGS.length ? WARNINGS : undefined,
    sponsor: DEMO ? null : chain.sponsorAddress(),
    modules: (CFG.modules.modSign && !DEMO) ? CFG.modules : null,
    rpId: CFG.passkeyRpId || null,   // null → the page uses its own hostname
  };
};

/** One tap on the button, existing account unknown → a smart account is
    born. Answers immediately; the two bootstrap transactions run in the
    background and /api/account-status reports progress. */
api.createAccount = async (body, ip) => {
  if (rateLimited('create:ip:' + ip, CFG.maxAccountsPerDayIp, 24 * 3600000)) {
    throw httpError(429, 'this connection created several accounts today already — come back tomorrow');
  }
  if (!DEMO) {
    if (veive.accountsCreatedSince(24 * 3600000) >= CFG.maxAccountsPerDayGlobal) {
      throw httpError(503, 'today\'s free account budget is used up — come back tomorrow');
    }
    const sponsorMana = await chain.mana(chain.sponsorAddress());
    if (sponsorMana < CFG.minCreateMana) {
      throw httpError(503, 'the sponsor is recharging mana for the next account — try again in a few hours');
    }
  }
  try {
    const rec = veive.createOrResume({
      credentialId: body.credentialId, publicKey: body.publicKey, name: body.name,
    });
    return { ok: true, demo: DEMO || undefined, ...rec };
  } catch (e) { throw httpError(400, e.message); }
};

api.accountStatus = async (params) => {
  const rec = veive.status(params.get('credentialId'));
  if (!rec) throw httpError(404, 'no account for that passkey yet');
  return { ok: true, ...rec };
};

/** Which account does this passkey open? (Store first, then the chain's
    own credential index.) */
api.whoami = async (body) => {
  const rec = await veive.whoami(body.credentialId);
  if (!rec) throw httpError(404, 'that passkey has no smart account here — create one first');
  return { ok: true, ...rec };
};

/** Ground truth: what the chain actually says about this account,
    next to what the local store believes. Read-only, no secrets. */
/** Read-only health report for one account. Takes whichever identifier the
    person actually has: the account ADDRESS (what the wallet shows them) or
    the passkey's credential id. */
api.diagnose = async (params) => {
  const address = String(params.get('address') || '').trim();
  const credentialId = String(params.get('credentialId') || '').trim();
  if (!address && !credentialId) {
    throw httpError(400, 'pass ?address=<your account address> (or ?credentialId=<passkey id>)');
  }
  let rec = credentialId ? veive.status(credentialId) : null;
  if (!rec && address) {
    if (!chain.isAddr(address)) throw httpError(400, `${address} is not a Koinos address`);
    rec = veive.statusByAddress(address)
      /* Not in the local store — still worth reporting what the CHAIN says
         about it, which is the part that matters for a stuck account. */
      || { address, step: 'unknown', credentials: [], notInStore: true };
  }
  if (!rec) throw httpError(404, 'no account for that passkey');
  const chainState = await veive.inspect(rec.address);
  /* The validator's threshold decides whether a sponsor-co-signed
     transaction can EVER be accepted — see chain.validationThreshold. */
  const threshold = DEMO ? null : await chain.validationThreshold(rec.address);
  return {
    ok: true, demo: DEMO, network: CFG.network,
    /* WHY the server is in demo, which is the thing worth knowing when it
       shouldn't be. */
    demoReason: DEMO ? (BOOT_NOTE || 'DEMO_MODE=1 is set') : undefined,
    /* One line worth reading on a phone; the fields below have the detail. */
    summary: diagnoseSummary(rec, chainState, threshold),
    local: { address: rec.address, step: rec.step, credentials: rec.credentials, error: rec.error },
    chain: chainState,
    validator: threshold && {
      threshold: threshold.value, error: threshold.error,
      cosignable: threshold.value === null ? null : threshold.value > 0,
      note: threshold.value === 0
        ? 'threshold 0 requires EVERY signature to be a passkey signature, so the sponsor cannot co-sign to pay the fee'
        : undefined,
    },
    modules: CFG.modules,
    sponsor: DEMO ? null : chain.sponsorAddress(),
  };
};

/** The report in one sentence, leading with whatever is actually wrong. */
function diagnoseSummary(rec, chainState, threshold) {
  const at = rec.address;
  if (DEMO) {
    return `${at}: the server is in DEMO mode (${BOOT_NOTE || 'DEMO_MODE=1'}) — nothing here reaches the chain, `
      + 'and any swap it reports as complete was simulated';
  }
  if (chainState.contractExists === false) return `${at}: no smart-account contract at this address`;
  if (!chainState.signModuleInstalled) return `${at}: the passkey sign module is NOT installed`;
  if (!chainState.validatorInstalled) return `${at}: the validator module is NOT installed`;
  if (threshold && threshold.value === 0) {
    return `${at}: validator threshold is 0 — it requires EVERY signature on a transaction to be a `
      + 'passkey signature, so the sponsor cannot co-sign to pay the fee and every passkey transaction '
      + 'will be refused. This is the bug.';
  }
  if (threshold && threshold.value === null) return `${at}: could not read the validator threshold (${threshold.error})`;
  const creds = (chainState.registeredCredentials || []).length;
  if (!creds) return `${at}: no passkey credential is registered on-chain`;
  return `${at}: healthy — validator threshold ${threshold.value}, ${creds} credential(s) registered on-chain`;
}

api.account = async (params) => {
  const address = params.get('address');
  if (!chain.isAddr(address)) throw httpError(400, 'a valid Koinos address is required');
  const smart = veive.status(params.get('credentialId')) || undefined;
  if (DEMO) return { ok: true, demo: true, koin: 124.19, koinSats: '12419000000', mana: 5, smart };   // same sample as /api/portfolio
  const [koin, koinSats, mana] = await Promise.all([
    chain.koinBalance(address).catch(() => 0),
    /* The exact integer too: "Send all" has to name the whole balance to the
       last satoshi, and a float cannot promise that. */
    chain.koinBalanceSats(address).catch(() => '0'),
    chain.mana(address).catch(() => 0),
  ]);
  return { ok: true, koin, koinSats: String(koinSats), mana, smart };
};

/* ---------------- portfolio ----------------
   Everything the wallet's home screen shows in one read: KOIN, VHP and any
   other tokens with their balances and dollar values, mana, and the prices
   those dollars came from. A price that is not known is null — the screen
   shows "—" for it, never $0. */

const fromSats = (sats, decimals) => {
  const s = BigInt(sats || 0), d = BigInt(decimals);
  const base = 10n ** d;
  const whole = s / base, frac = String(s % base).padStart(Number(d), '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
};

api.portfolio = async (params) => {
  const address = params.get('address');
  if (!chain.isAddr(address)) throw httpError(400, 'a valid Koinos address is required');
  const net = NETWORKS[CFG.network];
  /* Tokens the client asked about, on top of the server's list. Validated
     and capped: this is a fan-out of RPC reads per request. */
  const extra = String(params.get('tokens') || '').split(',').map(t => t.trim()).filter(Boolean)
    .filter(t => chain.isAddr(t)).slice(0, MAX_CLIENT_TOKENS);
  const tokenAddrs = [...new Set([...WALLET_TOKENS, ...extra])]
    .filter(t => t !== net.koinContract && t !== net.vhpContract);

  if (DEMO) {
    const p = { value: 0.0102, source: 'sample', at: Date.now(), stale: false };
    const v = { value: 0.0098, source: 'sample', at: Date.now(), stale: false };
    const assets = [
      { id: 'koin', symbol: net.nativeSymbol, name: 'Koin', address: net.koinContract, decimals: 8, native: true, sats: '12419000000', amount: '124.19', usd: 124.19 * p.value },
      { id: 'vhp', symbol: 'VHP', name: 'Virtual Hash Power', address: net.vhpContract, decimals: 8, native: true, sats: '4000000000', amount: '40', usd: 40 * v.value },
    ];
    return {
      ok: true, demo: true, network: CFG.network, address, mana: 5,
      prices: { koinUsd: p, vhpUsd: v, vhpKoin: { value: 0.96, source: 'sample', at: Date.now(), stale: false }, ethUsd: { value: 2500, source: 'sample', at: Date.now(), stale: false } },
      assets, totalUsd: assets.reduce((a, x) => a + x.usd, 0), allPriced: true,
    };
  }

  const [koinSats, vhpSats, mana, px] = await Promise.all([
    chain.koinBalanceSats(address).catch(() => null),
    chain.vhpBalanceSats(address).catch(() => null),
    chain.mana(address).catch(() => 0),
    prices.snapshot(),
  ]);
  const usdOf = (amount, price) => (price && price.value != null && amount != null ? Number(amount) * price.value : null);
  const assets = [
    { id: 'koin', symbol: net.nativeSymbol, name: 'Koin', address: net.koinContract, decimals: 8, native: true,
      sats: koinSats, amount: koinSats == null ? null : fromSats(koinSats, 8), unavailable: koinSats == null || undefined },
    { id: 'vhp', symbol: 'VHP', name: 'Virtual Hash Power', address: net.vhpContract, decimals: 8, native: true,
      sats: vhpSats, amount: vhpSats == null ? null : fromSats(vhpSats, 8), unavailable: vhpSats == null || undefined },
  ];
  assets[0].usd = usdOf(assets[0].amount, px.koinUsd);
  assets[1].usd = usdOf(assets[1].amount, px.vhpUsd);

  /* Other tokens: meta + balance each, one failure never empties the list. */
  const others = await Promise.all(tokenAddrs.map(async (addr) => {
    try {
      const [meta, sats] = await Promise.all([chain.tokenMeta(addr), chain.tokenBalanceSats(addr, address)]);
      return { id: addr, symbol: meta.symbol || '?', name: meta.name || addr, address: addr, decimals: meta.decimals,
               native: false, sats, amount: fromSats(sats, meta.decimals), usd: null };
    } catch (e) {
      return { id: addr, symbol: '?', name: addr, address: addr, decimals: 8, native: false, sats: null, amount: null, usd: null,
               unavailable: true, error: chain.humanChainError(e).slice(0, 80) };
    }
  }));
  const all = assets.concat(others);
  const priced = all.filter(a => a.usd != null);
  return {
    ok: true, network: CFG.network, address, mana,
    prices: { koinUsd: px.koinUsd, vhpUsd: px.vhpUsd, vhpKoin: px.vhpKoin, ethUsd: px.ethUsd },
    assets: all,
    /* The sum of what CAN be priced; allPriced says whether that is all of it. */
    totalUsd: priced.length ? priced.reduce((s, a) => s + a.usd, 0) : null,
    allPriced: priced.length === all.filter(a => !a.unavailable).length && priced.length > 0,
  };
};

/** Prepare the transaction that registers ONE more credential on the
    account — a backup passkey from another device, or the recovery kit's
    software key. The transaction only counts once an EXISTING credential
    signs it (the chain enforces that; we only build it). */
api.prepareRegister = async (body, ip) => {
  const address = String(body.address || '');
  const rec = veive.status(String(body.signerCredentialId || ''));
  if (!rec || rec.address !== address) throw httpError(400, 'that account is not yours to change');
  if (rec.step !== 'active') throw httpError(400, 'the account is still activating — try again in a minute');
  const cred = body.newCredential || {};
  const id = String(cred.credentialId || '');
  const kind = cred.kind === 'recovery' ? 'recovery' : 'passkey';
  const label = String(cred.label || (kind === 'recovery' ? 'recovery key' : 'backup passkey')).slice(0, 40);
  if (!veive.CRED_ID.test(id)) throw httpError(400, 'credential id looks wrong');
  if (!veive.validPublicKey(cred.publicKey)) throw httpError(400, 'the new credential did not provide a P-256 public key this chain can verify');
  if (veive.hasCredential(address, id)) throw httpError(400, 'that credential is already on this account');
  if (veive.credentialCount(address) >= CFG.maxCredentialsPerAccount) {
    throw httpError(400, `this account already holds ${CFG.maxCredentialsPerAccount} credentials`);
  }
  if (rateLimited('reg:addr:' + address, 6, 24 * 3600000)) throw httpError(429, 'that account added several credentials today — come back tomorrow');
  if (!DEMO) {
    try { await veive.ensureReady(address); }
    catch (e) { throw httpError(409, e.message); }
  }
  if (rateLimited('reg:ip:' + ip, 12, 24 * 3600000)) throw httpError(429, 'too many credential changes from this connection today');

  const newCred = { id, label, kind, publicKey: String(cred.publicKey) };
  if (DEMO) {
    const txId = demoTxid();
    const ref = rememberPrepared(txId, address, { demo: true, smart: true, register: newCred });
    return { ok: true, demo: true, ref, tx: { id: txId } };
  }
  const sponsorMana = await chain.mana(chain.sponsorAddress());
  if (sponsorMana < CFG.minSponsorMana) throw httpError(503, 'the sponsor wallet is recharging its mana — try again in a few minutes');
  const ops = [await chain.opRegisterCredential(address, {
    credential_id: id, public_key: String(cred.publicKey), name: label,
  })];
  const tx = await chain.prepareUserTx(address, ops, { rcLimit: chain.K.rcLimitSmart });
  const ref = rememberPrepared(tx.id, address, { smart: true, register: newCred });
  return { ok: true, ref, tx };
};

/** Prepare a sponsored KOIN transfer: sponsor pays, the account signs.
    For smart accounts no proof is needed here — a prepared transaction is
    inert until the passkey signs it and the CHAIN verifies that signature;
    for plain (legacy v1) addresses the secp proof still applies. */
api.prepare = async (body, ip) => {
  const smart = veive.isSmartAccount(body.address);
  if (!smart) {
    const err = verifyProof(body, 'transfer');
    if (err) throw httpError(400, err);
  } else if (!chain.isAddr(body.address)) {
    throw httpError(400, 'a valid Koinos address is required');
  }
  /* A prepared transaction is worthless if the chain doesn't actually
     govern this account yet — verify (and repair) before spending mana. */
  if (smart && !DEMO) {
    try { await veive.ensureReady(body.address); }
    catch (e) { throw httpError(409, e.message); }
  }
  const address = body.address;
  const to = String(body.to || '').trim();
  if (!chain.isAddr(to)) throw httpError(400, 'a valid destination address is required');
  if (to === address) throw httpError(400, 'that would send KOIN to yourself');
  const amount = String(body.amount || '').trim();
  if (!/^\d+(\.\d{1,8})?$/.test(amount) || Number(amount) <= 0) throw httpError(400, 'amount must be a positive number (max 8 decimals)');
  const sats = BigInt(Math.round(Number(amount) * 1e8));

  if (rateLimited('tx:addr:' + address, CFG.maxTransfersPerDayAddr, 24 * 3600000)) {
    throw httpError(429, 'that account has sent a lot today — come back tomorrow');
  }
  if (rateLimited('tx:ip:' + ip, CFG.maxTransfersPerDayAddr * 2, 24 * 3600000)) {
    throw httpError(429, 'too many transfers from this connection today');
  }

  if (DEMO) {
    /* A real-shaped id so the passkey ceremony + signature packing run for
       real — submit then verifies the packed signature like the live path. */
    const id = demoTxid();
    const ref = rememberPrepared(id, address, { demo: true, smart });
    return { ok: true, demo: true, ref, tx: { id } };
  }

  const balance = BigInt(await chain.koinBalanceSats(address));
  if (balance < sats) throw httpError(400, `not enough KOIN — you hold ${(Number(balance) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}`);

  const sponsorMana = await chain.mana(chain.sponsorAddress());
  if (sponsorMana < CFG.minSponsorMana) {
    throw httpError(503, 'the sponsor wallet is recharging its mana — try again in a few minutes');
  }

  const ops = [await chain.opKoinTransfer(address, to, sats.toString())];
  const tx = await chain.prepareUserTx(address, ops, smart ? { rcLimit: chain.K.rcLimitSmart } : {});
  const ref = rememberPrepared(tx.id, address, { smart });
  return { ok: true, ref, tx };
};

/** Broadcast a signed prepared transaction (sponsor co-signs as payer).
    Smart accounts sign with the passkey — the WebAuthn blob is checked for
    shape, credential and challenge here, then verified for real ON-CHAIN. */
api.submit = async (body) => {
  const known = PREPARED.get(String(body.ref || ''));
  if (!known || known.expires < Date.now()) throw httpError(400, 'this action expired — start it again');
  PREPARED.delete(String(body.ref));
  if (known.demo) {
    if (known.smart) await demoCheckSmartSignature(body.transaction, known);
    const smart = known.register ? veive.addCredential(known.address, known.register) : undefined;
    if (known.fundingTap) funding.onTapDone(known.fundingTap.account, known.fundingTap.step, known.txId);
    return { ok: true, demo: true, txid: known.txId, explorer: null, smart };
  }
  const txid = known.selfPaid
    ? await chain.submitSelfPaid(body.transaction, known.txId, known.address, veive.credentialsFor(known.address))
    : known.smart
      ? await chain.submitSmartCosigned(body.transaction, known.txId, known.address, veive.credentialsFor(known.address))
      : await chain.submitCosigned(body.transaction, known.txId, known.address);
  /* The register landed on-chain — mirror it into the store so sign-in and
     the submit allowlist recognize the new credential immediately. */
  const smart = known.register ? veive.addCredential(known.address, known.register) : undefined;
  if (known.fundingTap) funding.onTapDone(known.fundingTap.account, known.fundingTap.step, txid);
  return { ok: true, txid, explorer: explorerTx(txid), smart };
};

/** Demo-mode teeth: the browser's packed signature must be exactly what
    the chain would verify — prefix, protobuf shape, known credential,
    challenge committing to the transaction id. */
async function demoCheckSmartSignature(tx, known) {
  const { utils } = require('koilib');
  const sigs = (tx && tx.signatures) || [];
  if (sigs.length !== 1) throw httpError(400, 'expected exactly the passkey signature');
  let auth;
  try {
    const blob = utils.decodeBase64url(sigs[0]);
    if (!(blob[0] === 0xff && blob[1] === 0x02)) throw new Error('missing WebAuthn prefix');
    auth = await chain.modSignSerializer().deserialize(blob.subarray(2), 'authentication_data');
  } catch (e) { throw httpError(400, 'not a valid passkey signature: ' + e.message); }
  const allowed = veive.credentialsFor(known.address);
  if (allowed.length && !allowed.includes(auth.credential_id)) throw httpError(400, 'signed by an unrecognized passkey');
  const clientData = JSON.parse(Buffer.from(utils.decodeBase64url(auth.client_data)).toString('utf8'));
  const expected = utils.encodeBase64url(Buffer.from(known.txId, 'utf8')).replace(/=+$/, '');
  if (String(clientData.challenge || '').replace(/=+$/, '') !== expected) {
    throw httpError(400, 'challenge does not commit to this transaction');
  }
}

/* ---------------- Fund with ETH / USDC / USDT ----------------
   Each account gets a transit Ethereum deposit address; deposits are
   swapped to KOIN through the better of the two Vortex routes, and the
   PASSKEY signs the Koinos-side landing (see tools/funding.js). */

function fundAccount(credentialId, { requireActive = true } = {}) {
  const rec = veive.status(String(credentialId || ''));
  if (!rec) throw httpError(404, 'no account for that passkey');
  /* The deposit address and its balances are useful the moment an account
     exists — only the swap itself needs a live on-chain account. */
  if (requireActive && rec.step !== 'active') {
    throw httpError(409, rec.step === 'conflict'
      ? 'this account answers to a different passkey'
      : 'your account is still being set up on-chain — try again in a minute'
        + (rec.error ? ` (${rec.error})` : ''));
  }
  return rec.address;
}

api.fundEnable = async (body, ip) => {
  if (rateLimited('fund-enable:ip:' + ip, 6, 24 * 3600000)) throw httpError(429, 'too many funding setups from this connection today');
  const account = fundAccount(body.credentialId);
  return { ok: true, ...funding.enable(account) };
};

api.fundStatus = async (params) => {
  const rec = veive.status(String(params.get('credentialId') || ''));
  if (!rec) throw httpError(404, 'no account for that passkey');
  funding.enable(rec.address); // every account has a deposit address, automatically
  return {
    ok: true,
    accountActive: rec.step === 'active',
    accountStep: rec.step,
    accountError: rec.error || undefined,
    ...(await funding.status(rec.address)),
  };
};

/** Route comparison for a user-chosen amount — the node app's quote view. */
api.fundQuote = async (body) => {
  const account = fundAccount(body.credentialId, { requireActive: false });
  funding.enable(account);
  try {
    return { ok: true, quote: await funding.quoteFor(account, String(body.asset || ''), body.amount) };
  } catch (e) { throw httpError(400, e.message); }
};

api.fundStart = async (body, ip) => {
  const account = fundAccount(body.credentialId);
  if (rateLimited('fund-start:addr:' + account, 8, 24 * 3600000)) throw httpError(429, 'that account started several swaps today — come back tomorrow');
  try {
    return { ok: true, job: await funding.start(account, { asset: String(body.asset || ''), amount: body.amount, route: body.route }) };
  } catch (e) { throw httpError(400, e.message); }
};

api.fundResume = async (body) => {
  const account = fundAccount(body.credentialId);
  try { return { ok: true, job: await funding.resume(account) }; }
  catch (e) { throw httpError(400, e.message); }
};

api.fundReset = async (body) => {
  const account = fundAccount(body.credentialId);
  try { funding.reset(account); return { ok: true }; }
  catch (e) { throw httpError(400, e.message); }
};

/** The passkey step: prepare the Koinos-side transaction the job is
    waiting on (bridge redeem, or Route B's KoinDX swap). */
api.fundPrepareStep = async (body) => {
  const account = fundAccount(body.credentialId);
  if (!DEMO) {
    try { await veive.ensureReady(account); }
    catch (e) { throw httpError(409, e.message); }
  }
  let tap;
  try { tap = await chain.withRpcRetry(() => funding.prepareTapOps(account)); }
  catch (e) { throw httpError(400, chain.humanChainError(e)); }
  if (DEMO) {
    const id = demoTxid();
    const ref = rememberPrepared(id, account, { demo: true, smart: true, fundingTap: { account, step: tap.step } });
    return { ok: true, demo: true, ref, tx: { id }, step: tap.step };
  }
  const sponsorMana = await chain.mana(chain.sponsorAddress());
  if (sponsorMana < CFG.minSponsorMana) throw httpError(503, 'the sponsor wallet is recharging its mana — try again in a few minutes');

  /* Who pays? The sponsor normally does — but that means the sponsor must
     co-sign, and a validator at threshold 0 rejects any transaction where
     not every signature is a passkey signature. There, the account pays for
     itself so the passkey is the ONLY signature; the sponsor covers the
     mana as a KOIN top-up instead, which needs no authority from the
     account. Same mana sharing, different plumbing. */
  const thr = await chain.validationThreshold(account);
  const selfPaid = thr.value === 0;
  let tx, topUp;
  if (selfPaid) {
    try { topUp = await chain.ensureManaFor(account, tap.rcLimit); }
    catch (e) { throw httpError(503, chain.humanChainError(e)); }
    if (topUp.regenerating) {
      throw httpError(503, 'your account is still regenerating the mana for this step — try again in a few minutes');
    }
    tx = await chain.withRpcRetry(() => chain.prepareSelfPaidTx(account, tap.ops, { rcLimit: tap.rcLimit }));
  } else {
    /* Public RPCs occasionally answer with an HTML error page; building is
       read-only and idempotent, so ride it out rather than failing the tap. */
    tx = await chain.withRpcRetry(() => chain.prepareUserTx(account, tap.ops, { rcLimit: tap.rcLimit }));
  }
  const ref = rememberPrepared(tx.id, account, { smart: true, selfPaid, fundingTap: { account, step: tap.step } });
  return { ok: true, ref, tx, step: tap.step, selfPaid, toppedUp: topUp && topUp.toppedUp || undefined };
};

api.health = async () => ({ ok: true, demo: DEMO, network: CFG.network });

/* ---------------- HTTP plumbing ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PAGES = { '/': 'index.html' };

/* Code assets must never outlive a deploy (a stale css against fresh js
   renders a broken hybrid) — they revalidate every load, and served HTML
   stamps their URLs with a per-boot version. */
const ASSET_V = Date.now().toString(36);
const stampAssets = (html) =>
  html.replace(/(["'])(\/(?:css|js)\/[^"'?#]+\.(?:css|js))\1/g, (_, q, p) => q + p + '?v=' + ASSET_V + q);

function serveStatic(req, res, pathname) {
  const rel = PAGES[pathname] || pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    const isHtml = ext === '.html';
    const isCode = ext === '.css' || ext === '.js';
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': (isHtml || isCode) ? 'no-cache' : 'public, max-age=86400',
      ...(isHtml ? {
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      } : {}),
    };
    if (isHtml) {
      fs.readFile(file, 'utf8', (rerr, text) => {
        if (rerr) { res.writeHead(500); return res.end(); }
        const body = Buffer.from(stampAssets(text));
        res.writeHead(200, { ...headers, 'Content-Length': body.length });
        res.end(body);
      });
      return;
    }
    const lastMod = st.mtime.toUTCString();
    headers['Last-Modified'] = lastMod;
    if (req.headers['if-modified-since'] === lastMod) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

function readBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(httpError(413, 'request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); }
      catch (_) { reject(httpError(400, 'bad JSON')); }
    });
    req.on('error', reject);
  });
}

const GET_ROUTES = {
  '/api/config': api.config, '/api/account': api.account, '/api/portfolio': api.portfolio,
  '/api/account-status': api.accountStatus, '/api/health': api.health,
  '/api/fund/status': api.fundStatus, '/api/diagnose': api.diagnose,
};
const POST_ROUTES = {
  '/api/create-account': api.createAccount, '/api/whoami': api.whoami,
  '/api/prepare': api.prepare, '/api/prepare-register': api.prepareRegister,
  '/api/submit': api.submit,
  '/api/fund/enable': api.fundEnable, '/api/fund/start': api.fundStart,
  '/api/fund/quote': api.fundQuote,
  '/api/fund/prepare-step': api.fundPrepareStep,
  '/api/fund/resume': api.fundResume, '/api/fund/reset': api.fundReset,
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (pathname.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      if (rateLimited('api:ip:' + clientIp(req), 240, 60000)) throw httpError(429, 'slow down');
      let out;
      if (req.method === 'GET' && GET_ROUTES[pathname]) {
        out = await GET_ROUTES[pathname](url.searchParams);
      } else if (req.method === 'POST' && POST_ROUTES[pathname]) {
        const body = await readBody(req);
        out = await POST_ROUTES[pathname](body, clientIp(req));
      } else {
        throw httpError(404, 'no such endpoint');
      }
      res.writeHead(200);
      return res.end(JSON.stringify(out));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, pathname);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(`[${new Date().toISOString()}]`, e.message || e);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: String(e.message || e).slice(0, 300) }));
  }
});

/* ---------------- boot ---------------- */

async function connectChain() {
  const rpcUrls = await pickRpcs(CFG.network);
  chain.configure({ network: CFG.network, rpcs: rpcUrls, sponsorWif: CFG.sponsorWif, modules: CFG.modules });
  const [sponsorMana, sponsorKoin] = await Promise.all([
    chain.mana(chain.sponsorAddress()), chain.koinBalance(chain.sponsorAddress()),
  ]);
  console.log(`sponsor:  ${chain.sponsorAddress()} (${sponsorKoin} ${NETWORKS[CFG.network].nativeSymbol}, ${Math.floor(sponsorMana)} mana)`);
  console.log(`modules:  sign=${CFG.modules.modSign} validation=${CFG.modules.modValidation}`);
  console.log(`          verifier=${CFG.modules.verifier}`);
}

function applyMode() {
  veive.configure({ dataDir: CFG.dataDir, demo: DEMO });
  if (!DEMO) veive.reconcile();
  /* The ETH funding rail runs live only on mainnet (the Vortex bridge and
     Uniswap pools are mainnet); everywhere else it simulates. */
  const fundingDemo = DEMO || CFG.network !== 'mainnet';
  funding.configure({ dataDir: CFG.dataDir, demo: fundingDemo, network: 'mainnet' });
  console.log(`funding:  ETH/USDC/USDT→KOIN ${fundingDemo ? 'demo' : 'LIVE (Vortex + Uniswap)'}`);
}

(async () => {
  console.log('Koinos Bio Wallet — Veive smart accounts');
  console.log(`network:  ${CFG.network}`);
  const modulesSet = !!(CFG.modules.modSign && CFG.modules.modValidation && CFG.modules.verifier);
  let retryable = false;
  if (!CFG.sponsorWif) {
    DEMO = true;
    BOOT_NOTE = 'no sponsor wallet configured';
    console.log('mode:     DEMO (set SPONSOR_WIF to go live)');
  } else if (!modulesSet && !DEMO) {
    DEMO = true;
    BOOT_NOTE = 'smart-account contracts not deployed yet';
    console.log('mode:     DEMO — set VERIFIER_ADDR / MOD_SIGN_WEBAUTHN_ADDR / MOD_VALIDATION_SIGNATURE_ADDR (run tools/infra-deploy.js)');
  } else if (!DEMO) {
    try {
      await connectChain();
    } catch (e) {
      DEMO = true;
      retryable = true; // config is complete — only this step failed
      /* Surface the REAL reason on /api/config — 'unreachable' alone hides
         things like a malformed WIF or a wrong network. */
      BOOT_NOTE = `chain setup failed — retrying automatically (${String(e.message || e).slice(0, 140)})`;
      console.log(`mode:     DEMO — ${e.message} (retrying every 60s)`);
    }
  } else {
    console.log('mode:     DEMO (DEMO_MODE=1)');
  }

  if (!DEMO && !process.env.DATA_DIR) {
    const w = 'DATA_DIR is not set — account and funding keys live inside the app folder, which a redeploy can WIPE. Set DATA_DIR=../bio-wallet-data.';
    WARNINGS.push(w);
    console.log('WARNING:  ' + w);
  }

  applyMode();

  /* A live-configured server must never stay stuck in demo because one RPC
     probe failed at boot: keep retrying and flip to live when the chain
     answers. */
  if (retryable) {
    const timer = setInterval(async () => {
      try {
        await connectChain();
        DEMO = false;
        BOOT_NOTE = '';
        applyMode();
        console.log('mode:     LIVE — chain reachable again');
        clearInterval(timer);
      } catch (_) { /* still down — keep trying */ }
    }, 60000);
    if (timer.unref) timer.unref();
  }

  console.log(`passkey:  rpId = ${CFG.passkeyRpId || '(page hostname)'}`);
  server.listen(CFG.port, () => {
    console.log(`serving:  http://localhost:${CFG.port} ${DEMO ? '(demo mode)' : ''}`);
  });
})();
