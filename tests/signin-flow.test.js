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
  let failLookup = false, confirmed = false, creations = 0;
  function element(id) {
    if (!elements.has(id)) elements.set(id, { hidden: true, disabled: false, textContent: '', listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; }, insertAdjacentElement() {} });
    return elements.get(id);
  }
  const context = vm.createContext({
    $: element, document: { createElement: () => ({}) },
    ADDRESS: null, RECOVERY: null,
    Passkey: { platformReady: async () => true, remembered: () => false,
      identify: async choose => { identified.push(choose); return 'original-credential'; },
      createCredential: async () => { creations++; return { credentialId: 'new-credential', publicKey: 'fixture' }; },
      forget: () => { throw new Error('Sign-in must not discard a passkey or switch to creation'); } },
    api: async (route, body) => { calls.push({ route, body });
      if (route === '/api/whoami' && failLookup) { const err = new Error('Not found'); err.status = 404; throw err; }
      return { address: route === '/api/whoami' ? 'original-account' : 'new-account', step: 'active' }; },
    storeAddr: address => addresses.push(address), takeSmart() {}, pollStatus() {}, show() {}, confirm: () => confirmed,
  });
  const start = source.indexOf('  /* ---------------- landing:');
  const end = source.indexOf('  /* ---------------- recovery flow');
  await vm.runInContext('(async () => {\n' + source.slice(start, end) + '\n})()', context);
  const click = id => element(id).listeners.click({ preventDefault() {} });
  await click('#btn-go'); assert.equal(addresses.at(-1), 'original-account'); assert.equal(creations, 0);
  await click('#btn-unlock-existing'); assert.equal(identified.at(-1), true);
  failLookup = true;
  await click('#btn-go'); await click('#btn-go');
  assert.equal(creations, 0, 'Repeated failed sign-in never creates a replacement wallet');
  await click('#btn-create-account'); assert.equal(creations, 0, 'Cancelled creation cannot enroll or deploy');
  confirmed = true; await click('#btn-create-account');
  assert.equal(creations, 1); assert.equal(addresses.at(-1), 'new-account');
  assert.equal(calls.filter(c => c.route === '/api/create-account').length, 1);
  console.log('✓ Connection failures retry without fake demo mode; saved-passkey sign-in never creates accounts; creation requires a separate confirmed action');
})().catch(e => { console.error(e); process.exitCode = 1; });
