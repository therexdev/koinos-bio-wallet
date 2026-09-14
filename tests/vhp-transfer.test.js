'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const chain = require('../tools/chain');
const { NETWORKS } = require('../tools/rpc');
const source = fs.readFileSync(require.resolve('../server'), 'utf8');
const from = NETWORKS.mainnet.vhpContract;
const to = NETWORKS.mainnet.koinContract;
let balances = { koin: '0', vhp: '9007199254740993' }, mana = 100, prepared = 0;
const reads = [], remembered = [];
const context = {
  api: {}, DEMO: false, NETWORKS, CFG: { network: 'mainnet', minSponsorMana: 20, maxTransfersPerDayAddr: 100 },
  veive: { isSmartAccount: () => true, ensureReady: async () => {} },
  verifyProof: () => null,
  rateLimited: () => false,
  httpError: (status, message) => Object.assign(new Error(message), { status }),
  demoTxid: () => 'demo-id',
  rememberPrepared: (id, address, flags) => { remembered.push({ id, address, flags }); return 'prepared-ref'; },
  chain: {
    K: chain.K, isAddr: chain.isAddr, opKoinTransfer: chain.opKoinTransfer, opVhpTransfer: chain.opVhpTransfer,
    koinBalanceSats: async address => { assert.equal(address, from); reads.push('koin'); return balances.koin; },
    vhpBalanceSats: async address => { assert.equal(address, from); reads.push('vhp'); return balances.vhp; },
    sponsorAddress: () => 'sponsor', mana: async () => mana,
    prepareUserTx: async (address, operations, options) => {
      prepared++;
      assert.equal(address, from);
      assert.equal(options.rcLimit, chain.K.rcLimitSmart);
      return { id: 'exact-id', header: { payer: 'sponsor', payee: address, rc_limit: options.rcLimit }, operations };
    },
  },
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('const fromSats ='), source.indexOf('api.portfolio =')), context);
vm.runInContext(source.slice(source.indexOf('api.prepare ='), source.indexOf('/** Broadcast a signed prepared')), context);
const prepare = patch => context.api.prepare({ address: from, to, amount: '1', asset: 'vhp', ...patch }, 'fixture-ip');

async function checkOperation(result, contract, value) {
  assert.equal(result.tx.operations.length, 1);
  const call = result.tx.operations[0].call_contract;
  assert.equal(call.contract_id, contract);
  assert.equal(call.entry_point, 0x27f576ca, 'Native token transfer entry point');
  const decoded = await chain.tokenContractAt(contract).decodeOperation(result.tx.operations[0]);
  assert.deepEqual(decoded.args, { from, to, value });
  assert.equal(result.tx.header.payer, 'sponsor');
  assert.equal(result.tx.header.payee, from);
  assert.equal(remembered.at(-1).flags.smart, true, 'VHP requires the existing passkey submit path');
}

(async () => {
  for (const network of ['mainnet', 'harbinger']) {
    chain.configure({ network, rpcs: ['http://127.0.0.1:1'] });
    context.CFG.network = network;
    const result = await prepare({ amount: '90071992.54740993' });
    assert.equal(result.asset, 'vhp');
    await checkOperation(result, NETWORKS[network].vhpContract, balances.vhp);
    assert.equal(reads.at(-1), 'vhp', 'Zero KOIN never prevents a sponsored VHP send');
    await checkOperation(await prepare({ amount: '0.00000001' }), NETWORKS[network].vhpContract, '1');
    balances.koin = '123456789';
    const legacy = await prepare({ asset: undefined, amount: '1.23456789' });
    assert.equal(legacy.asset, 'koin', 'Old KOIN clients retain the default');
    await checkOperation(legacy, NETWORKS[network].koinContract, balances.koin);
    balances.koin = '0';
  }
  console.log('✓ Both networks serialize exact VHP transfers, including Send all above float precision and one satoshi; KOIN still works');

  const before = prepared;
  for (const asset of ['VHP', '', null, 'other', '__proto__', NETWORKS.mainnet.vhpContract, {}]) {
    await assert.rejects(prepare({ asset }), /choose KOIN or VHP/);
  }
  for (const amount of ['0', '0.00000000', '-1', '1e2', 'Infinity', 'NaN', '.5', '1.', '1.000000001']) {
    await assert.rejects(prepare({ amount }), /positive number/);
  }
  await assert.rejects(prepare({ amount: '184467440737.09551616' }), /transfer limit/);
  await assert.rejects(prepare({ to: 'bad-address' }), /destination/);
  await assert.rejects(prepare({ to: from }), /VHP to yourself/);
  balances.vhp = '100000001'; balances.koin = '999999999999';
  await assert.rejects(prepare({ amount: '1.00000002' }), /not enough VHP — you hold 1.00000001/);
  context.chain.vhpBalanceSats = async () => { throw new Error('RPC unavailable'); };
  await assert.rejects(prepare(), /RPC unavailable/, 'A VHP read error must not fall back to KOIN');
  context.chain.vhpBalanceSats = async () => balances.vhp;
  mana = 0;
  await assert.rejects(prepare(), /sponsor wallet is recharging/);
  mana = 100;
  assert.equal(prepared, before, 'Rejected requests must never prepare a signable transaction');
  balances.vhp = '18446744073709551615';
  await checkOperation(await prepare({ amount: '184467440737.09551615' }), NETWORKS.harbinger.vhpContract, balances.vhp);
  context.DEMO = true;
  assert.equal((await prepare()).asset, 'vhp', 'Demo also identifies the prepared asset');
  context.veive.isSmartAccount = () => false;
  context.verifyProof = () => 'missing legacy proof';
  await assert.rejects(prepare(), /missing legacy proof/);
  console.log('✓ Reject wrong assets, insufficient VHP, malformed amounts, overflow, failed balance reads and missing authorization');
})().catch(e => { console.error(e); process.exitCode = 1; });
