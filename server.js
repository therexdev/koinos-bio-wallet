/* ============================================================
   Koinos Bio Wallet — server.

   A deliberately small app: static files + a mana sharer. The wallet
   itself lives in the visitor's PASSKEY (face / fingerprint / PIN);
   the browser derives the key and signs locally. This server only
     · serves the page,
     · answers balance/mana reads,
     · and co-signs the visitor's transactions as the mana PAYER, so
       using the wallet costs the visitor nothing.

   It holds ONE secret: the sponsor wallet's key. It never sees a
   visitor key and stores no accounts — there is nothing to store.

   Zero dependencies beyond koilib. No build step. Runs anywhere Node
   runs (built for Hostinger's Node hosting behind one proxy hop).
   ============================================================ */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const chain = require('./tools/chain');
const { pickRpcs, NETWORKS } = require('./tools/rpc');

const CFG = {
  port: parseInt(process.env.PORT || '3000', 10),
  network: process.env.KOINOS_NETWORK || 'harbinger',
  sponsorWif: process.env.SPONSOR_WIF || '',
  /* The WebAuthn relying-party id passkeys bind to. Set it to the APEX
     domain (usekoinos.com) so the same passkey — and therefore the same
     wallet — works on every *.usekoinos.com app. Must be the page's host
     or a registrable suffix of it, or the browser refuses the ceremony.
     Unset = the page's own hostname (fine for local dev). */
  passkeyRpId: (process.env.PASSKEY_RPID || '').trim(),
  trustProxyHops: parseInt(process.env.TRUST_PROXY_HOPS || '0', 10),
  minSponsorMana: Number(process.env.MIN_SPONSOR_MANA || 5),
  maxTransfersPerDayAddr: parseInt(process.env.MAX_TRANSFERS_PER_DAY || '30', 10),
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
function rememberPrepared(txId, address) {
  const ref = crypto.randomBytes(12).toString('hex');
  PREPARED.set(ref, { txId, address, expires: Date.now() + 10 * 60000 });
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

const demoTxid = () => '0x1220' + crypto.randomBytes(30).toString('hex');
const explorerTx = (txid) => (NETWORKS[CFG.network].explorer ? `${NETWORKS[CFG.network].explorer}/tx/${txid}` : null);

/* ---------------- API ---------------- */

const api = {};

api.config = async () => {
  const net = NETWORKS[CFG.network];
  return {
    ok: true,
    app: 'Koinos Bio Wallet',
    network: CFG.network,
    networkLabel: net.label,
    testnet: !!net.testnet,
    nativeSymbol: net.nativeSymbol,
    explorer: net.explorer,
    demo: DEMO,
    note: BOOT_NOTE || undefined,
    sponsor: DEMO ? null : chain.sponsorAddress(),
    rpId: CFG.passkeyRpId || null,   // null → the page uses its own hostname
  };
};

api.account = async (params) => {
  const address = params.get('address');
  if (!chain.isAddr(address)) throw httpError(400, 'a valid Koinos address is required');
  if (DEMO) return { ok: true, demo: true, koin: 0, mana: 5 };
  const [koin, mana] = await Promise.all([
    chain.koinBalance(address).catch(() => 0),
    chain.mana(address).catch(() => 0),
  ]);
  return { ok: true, koin, mana };
};

/** Prepare a sponsored KOIN transfer: sponsor pays, visitor signs. */
api.prepare = async (body, ip) => {
  const err = verifyProof(body, 'transfer');
  if (err) throw httpError(400, err);
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
    const ref = rememberPrepared('demo', address);
    return { ok: true, demo: true, ref, tx: { id: 'demo' } };
  }

  const balance = BigInt(await chain.koinBalanceSats(address));
  if (balance < sats) throw httpError(400, `not enough KOIN — you hold ${(Number(balance) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}`);

  const sponsorMana = await chain.mana(chain.sponsorAddress());
  if (sponsorMana < CFG.minSponsorMana) {
    throw httpError(503, 'the sponsor wallet is recharging its mana — try again in a few minutes');
  }

  const ops = [await chain.opKoinTransfer(address, to, sats.toString())];
  const tx = await chain.prepareUserTx(address, ops);
  const ref = rememberPrepared(tx.id, address);
  return { ok: true, ref, tx };
};

/** Broadcast a visitor-signed prepared transaction (sponsor co-signs). */
api.submit = async (body) => {
  const known = PREPARED.get(String(body.ref || ''));
  if (!known || known.expires < Date.now()) throw httpError(400, 'this action expired — start it again');
  PREPARED.delete(String(body.ref));
  if (known.txId === 'demo') return { ok: true, demo: true, txid: demoTxid(), explorer: null };
  const txid = await chain.submitCosigned(body.transaction, known.txId, known.address);
  return { ok: true, txid, explorer: explorerTx(txid) };
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

const GET_ROUTES = { '/api/config': api.config, '/api/account': api.account, '/api/health': api.health };
const POST_ROUTES = { '/api/prepare': api.prepare, '/api/submit': api.submit };

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
  console.log('Koinos Bio Wallet');
  console.log(`network:  ${CFG.network}`);
  if (!CFG.sponsorWif) {
    DEMO = true;
    BOOT_NOTE = 'no sponsor wallet configured';
    console.log('mode:     DEMO (set SPONSOR_WIF to go live)');
  } else if (!DEMO) {
    try {
      const rpcUrls = await pickRpcs(CFG.network);
      chain.configure({ network: CFG.network, rpcs: rpcUrls, sponsorWif: CFG.sponsorWif });
      const [sponsorMana, sponsorKoin] = await Promise.all([
        chain.mana(chain.sponsorAddress()), chain.koinBalance(chain.sponsorAddress()),
      ]);
      console.log(`sponsor:  ${chain.sponsorAddress()} (${sponsorKoin} ${NETWORKS[CFG.network].nativeSymbol}, ${Math.floor(sponsorMana)} mana)`);
    } catch (e) {
      DEMO = true;
      BOOT_NOTE = 'chain unreachable at boot';
      console.log(`mode:     DEMO — ${e.message}`);
    }
  } else {
    console.log('mode:     DEMO (DEMO_MODE=1)');
  }
  console.log(`passkey:  rpId = ${CFG.passkeyRpId || '(page hostname)'}`);
  server.listen(CFG.port, () => {
    console.log(`serving:  http://localhost:${CFG.port} ${DEMO ? '(demo mode)' : ''}`);
  });
})();
