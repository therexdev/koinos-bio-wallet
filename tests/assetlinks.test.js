/* Digital Asset Links: the site's half of the Android app's identity.

   Chrome hides the URL bar in the Trusted Web Activity only when
   https://<host>/.well-known/assetlinks.json names the app's package and
   the SHA-256 of its signing certificate. The fingerprints come from the
   environment (they differ per signing key: upload key, Play app-signing
   key, a debug key), so this pins the file's shape and the not-configured
   answer, against the running server.

   Run: node tests/assetlinks.test.js
*/
'use strict';
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const FP1 = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const FP2 = '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';

function boot(extraEnv, port) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-al-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DEMO_MODE: '1', PORT: String(port), DATA_DIR: dataDir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => { child.kill(); reject(new Error('server did not start:\n' + out)); }, 15000);
    child.stdout.on('data', (d) => { out += d; if (/serving:/.test(out)) { clearTimeout(t); resolve(child); } });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error('server exited ' + c + '\n' + out)); });
  });
}

(async () => {
  /* --- 1. configured: the statement lists the package and every fingerprint --- */
  {
    const port = 3971;
    const s = await boot({ ANDROID_SHA256_FINGERPRINTS: `${FP1}, ${FP2.toLowerCase()}` }, port);
    try {
      const r = await fetch(`http://localhost:${port}/.well-known/assetlinks.json`);
      assert.strictEqual(r.status, 200);
      assert.match(r.headers.get('content-type'), /application\/json/);
      const j = await r.json();
      assert.ok(Array.isArray(j) && j.length === 1, 'one statement');
      assert.deepStrictEqual(j[0].relation, ['delegate_permission/common.handle_all_urls']);
      assert.strictEqual(j[0].target.namespace, 'android_app');
      assert.strictEqual(j[0].target.package_name, 'com.usekoinos.biowallet');
      assert.deepStrictEqual(j[0].target.sha256_cert_fingerprints, [FP1, FP2], 'fingerprints upper-cased and trimmed');
      /* Chrome fetches this cross-origin with no credentials; nothing may block it. */
      assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
      console.log('✓ assetlinks.json names the app and every configured fingerprint');
    } finally { s.kill(); }
  }

  /* --- 2. a custom package name --- */
  {
    const port = 3972;
    const s = await boot({ ANDROID_SHA256_FINGERPRINTS: FP1, ANDROID_PACKAGE: 'com.example.other' }, port);
    try {
      const j = await (await fetch(`http://localhost:${port}/.well-known/assetlinks.json`)).json();
      assert.strictEqual(j[0].target.package_name, 'com.example.other');
      console.log('✓ the package name follows ANDROID_PACKAGE');
    } finally { s.kill(); }
  }

  /* --- 3. not configured: a clear 404, never an empty statement that
         would look like a verification failure with no explanation --- */
  {
    const port = 3973;
    const s = await boot({ ANDROID_SHA256_FINGERPRINTS: '' }, port);
    try {
      const r = await fetch(`http://localhost:${port}/.well-known/assetlinks.json`);
      assert.strictEqual(r.status, 404);
      const j = await r.json();
      assert.match(j.error, /ANDROID_SHA256_FINGERPRINTS/);
      console.log('✓ unconfigured → 404 that names the variable to set');
    } finally { s.kill(); }
  }

  /* --- 4. garbage in the variable is rejected, not served --- */
  {
    const port = 3974;
    const s = await boot({ ANDROID_SHA256_FINGERPRINTS: 'not-a-fingerprint' }, port);
    try {
      const r = await fetch(`http://localhost:${port}/.well-known/assetlinks.json`);
      assert.strictEqual(r.status, 404);
      console.log('✓ a malformed fingerprint is not served');
    } finally { s.kill(); }
  }

  console.log('\nALL ASSETLINKS CHECKS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
