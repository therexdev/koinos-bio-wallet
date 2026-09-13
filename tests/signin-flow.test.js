'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const status = { hidden: false, textContent: '' }, delays = [];
  let attempts = 0, resolved = false;
  const configContext = vm.createContext({
    $: () => status,
    api: async () => { attempts++; if (attempts === 1) throw new Error('HTTP 503'); if (attempts === 2) return {}; return { ok: true, demo: false, rpId: 'wallet.usekoinos.com' }; },
    setTimeout: callback => delays.push(callback),
  });
  vm.runInContext(source.slice(source.indexOf('  async function waitForConfig()'), source.indexOf('  // A failed request')), configContext);
  const ready = vm.runInContext('waitForConfig()', configContext).then(value => { resolved = true; return value; });
  await tick(); assert.equal(resolved, false); assert.match(status.textContent, /unavailable/);
  delays.shift()(); await tick(); assert.equal(resolved, false, 'Malformed configuration must not become demo mode');
  delays.shift()(); const config = await ready;
  assert.equal(config.demo, false); assert.equal(status.hidden, true);
  configContext.api = async () => ({ ok: true, demo: true });
  assert.equal((await vm.runInContext('waitForConfig()', configContext)).demo, true, 'An explicitly configured demo remains supported');

  const elements = new Map(), calls = [], identified = [], addresses = [];
  let failLookup = false, cancelled = false;
  function element(id) {
    if (!elements.has(id)) elements.set(id, { hidden: true, disabled: false, textContent: '', listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; }, insertAdjacentElement() {} });
    return elements.get(id);
  }
  const context = vm.createContext({
    $: element, document: { createElement: () => ({}) }, ADDRESS: null, RECOVERY: null,
    Passkey: { platformReady: async () => true, remembered: () => false,
      identify: async choose => {
        identified.push(choose);
        if (cancelled) { const e = new Error('Prompt closed'); e.name = 'NotAllowedError'; throw e; }
        return 'original-credential';
      },
      createCredential: () => { throw new Error('Legacy sign-in must never create a credential'); },
      forget: () => { throw new Error('Sign-in must not discard a passkey'); } },
    api: async (route, body) => {
      calls.push({ route, body }); assert.equal(route, '/api/whoami');
      if (failLookup) { const err = new Error('No account found'); err.status = 404; throw err; }
      return { address: 'original-account', step: 'active' };
    },
    storeAddr: address => addresses.push(address), takeSmart() {}, pollStatus() {}, show() {},
  });
  const start = source.indexOf('  /* ---------------- landing:');
  const end = source.indexOf('  /* Recovery-file sign-in');
  await vm.runInContext('(async () => {\n' + source.slice(start, end) + '\n})()', context);
  const click = id => element(id).listeners.click({ preventDefault() {} });
  await click('#btn-go'); assert.equal(addresses.at(-1), 'original-account');
  await click('#btn-unlock-existing'); assert.equal(identified.at(-1), true);
  failLookup = true;
  await click('#btn-go'); await click('#btn-go');
  assert.equal(element('#account-not-found').hidden, false, 'Unknown passkeys reveal the KOIN Vault signup link');
  assert.equal(calls.length, 4);
  cancelled = true;
  await click('#btn-go'); assert.equal(calls.length, 4, 'A closed prompt does not call signup or look up a credential');
  assert.equal(element('#account-not-found').hidden, true, 'Cancellation is not proof that an account does not exist');
  cancelled = false; failLookup = false;
  await click('#btn-go'); assert.equal(element('#account-not-found').hidden, true);
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /id="btn-go"[^>]*>Sign In<\/button>/);
  assert.match(html, /No account found for this passkey\.[\s\S]*?href="https:\/\/koinvault\.app\/"/);
  assert.match(html, /href="https:\/\/koinvault\.app\/\?open=recover"/);
  assert.ok(!/id="(?:kit-input|btn-recover|view-recover)"/.test(html), 'Recovery form is not shipped on the old site');
  assert.ok(!source.includes("api('/api/create-account'"), 'The old frontend cannot create an account');
  assert.ok(!source.includes('Recovery.parseKit('), 'The old frontend cannot import a recovery file');
  assert.ok(!elements.has('#btn-open-recover'), 'The recovery link must navigate normally without JavaScript interception');
  console.log('✓ Legacy sign-in never creates accounts; missing accounts link to KOIN Vault; recovery moves there; existing sign-in and config retries remain');
})().catch(e => { console.error(e); process.exitCode = 1; });
