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
  // Network calls never resolve. Live configuration and store loading must
  // still finish; no credentials or real chain transactions are used.
  fs.writeFileSync(preload, `
    const chain = require(${JSON.stringify(path.join(root, 'tools/chain.js'))});
    chain.sponsorAddress = () => 'test-sponsor';
    chain.mana = chain.koinBalance = () => new Promise(() => {});
    require(${JSON.stringify(path.join(root, 'tools/rpc.js'))}).pickRpcs = () => new Promise(() => {});
  `);
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
    const responseConfig = await fetch(base + '/api/config');
    assert.equal(responseConfig.status, 200, 'RPC availability must not gate configuration');
    const config = await responseConfig.json();
    assert.equal(config.demo, false, 'A live-configured wallet must not become demo due to RPC startup');
    const ready = await (await fetch(base + '/api/health')).json();
    assert.equal(ready.startup.stage, 'ready');
    assert.match(ready.startup.instance, /^[0-9a-f-]{36}$/);
    assert.ok(!JSON.stringify(ready).includes(dir));

    console.log('✓ Live wallet loads configuration and stores without waiting for public RPC');
  } finally {
    child.kill();
    await new Promise(r => child.once('exit', r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
