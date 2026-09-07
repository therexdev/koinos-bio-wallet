'use strict';
// Product capability separation: real HTTP requests to an isolated demo server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const { androidHtml } = require('../tools/app-surface');
const root = path.join(__dirname, '..');
const template = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

(async () => {
  assert.throws(() => androidHtml(template.replace('<!-- WEB_ONLY_END -->', '')), /incomplete/);
  const client = fs.readFileSync(path.join(root, 'public/js/client.js'), 'utf8');
  for (const [pathname, marker, expected] of [['/', '', true], ['/', 'android', false], ['/android/', '', false], ['/android/index.html', '', false]]) {
    const ctx = vm.createContext({ document: { documentElement: { dataset: { walletClient: marker } } }, location: { pathname } });
    vm.runInContext(client, ctx);
    assert.equal(vm.runInContext('WalletClient.canBuy', ctx), expected);
    assert.equal(vm.runInContext("WalletClient.apiPath('/api/config')", ctx), expected ? '/api/config' : '/android/api/config');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-android-'));
  const credentialId = randomBytes(24).toString('base64url');
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const body = { credentialId, publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') };
  // A pending browser conversion tests that the generic submit route cannot
  // be used to finish a conversion from Android either.
  const pendingAddress = require('../tools/chain').newAccountKey().getAddress();
  const pendingId = randomBytes(24).toString('base64url');
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ accounts: { [pendingAddress]: {
    address: pendingAddress, credentialId: pendingId, publicKey: body.publicKey, step: 'active',
    credentials: [{ id: pendingId, kind: 'passkey', label: 'test' }], ts: Date.now(),
  } }, byCredential: { [pendingId]: pendingAddress } }));
  fs.writeFileSync(path.join(dir, 'funding.json'), JSON.stringify({ transit: { [pendingAddress]: {
    ethAddress: '0x' + 'ab'.repeat(20), ts: Date.now(),
  } }, jobs: { [pendingAddress]: { demo: true, route: 'B', status: 'awaiting_swap',
    koinosRecipient: pendingAddress, asset: 'eth', estKoinOut: '100000000', startedAt: Date.now(),
  } } }));
  const port = 3976, base = 'http://localhost:' + port;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root, env: { ...process.env, SPONSOR_WIF: '', DEMO_MODE: '1', PORT: String(port), DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Server boot timed out: ' + output)), 15000);
      child.stdout.on('data', d => { output += d; if (/serving:/.test(output)) { clearTimeout(timer); resolve(); } });
      child.stderr.on('data', d => { output += d; });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited: ' + output)); });
    });
    const post = (url, data, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
    for (const url of ['/android/', '/android/index.html', '/android/?tab=convert']) {
      const res = await fetch(base + url), html = await res.text();
      assert.equal(res.status, 200);
      assert.match(html, /data-wallet-client="android"/);
      assert.match(html, /id="btn-open-receive"/);
      assert.match(html, /id="tab-security"/);
      assert.doesNotMatch(html, /id="(?:tab-convert|tabbtn-convert|btn-open-buy|fund-[^"]+)"|src="\/js\/fund.js|use Buy|Buy KOIN/);
      assert.equal(res.headers.get('set-cookie'), null, 'no cross-surface cookie');
    }
    for (const url of ['/', '/?source=pwa', '/?tab=convert']) {
      const html = await (await fetch(base + url)).text();
      assert.match(html, /id="tab-convert"/);
      assert.match(html, /src="\/js\/fund.js/);
      assert.doesNotMatch(html, /data-wallet-client="android"/);
    }
    for (const [url, target] of [['/?source=twa&tab=convert', '/android/'], ['/?source=twa&open=receive', '/android/?open=receive'], ['/android', '/android/']]) {
      const res = await fetch(base + url, { redirect: 'manual' });
      assert.equal(res.status, 302); assert.equal(res.headers.get('location'), target);
    }
    const androidManifest = await (await fetch(base + '/android/manifest.webmanifest')).json();
    const webManifest = await (await fetch(base + '/manifest.webmanifest')).json();
    assert.equal(androidManifest.scope, '/android/');
    assert.deepEqual(androidManifest.shortcuts.map(x => x.name).sort(), ['Receive', 'Send']);
    assert.ok(webManifest.shortcuts.some(x => x.url === '/?tab=convert'));
    assert.equal(webManifest.start_url, '/?source=pwa');
    const aCfg = await (await fetch(base + '/android/api/config')).json();
    const wCfg = await (await fetch(base + '/api/config')).json();
    assert.equal(aCfg.features.buy, false); assert.equal(wCfg.features.buy, true);
    assert.equal(aCfg.float, undefined); assert.equal(aCfg.solRail, undefined);
    assert.equal((await (await fetch(base + '/android/api/health?rail=1')).json()).rail, undefined);
    for (const route of ['status', 'enable', 'quote', 'start', 'prepare-step', 'resume', 'reset', 'future-endpoint']) {
      const method = route === 'status' ? 'GET' : 'POST';
      for (const [prefix, headers] of [['/android', {}], ['', { 'X-Wallet-Client': 'android' }], ['', { Referer: base + '/android/' }]]) {
        const res = await fetch(base + prefix + '/api/fund/' + route, { method, headers });
        assert.equal(res.status, 403, prefix + route);
        assert.equal(res.headers.get('cache-control'), 'no-store');
      }
    }
    const preparedResponse = await post('/api/fund/prepare-step', { credentialId: pendingId });
    assert.equal(preparedResponse.status, 200);
    const prepared = await preparedResponse.json();
    assert.ok(prepared.ref);
    for (const [url, headers] of [['/android/api/submit', {}], ['/api/submit', { 'X-Wallet-Client': 'android' }]]) {
      const blocked = await post(url, { ref: prepared.ref }, headers);
      assert.equal(blocked.status, 403, 'generic submit cannot complete a funding step in Android');
    }
    // Same credential/account on both surfaces, with no transit wallet created by the APK.
    const createdResponse = await post('/android/api/create-account', body);
    assert.equal(createdResponse.status, 200);
    const created = await createdResponse.json();
    const readFunding = () => fs.existsSync(path.join(dir, 'funding.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'funding.json'))) : { transit: {} };
    assert.equal(readFunding().transit[created.address], undefined);
    const whoami = await (await post('/api/whoami', { credentialId })).json();
    assert.equal(whoami.address, created.address);
    const fundingResponse = await fetch(base + '/api/fund/status?credentialId=' + credentialId);
    assert.equal(fundingResponse.status, 200, 'browser Buy remains functional');
    assert.ok((await fundingResponse.json()).ethAddress);
    assert.ok(readFunding().transit[created.address]);
    const accountResponse = await fetch(base + '/android/api/account?address=' + created.address + '&credentialId=' + credentialId);
    assert.equal(accountResponse.status, 200, 'Android account reads still work');
    for (const page of ['privacy', 'delete-account']) {
      const html = await (await fetch(base + '/android/' + page)).text();
      assert.match(html, /href="\/android\/"/);
      assert.doesNotMatch(html, /href="\/(?:privacy|delete-account)?"/);
    }
    console.log('✓ Android HTML, APIs, shortcuts and account creation are wallet-only; browser/PWA Buy and shared accounts remain available');
  } finally {
    child.kill();
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
