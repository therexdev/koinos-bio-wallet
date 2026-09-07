'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const origin = 'https://wallet.example';
function worker(file) {
  const handlers = {}, stores = new Map(), deleted = [], installed = [];
  const key = input => new URL(typeof input === 'string' ? input : input.url, origin).pathname;
  const caches = {
    async keys() { return [...stores.keys()]; },
    async delete(k) { deleted.push(k); return stores.delete(k); },
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async add(u) { installed.push(u); store.set(key(u), new Response('cached ' + u)); },
        async put(req, res) { store.set(key(req), res); },
        async match(req) { return store.get(key(req))?.clone(); },
      };
    },
  };
  const ctx = vm.createContext({ URL, Response, caches, fetch: async () => { throw new Error('offline'); }, self: {
    location: { origin }, clients: { claim: async () => {} }, skipWaiting: async () => {},
    addEventListener: (event, fn) => { handlers[event] = fn; },
  }});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx);
  const lifecycle = async name => { let done; handlers[name]({ waitUntil(p) { done = p; } }); await done; };
  const request = async (url, method = 'GET', mode = 'navigate') => {
    let response;
    handlers.fetch({ request: { url: origin + url, method, mode }, respondWith(p) { response = p; } });
    return response;
  };
  return { stores, installed, deleted, lifecycle, request };
}
(async () => {
  const android = worker('public/android/sw.js');
  android.stores.set('bio-wallet-shell-v3', new Map([['/', new Response('OLD BUY PAGE')]]));
  android.stores.set('bio-wallet-android-shell-old', new Map());
  await android.lifecycle('install'); await android.lifecycle('activate');
  assert.ok(android.installed.includes('/android/'));
  assert.ok(!android.installed.includes('/') && !android.installed.includes('/js/fund.js'));
  assert.deepEqual(android.deleted, ['bio-wallet-android-shell-old']);
  assert.equal(await (await android.request('/android/?tab=convert')).text(), 'cached /android/');
  assert.equal(await (await android.request('/android/missing')).text(), 'cached /android/');
  assert.equal(await android.request('/'), undefined, 'root web navigation is not replaced');
  assert.equal(await android.request('/js/fund.js'), undefined, 'funding script is not cached');
  for (const url of ['/api/fund/status', '/android/api/fund/start']) {
    assert.equal((await android.request(url, 'POST')).status, 403);
  }
  for (const url of ['/api/account', '/android/api/account', '/android/api/submit']) {
    assert.equal(await android.request(url), undefined, 'account and transaction APIs always use network');
  }
  const web = worker('public/sw.js');
  web.stores.set('bio-wallet-android-shell-v1', new Map());
  web.stores.set('bio-wallet-shell-v3', new Map());
  await web.lifecycle('activate');
  assert.deepEqual(web.deleted, ['bio-wallet-shell-v3']);
  assert.equal(await web.request('/android/'), undefined, 'website worker never falls back to Buy for Android');
  console.log('✓ Offline caches stay separate; Android never falls back to the website Buy page or caches financial APIs');
})().catch(e => { console.error(e); process.exitCode = 1; });
