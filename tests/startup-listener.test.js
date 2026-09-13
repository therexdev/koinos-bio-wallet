'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
(async () => {
  const root = path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-boot-'));
  const preload = path.join(dir, 'preload.cjs');
  // Hold initialization until the test explicitly releases it. No chain
  // traffic, account data, credentials, or funding operations are used.
  fs.writeFileSync(preload, `require(${JSON.stringify(path.join(root, 'tools/rpc.js'))}).pickRpcs = () => new Promise((resolve, reject) => process.once('message', () => reject(new Error('simulated RPC outage'))));`);
  const portServer = http.createServer();
  await new Promise(r => portServer.listen(0, '127.0.0.1', r));
  const port = portServer.address().port;
  await new Promise(r => portServer.close(r));
  const child = spawn(process.execPath, ['--require', preload, 'server.js'], {
    cwd: root, env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: path.join(dir, 'data'), SPONSOR_WIF: 'unused', VERIFIER_ADDR: 'unused', MOD_SIGN_WEBAUTHN_ADDR: 'unused', MOD_VALIDATION_SIGNATURE_ADDR: 'unused' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = '';
  child.stdout.on('data', b => logs += b);
  child.stderr.on('data', b => logs += b);
  try {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 3000;
    let response;
    while (Date.now() < deadline) {
      try { response = await fetch(base); break; } catch (_) { await new Promise(r => setTimeout(r, 40)); }
    }
    assert.equal(response?.status, 200, 'HTTP must listen while RPC initialization is blocked: ' + logs);
    const blocked = await fetch(base + '/api/config');
    assert.equal(blocked.status, 503);
    assert.match((await blocked.json()).error, /starting/i);
    const starting = await (await fetch(base + '/api/health')).json();
    assert.equal(starting.startup.stage, 'probing-rpc');
    assert.match(starting.startup.instance, /^[0-9a-f-]{36}$/);
    assert.equal(typeof starting.startup.uptimeSeconds, 'number');
    assert.ok(!JSON.stringify(starting).includes(dir), 'No filesystem paths exposed');
    child.send('release');
    const readyDeadline = Date.now() + 3000;
    let config;
    while (Date.now() < readyDeadline) {
      const res = await fetch(base + '/api/config');
      if (res.ok) { config = await res.json(); break; }
      await new Promise(r => setTimeout(r, 40));
    }
    assert.equal(config?.demo, true);
    const ready = await (await fetch(base + '/api/health')).json();
    assert.equal(ready.startup.instance, starting.startup.instance);
    assert.equal(ready.startup.stage, 'ready');
    assert.match(config.note, /simulated RPC outage/);
    console.log('✓ HTTP starts before RPC; APIs stay gated until initialization completes');
  } finally {
    child.kill();
    await new Promise(r => child.once('exit', r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
