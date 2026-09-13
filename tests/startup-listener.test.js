'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { once } = require('node:events');
const { Signer } = require('koilib');
(async () => {
  const root = path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-startup-'));
  const preload = path.join(dir, 'preload.cjs');
  fs.writeFileSync(preload, `
    require(${JSON.stringify(path.join(root, 'tools/rpc'))}).pickRpcs = () => new Promise(() => {});
    const chain = require(${JSON.stringify(path.join(root, 'tools/chain'))});
    chain.mana = chain.koinBalance = () => new Promise(() => {});
    const funding = require(${JSON.stringify(path.join(root, 'tools/funding'))});
    funding.floatHealth = funding._sdkReady = () => new Promise(() => {});
    if (process.env.WALLET_BACKEND_URL !== 'local') {
      funding.configure = () => { throw new Error('Frontend must never start a funding worker'); };
      require(${JSON.stringify(path.join(root, 'tools/veive'))}).configure = () => { throw new Error('Frontend must never open accounts'); };
    }
  `);
  const data = path.join(dir, 'data'); fs.mkdirSync(data);
  const account = Signer.fromSeed('startup-existing-fixture').getAddress();
  const credentialId = 'existing-passkey-credential';
  const recoveryId = 'rk-existing-recovery-fixture';
  fs.writeFileSync(path.join(data, 'accounts.json'), JSON.stringify({ accounts: {
    [account]: { address: account, credentialId, credentials: [{ id: credentialId, kind: 'passkey' }, { id: recoveryId, kind: 'recovery' }], step: 'active', external: true },
  }, byCredential: { [credentialId]: account, [recoveryId]: account } }));
  fs.writeFileSync(path.join(data, 'funding.json'), '{}');
  const saved = fs.readFileSync(path.join(data, 'accounts.json'));
  const children = [];
  async function start(backendUrl = 'local') {
    const portServer = http.createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
    const port = portServer.address().port; await new Promise(r => portServer.close(r));
    const child = spawn(process.execPath, ['--require', preload, 'server.js'], {
      cwd: root, env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: data,
        WALLET_BACKEND_URL: backendUrl, KOINOS_NETWORK: 'mainnet', DEMO_MODE: '0',
        PUBLIC_URL: backendUrl === 'local' ? 'https://wallet.usekoinos.com' : 'https://koinvault.app',
        PASSKEY_RPID: backendUrl === 'local' ? 'wallet.usekoinos.com' : 'koinvault.app',
        SPONSOR_WIF: Signer.fromSeed('startup-test-only-sponsor').getPrivateKey('wif'),
        VERIFIER_ADDR: account, MOD_SIGN_WEBAUTHN_ADDR: account, MOD_VALIDATION_SIGNATURE_ADDR: account },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let logs = ''; child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
    const base = 'http://127.0.0.1:' + port;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base)).status === 200) return { child, base, logs: () => logs }; } catch (_) {}
      await new Promise(r => setTimeout(r, 40));
    }
    throw new Error('HTTP did not start: ' + logs);
  }
  try {
    const primary = await start();
    const health = await fetch(primary.base + '/api/health');
    assert.equal(health.status, 200, primary.logs());
    assert.deepEqual(await health.json(), { ok: true, demo: false, network: 'mainnet' });
    const config = await fetch(primary.base + '/api/config', { signal: AbortSignal.timeout(1000) });
    assert.equal(config.status, 200, 'Stalled Koinos and ETH probes cannot block configuration');
    assert.equal((await config.json()).demo, false);
    const who = await fetch(primary.base + '/api/whoami', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentialId }) });
    assert.equal((await who.json()).address, account);
    assert.equal(fs.readFileSync(path.join(data, 'funding-worker.lock'), 'utf8'), String(primary.child.pid));
    const frontend = await start(primary.base);
    const frontendConfig = await (await fetch(frontend.base + '/api/config')).json();
    assert.equal(frontendConfig.demo, false);
    assert.equal(frontendConfig.rpId, 'koinvault.app');
    assert.equal((await (await fetch(primary.base + '/api/config')).json()).rpId, 'wallet.usekoinos.com');
    const same = await fetch(frontend.base + '/api/whoami', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentialId }) });
    assert.equal((await same.json()).address, account);
    const recoveryRequest = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentialId: recoveryId }) };
    assert.equal((await fetch(primary.base + '/api/whoami', recoveryRequest)).status, 403, 'The original site sends recovery users to KOIN Vault');
    const recovered = await fetch(frontend.base + '/api/whoami', recoveryRequest);
    assert.equal(recovered.status, 200, 'The actual KOIN Vault forwarder retains recovery');
    assert.equal((await recovered.json()).address, account, 'Recovery opens the original address');
    assert.match(frontend.logs(), /ready: wallet frontend/);
    const connection = await (await fetch(frontend.base + '/api/dapp/create', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://ouro.lifestyle' }, body: JSON.stringify({ name: 'OURO' }) })).json();
    assert.ok(connection.uri.startsWith('https://koinvault.app/'));
    const proofBody = JSON.stringify({ sessionId: connection.sessionId, secret: connection.secret, address: account });
    assert.equal((await fetch(frontend.base + '/api/dapp/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://koinvault.app' }, body: proofBody })).status, 200);
    assert.equal((await fetch(frontend.base + '/api/dapp/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: proofBody })).status, 403);
    assert.equal(fs.readFileSync(path.join(data, 'funding-worker.lock'), 'utf8'), String(primary.child.pid));
    console.log('✓ Both real HTTP app processes use one account store and one funding lock; each domain keeps its own passkey settings');
    const second = await start();
    const blocked = await fetch(second.base + '/api/health');
    assert.equal(blocked.status, 503);
    assert.match((await blocked.json()).error, /startup failed/i);
    assert.match(second.logs(), /Another funding worker/);
    assert.equal(fs.readFileSync(path.join(data, 'funding-worker.lock'), 'utf8'), String(primary.child.pid));
    assert.deepEqual(fs.readFileSync(path.join(data, 'accounts.json')), saved);
    assert.equal((await fetch(primary.base + '/api/health')).status, 200);
    console.log('✓ Live startup survives stalled RPC and ETH checks; a second worker cannot replace the lock or account records');
  } finally {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit'); child.kill(); await exited;
    }));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
