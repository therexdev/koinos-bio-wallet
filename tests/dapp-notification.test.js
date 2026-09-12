'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/js/app.js'), 'utf8');
const start = source.indexOf('  function paintDappRequest(');
const end = source.indexOf('  async function pollDapp(', start);
const elements = new Map();
let opened = 0, focused = 0;
const ctx = vm.createContext({
  DAPP_REQUEST: null, NET: 'mainnet',
  $: id => { if (!elements.has(id)) elements.set(id, { hidden: true, textContent: '', scrollIntoView() {}, focus() { focused++; } }); return elements.get(id); },
  UI: { showTab(id) { assert.equal(id, 'tab-security'); opened++; } }, dappSay() {},
});
vm.runInContext(source.slice(start, end), ctx);
ctx.app = { name: 'Trade Koinos', origin: 'https://app.tradekoinos.com' };
ctx.request = { id: 'first', summary: { title: 'Trade', network: 'mainnet' }, operations: [{ call_contract: { contract_id: 'example', entry_point: 123 } }] };
vm.runInContext('paintDappRequest(app, request)', ctx);
assert.equal(opened, 1); assert.equal(focused, 1);
assert.equal(elements.get('#dapp-request').hidden, false);
vm.runInContext('paintDappRequest(app, request)', ctx);
assert.equal(opened, 1, 'polling same request must not repeatedly steal focus');
vm.runInContext('paintDappRequest(null, null)', ctx);
assert.equal(elements.get('#dapp-request').hidden, true);
console.log('✓ Incoming requests become visible once, retain focus during polling and clear after handling');
