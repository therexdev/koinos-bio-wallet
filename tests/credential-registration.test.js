'use strict';
// Real HTTP registration in an isolated demo server; generated test keys only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const Recovery = require('../public/js/recovery');
const Wire = require('../public/js/webauthn-wire');
const chain = require('../tools/chain');
const root = path.join(__dirname, '..');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-credentials-'));
  const keys = await Promise.all(Array.from({ length: 6 }, () => Recovery.generate()));
  const address = chain.newAccountKey().getAddress(), fullAddress = chain.newAccountKey().getAddress();
  const original = keys.map((key, i) => ({ id: key.credentialId, label: 'fixture ' + i, kind: i < 4 ? 'passkey' : 'recovery', ts: Date.now() }));
  const full = Array.from({ length: 32 }, (_, i) => ({ id: 'full-account-fixture-' + i, kind: 'passkey', label: 'fixture' }));
  const account = (addr, credentials) => ({ address: addr, credentialId: credentials[0].id, publicKey: keys[0].publicKey, credentials, step: 'active', ts: Date.now() });
  const byCredential = Object.fromEntries([...original.map(c => [c.id, address]), ...full.map(c => [c.id, fullAddress])]);
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ accounts: { [address]: account(address, original), [fullAddress]: account(fullAddress, full) }, byCredential }));
  const base = 'http://127.0.0.1:3984';
  const env = { ...process.env, WALLET_BACKEND_URL: 'local', DEMO_MODE: '1', SPONSOR_WIF: '',
    MOD_SIGN_WEBAUTHN_ADDR: '', MOD_VALIDATION_SIGNATURE_ADDR: '', VERIFIER_ADDR: '',
    MAX_CREDENTIALS_PER_ACCOUNT: '', PORT: '3984', DATA_DIR: dir, PRICES_COINGECKO: '0' };
  let child;
  async function start() {
    child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      let logs = '';
      const timer = setTimeout(() => reject(new Error('Demo server boot timed out')), 15000);
      child.stdout.on('data', data => { logs += data; if (/serving:/.test(logs)) { clearTimeout(timer); resolve(); } });
      child.stderr.on('data', () => {});
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Demo server exited')); });
    });
    for (let attempt = 0; attempt < 50; attempt++) {
      const res = await fetch(base + '/api/health');
      if (res.ok) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Demo server never became ready');
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  }
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await start();
    for (const prefix of ['', '/android']) {
      const config = await (await fetch(base + prefix + '/api/config')).json();
      assert.equal(config.maxCredentialsPerAccount, 32);
    }
    const newKit = await Recovery.generate();
    const newCredential = { ...newKit, privateKey: undefined, kind: 'recovery', label: 'recovery kit' };
    const prepResponse = await post('/api/prepare-register', { address, signerCredentialId: keys[0].credentialId, newCredential });
    assert.equal(prepResponse.status, 200, 'A seventh credential must be permitted');
    const prep = await prepResponse.json();
    const signature = Wire.packSignatureBlob(await Recovery.signTx(keys[0].privateKey, keys[0].credentialId, prep.tx.id));
    const registered = await post('/api/submit', { ref: prep.ref, transaction: { ...prep.tx, signatures: [signature] } });
    assert.equal(registered.status, 200);
    const result = await registered.json();
    assert.equal(result.smart.credentials.length, 7);
    assert.deepEqual(result.smart.credentials.slice(0, 6), original, 'Adding a kit must retain every old credential');
    assert.equal(result.smart.credentials[6].id, newKit.credentialId);
    const rejected = await post('/api/prepare-register', { address: fullAddress, signerCredentialId: full[0].id, newCredential });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /32 credentials/);
    const duplicate = await post('/api/prepare-register', { address, signerCredentialId: keys[0].credentialId, newCredential });
    assert.equal(duplicate.status, 400, 'The same kit cannot consume another slot');
    await stop(); await start();
    for (const id of [keys[4].credentialId, keys[5].credentialId, newKit.credentialId]) {
      const status = await (await fetch(base + '/api/account-status?credentialId=' + encodeURIComponent(id))).json();
      assert.equal(status.address, address, 'Old and new kits still resolve to the same wallet after restart');
      assert.equal(status.credentials.length, 7);
    }
    await stop(); env.MAX_CREDENTIALS_PER_ACCOUNT = '8'; await start();
    assert.equal((await (await fetch(base + '/api/config')).json()).maxCredentialsPerAccount, 8, 'Explicit hosting limits remain authoritative');
    console.log('✓ Seventh credential activates, old kits persist after restart, duplicate/full registrations fail, and configured capacity is advertised');
  } finally { await stop(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
