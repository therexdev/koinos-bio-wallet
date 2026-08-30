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
const { pickRpcs, NETWORKS } = require('./tools/rpc');

const CFG = {
  port: parseInt(process.env.PORT || '3000', 10),
  network: process.env.KOINOS_NETWORK || 'harbinger',
  sponsorWif: process.env.SPONSOR_WIF || '',
  /* Shared smart-account infrastructure (tools/infra-deploy.js). All three
     must be set for live smart accounts; otherwise the app runs in demo. */
  modules: {
    verifier: (process.env.VERIFIER_ADDR || '').trim(),
    modSign: (process.env.MOD_SIGN_WEBAUTHN_ADDR || '').trim(),
    modValidation: (process.env.MOD_VALIDATION_SIGNATURE_ADDR || '').trim(),
  },
  /* The WebAuthn relying-party id passkeys bind to. Unset = the page's own
     hostname — for wallet.usekoinos.com that keeps this app's passkeys fully
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
let BOOT_NOTE = '';

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

api.account = async (params) => {
  const address = params.get('address');
  if (!chain.isAddr(address)) throw httpError(400, 'a valid Koinos address is required');
  const smart = veive.status(params.get('credentialId')) || undefined;
  if (DEMO) return { ok: true, demo: true, koin: 0, mana: 5, smart };
  const [koin, mana] = await Promise.all([
    chain.koinBalance(address).catch(() => 0),
    chain.mana(address).catch(() => 0),
  ]);
  return { ok: true, koin, mana, smart };
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
    return { ok: true, demo: true, txid: known.txId, explorer: null, smart };
  }
  const txid = known.smart
    ? await chain.submitSmartCosigned(body.transaction, known.txId, known.address, veive.credentialsFor(known.address))
    : await chain.submitCosigned(body.transaction, known.txId, known.address);
  /* The register landed on-chain — mirror it into the store so sign-in and
     the submit allowlist recognize the new credential immediately. */
  const smart = known.register ? veive.addCredential(known.address, known.register) : undefined;
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
  '/api/config': api.config, '/api/account': api.account,
  '/api/account-status': api.accountStatus, '/api/health': api.health,
};
const POST_ROUTES = {
  '/api/create-account': api.createAccount, '/api/whoami': api.whoami,
  '/api/prepare': api.prepare, '/api/prepare-register': api.prepareRegister,
  '/api/submit': api.submit,
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

(async () => {
  console.log('Koinos Bio Wallet — Veive smart accounts');
  console.log(`network:  ${CFG.network}`);
  const modulesSet = !!(CFG.modules.modSign && CFG.modules.modValidation && CFG.modules.verifier);
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
      const rpcUrls = await pickRpcs(CFG.network);
      chain.configure({ network: CFG.network, rpcs: rpcUrls, sponsorWif: CFG.sponsorWif, modules: CFG.modules });
      const [sponsorMana, sponsorKoin] = await Promise.all([
        chain.mana(chain.sponsorAddress()), chain.koinBalance(chain.sponsorAddress()),
      ]);
      console.log(`sponsor:  ${chain.sponsorAddress()} (${sponsorKoin} ${NETWORKS[CFG.network].nativeSymbol}, ${Math.floor(sponsorMana)} mana)`);
      console.log(`modules:  sign=${CFG.modules.modSign} validation=${CFG.modules.modValidation}`);
      console.log(`          verifier=${CFG.modules.verifier}`);
    } catch (e) {
      DEMO = true;
      BOOT_NOTE = 'chain unreachable at boot';
      console.log(`mode:     DEMO — ${e.message}`);
    }
  } else {
    console.log('mode:     DEMO (DEMO_MODE=1)');
  }
  veive.configure({ dataDir: CFG.dataDir, demo: DEMO });
  if (!DEMO) veive.reconcile();
  console.log(`passkey:  rpId = ${CFG.passkeyRpId || '(page hostname)'}`);
  server.listen(CFG.port, () => {
    console.log(`serving:  http://localhost:${CFG.port} ${DEMO ? '(demo mode)' : ''}`);
  });
})();
