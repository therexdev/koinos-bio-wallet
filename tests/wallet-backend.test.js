'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const crypto = require('node:crypto');
const backend = require('../tools/wallet-backend');
const auth = require('../tools/dapp-auth');
const chain = require('../tools/chain');
const wire = require('../public/js/webauthn-wire');
const original = 'https://wallet.usekoinos.com', vault = 'https://koinvault.app';
const cfg = { publicUrl: original, passkeyRpId: 'wallet.usekoinos.com' };
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return 'http://127.0.0.1:' + server.address().port; };
(async () => {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const verifier = { modSignSerializer: chain.modSignSerializer, accountCredentials: async () => [{ credential_id: 'fixture', public_key: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') }] };
  for (const origin of [original, vault]) {
    const identity = backend.approvalIdentity({ headers: { origin } }, cfg);
    assert.deepEqual(identity, { origin, rpId: new URL(origin).hostname });
    const challenge = auth.issue('session', 'account', identity.origin, identity.rpId);
    const data = Buffer.alloc(37); data[32] = 5;
    crypto.createHash('sha256').update(identity.rpId).digest().copy(data);
    const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', origin, challenge: Buffer.from(challenge).toString('base64url') }));
    const signature = crypto.sign('sha256', Buffer.concat([data, crypto.createHash('sha256').update(client).digest()]), pair.privateKey);
    const blob = wire.packSignatureBlob({ credentialId: 'fixture', signature, authenticatorData: data, clientDataJSON: client });
    await auth.verify('session', 'account', challenge, blob, verifier);
    const other = backend.approvalIdentity({ headers: { origin: origin === vault ? original : vault } }, cfg);
    await assert.rejects(auth.verifyProof('account', challenge, blob, verifier, other));
    await assert.rejects(auth.verifyProof('account', challenge, blob, verifier, { ...identity, rpId: 'wrong.example' }));
  }
  for (const origin of ['https://evil.example', vault + '.evil.example', 'null', '', vault + '/']) {
    assert.throws(() => backend.approvalIdentity({ headers: { origin, 'x-forwarded-host': 'koinvault.app' } }, cfg), /wallet site/);
  }
  const secret = 'test-only-shared-secret';
  const request = { method: 'POST', url: '/api/submit', headers: {} };
  const proof = backend.proxyProof(request, '192.0.2.17', secret);
  request.headers['x-koin-wallet-proxy'] = proof;
  assert.equal(backend.trustedProxyIp(request, secret), '192.0.2.17');
  assert.equal(backend.trustedProxyIp(request, 'wrong'), null);
  assert.equal(backend.trustedProxyIp({ ...request, url: '/api/create-account' }, secret), null);
  assert.equal(backend.trustedProxyIp({ ...request, headers: { 'x-koin-wallet-proxy': proof + 'x' } }, secret), null);
  assert.equal(backend.trustedProxyIp({ ...request, headers: { 'x-forwarded-for': '192.0.2.17' } }, secret), null);
  console.log('✓ Original and new passkey origins verify separately; hostile origins, wrong RP IDs and spoofed client IPs fail');

  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    const parts = []; for await (const chunk of req) parts.push(chunk);
    calls.push({ url: req.url, body: Buffer.concat(parts).toString(), origin: req.headers.origin, ip: backend.trustedProxyIp(req, secret), client: req.headers['x-wallet-client'] });
    if (req.url === '/api/submit') return req.socket.destroy();
    if (req.url === '/api/stall') return;
    if (req.url === '/api/redirect') { res.writeHead(302, { Location: 'https://evil.example' }); return res.end(); }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', 'https://ouro.lifestyle');
    if (req.url.endsWith('/api/config')) return res.end(JSON.stringify({ ok: true, demo: false, rpId: 'wallet.usekoinos.com', features: { buy: !req.url.startsWith('/android') } }));
    if (req.url === '/api/dapp/create') return res.end(JSON.stringify({ ok: true, uri: upstreamUrl + '/?connect=session&secret=fixture' }));
    res.end(JSON.stringify({ ok: true, address: 'existing-account-address' }));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = http.createServer(backend.createProxy({ backendUrl: upstreamUrl, publicUrl: vault, rpId: 'koinvault.app', secret, clientIp: () => '192.0.2.17', timeoutMs: 150 }));
  const proxyUrl = await listen(proxy);
  try {
    for (const prefix of ['', '/android']) {
      const res = await fetch(proxyUrl + prefix + '/api/config');
      const value = await res.json();
      assert.equal(value.demo, false); assert.equal(value.rpId, 'koinvault.app');
      assert.equal(value.features.buy, !prefix); assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    const body = JSON.stringify({ credentialId: 'old-key', arbitrary: 'preserve exact request' });
    const who = await fetch(proxyUrl + '/api/whoami', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: vault }, body });
    assert.equal((await who.json()).address, 'existing-account-address');
    assert.equal(calls.at(-1).body, body); assert.equal(calls.at(-1).origin, vault); assert.equal(calls.at(-1).ip, '192.0.2.17');
    const created = await fetch(proxyUrl + '/api/dapp/create', { method: 'POST', headers: { Origin: 'https://ouro.lifestyle' }, body: '{}' });
    assert.equal((await created.json()).uri, vault + '/?connect=session&secret=fixture');
    assert.equal(created.headers.get('access-control-allow-origin'), 'https://ouro.lifestyle');
    assert.equal((await fetch(proxyUrl + '/api/submit', { method: 'POST', body: '{}' })).status, 503);
    assert.equal(calls.filter(c => c.url === '/api/submit').length, 1, 'An ambiguous POST must never be retried');
    assert.equal((await fetch(proxyUrl + '/api/redirect')).status, 503);
    assert.equal((await fetch(proxyUrl + '/api/stall')).status, 503);
    assert.equal((await fetch(proxyUrl + '/api/config', { headers: { 'x-koin-wallet-proxy': 'loop' } })).status, 508);
    for (const target of [vault, 'http://evil.example', 'https://user:password@example.com', 'https://example.com/path']) {
      assert.throws(() => backend.createProxy({ backendUrl: target, publicUrl: vault, clientIp: () => '' }));
    }
    console.log('✓ Proxy preserves existing-account lookups, Android flags, CORS and wallet links; errors never trigger duplicate submissions');
  } finally {
    proxy.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => upstream.close(r))]);
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
