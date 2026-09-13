'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { K } = require('../tools/chain');
const source = fs.readFileSync(require.resolve('../server'), 'utf8');
let available = BigInt(K.rcLimitDapp), prepared = 0, requests = 0;
const session = { address: 'user', origin: 'https://trade.example' };
const context = {
  dappProducer: require("../tools/dapp-producer"),
  api: {}, DEMO: false, CFG: {}, BigInt,
  dappSession: () => session,
  rateLimited: () => false,
  httpError: (status, message) => Object.assign(new Error(message), { status }),
  veive: { ensureReady: async () => {} },
  chain: {
    K,
    sponsorAddress: () => 'sponsor',
    provider: () => ({ getAccountRc: async payer => { assert.equal(payer, 'sponsor'); return available.toString(); } }),
    prepareUserTx: async (address, operations, options) => {
      prepared++;
      assert.equal(address, 'user');
      assert.equal(options.rcLimit, K.rcLimitDapp);
      return { id: 'prepared', header: { payer: 'sponsor', rc_limit: options.rcLimit } };
    },
  },
  dappRelay: {
    validateOperations: ops => ops,
    addRequest: (s, data) => { requests++; return { id: 'request', expires: 1, ...data }; },
  },
};
vm.runInNewContext(source.slice(source.indexOf('api.dappRequest ='), source.indexOf('api.dappPending =')), context);
(async () => {
  const request = () => context.api.dappRequest({ operations: [] }, 'ip', null, { headers: { origin: session.origin } });
  available--;
  await assert.rejects(request(), /sponsor needs/);
  assert.equal(prepared, 0);
  assert.equal(requests, 0);
  available++;
  await request();
  assert.equal(prepared, 1);
  assert.equal(requests, 1);
  assert.equal(K.rcLimitSmart, '2000000000', 'ordinary wallet budget unchanged');
  console.log('✓ dApp preparation checks sponsor mana before approval and signs the trade budget');
})().catch(e => { console.error(e); process.exitCode = 1; });
