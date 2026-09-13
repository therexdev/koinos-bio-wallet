'use strict';
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const net = require('node:net');

const ORIGINAL = 'https://wallet.usekoinos.com';
const VAULT = 'https://koinvault.app';
const PROOF_HEADER = 'x-koin-wallet-proxy';

// Each site's passkeys retain their existing relying-party ID. An Origin
// supplied by a visitor never adds another trusted wallet site.
function approvalIdentity(req, cfg) {
  const primary = cfg.publicUrl || ORIGINAL;
  const sites = new Map([[primary, cfg.passkeyRpId || new URL(primary).hostname]]);
  if (primary === ORIGINAL || primary === VAULT) {
    if (!sites.has(ORIGINAL)) sites.set(ORIGINAL, 'wallet.usekoinos.com');
    if (!sites.has(VAULT)) sites.set(VAULT, 'koinvault.app');
  }
  const origin = String(req.headers.origin || '');
  if (!sites.has(origin)) {
    const error = new Error('Approve from the wallet site'); error.status = 403; throw error;
  }
  return { origin, rpId: sites.get(origin) };
}

// Forward rate-limit identity only with a short-lived, domain-separated
// MAC. Arbitrary X-Forwarded-For headers from visitors are not trusted.
function mac(secret, value) {
  const key = crypto.createHmac('sha256', secret).update('koin-wallet-proxy-ip-v1').digest();
  return crypto.createHmac('sha256', key).update(value).digest('base64url');
}
function proxyProof(req, ip, secret) {
  if (!secret || !net.isIP(ip)) return 'forwarded';
  const value = Buffer.from(JSON.stringify([Date.now(), ip, req.method, req.url])).toString('base64url');
  return value + '.' + mac(secret, value);
}
function trustedProxyIp(req, secret) {
  if (!secret) return null;
  const proof = String(req.headers[PROOF_HEADER] || '');
  if (proof.length > 1024) return null;
  const [value, signature, extra] = proof.split('.');
  if (!value || !signature || extra) return null;
  const expected = Buffer.from(mac(secret, value));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const [time, ip, method, url] = JSON.parse(Buffer.from(value, 'base64url').toString());
    return Number.isFinite(time) && Math.abs(Date.now() - time) < 60000 && net.isIP(ip)
      && method === req.method && url === req.url ? ip : null;
  } catch (_) { return null; }
}

function createProxy({ backendUrl, publicUrl, rpId, secret, clientIp, timeoutMs = 20000 }) {
  const target = new URL(backendUrl);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
  if ((target.protocol !== 'https:' && !(target.protocol === 'http:' && local))
      || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('WALLET_BACKEND_URL must be an HTTPS origin (or local HTTP for development)');
  }
  const frontend = new URL(publicUrl);
  if (target.origin === frontend.origin) throw new Error('Wallet backend cannot point to this frontend');

  return async function forward(req, res) {
    const reply = (status, error) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error }));
    };
    if (req.headers[PROOF_HEADER]) return reply(508, 'Wallet backend forwarding loop');
    const url = new URL(req.url, frontend.origin);
    const path = url.pathname + url.search;
    const maxBody = /\/api\/dapp\/(launch|approve)$/.test(url.pathname) ? 512 * 1024 : 64 * 1024;
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBody) return reply(413, 'Request too large');
        chunks.push(chunk);
      }
    } catch (_) { return; }
    const body = Buffer.concat(chunks);
    const headers = { [PROOF_HEADER]: proxyProof(req, clientIp(req), secret) };
    for (const name of ['content-type', 'origin', 'referer', 'x-wallet-client']) {
      if (req.headers[name]) headers[name] = req.headers[name];
    }
    if (body.length) headers['content-length'] = String(body.length);
    const transport = target.protocol === 'https:' ? https : http;
    // Use a fixed configured origin, no redirects, and exactly one upstream
    // attempt. Retrying a POST here could submit a funding action twice.
    const upstream = transport.request(target, { method: req.method, path, headers });
    const deadline = setTimeout(() => upstream.destroy(new Error('Wallet backend timed out')), timeoutMs);
    const finish = () => clearTimeout(deadline);
    res.once('close', () => { finish(); if (!res.writableEnded) upstream.destroy(); });
    upstream.once('error', () => { finish(); reply(503, 'Wallet connection is unavailable. Please try again shortly.'); });
    upstream.once('response', (answer) => {
      const output = [];
      let bytes = 0;
      answer.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) upstream.destroy(new Error('Wallet response too large'));
        else output.push(chunk);
      });
      answer.once('error', () => { finish(); reply(503, 'Wallet connection was interrupted. Please try again shortly.'); });
      answer.once('end', () => {
        finish();
        if (res.destroyed || res.writableEnded) return;
        const status = answer.statusCode || 502;
        if (status >= 300 && status < 400) return reply(503, 'Wallet backend returned an unexpected redirect');
        let payload = Buffer.concat(output);
        const apiPath = url.pathname.replace(/^\/android(?=\/api\/)/, '');
        if (status === 200 && ['/api/config', '/api/dapp/create'].includes(apiPath)) {
          try {
            const data = JSON.parse(payload.toString());
            if (apiPath === '/api/config') data.rpId = rpId || frontend.hostname;
            if (apiPath === '/api/dapp/create' && data.uri) {
              const uri = new URL(data.uri);
              if (uri.pathname !== '/' || !uri.searchParams.get('connect') || !uri.searchParams.get('secret')) throw new Error('Unexpected wallet link');
              data.uri = frontend.origin + uri.pathname + uri.search;
            }
            payload = Buffer.from(JSON.stringify(data));
          } catch (_) { return reply(503, 'Wallet backend returned an invalid response'); }
        }
        const responseHeaders = { 'Content-Type': answer.headers['content-type'] || 'application/json', 'Cache-Control': 'no-store' };
        for (const name of ['access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-methods', 'vary', 'retry-after']) {
          if (answer.headers[name]) responseHeaders[name] = answer.headers[name];
        }
        res.writeHead(status, responseHeaders);
        res.end(payload);
      });
    });
    upstream.end(body);
  };
}

module.exports = { approvalIdentity, createProxy, trustedProxyIp, proxyProof };
