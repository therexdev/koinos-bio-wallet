'use strict';
const assert = require('node:assert/strict');
const { Signer, Transaction, Contract, utils } = require('koilib');
const { validateLaunch } = require('../tools/dapp-launch');
const relay = require('../tools/dapp-relay');
const koin = '19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK';
const owner = Signer.fromSeed('launch-owner').getAddress();
const collection = Signer.fromSeed('launch-collection');
const payer = Signer.fromSeed('launch-payer').getAddress();
const treasury = Signer.fromSeed('launch-treasury').getAddress();
const chainId = utils.encodeBase64url(new Uint8Array(34).fill(1));
const chain = { isAddr: require('../tools/chain').isAddr, chainId: async () => chainId, net: () => ({ koinContract: koin }) };
async function fixture(from = owner) {
  const abi = JSON.parse(JSON.stringify(utils.tokenAbi));
  const nested = abi.koilib_types?.nested?.koinos?.nested;
  if (nested) { delete nested.btype; delete nested._btype; }
  const fee = await new Contract({ id: koin, abi }).encodeOperation({ name: 'transfer', args: { from, to: treasury, value: '10000000000' } });
  const tx = await Transaction.prepareTransaction({ header: { chain_id: chainId, rc_limit: '20000000000', nonce: 'CAE=', payer, payee: collection.getAddress() }, operations: [fee, { upload_contract: { contract_id: collection.getAddress(), bytecode: 'AGFzbQEAAAA=' } }] });
  await collection.signTransaction(tx); return tx;
}
(async () => {
  const session = { origin: 'https://ouro.lifestyle', address: owner };
  const tx = await fixture();
  const result = await validateLaunch(session, tx, chain);
  assert.equal(result.mode, 'launch'); assert.match(result.summary.detail, /100\.00000000 KOIN/);
  assert.equal(result.transaction.id, tx.id);
  assert.throws(() => relay.validateOperations(tx.operations), /contract calls only/);
  await assert.rejects(validateLaunch({ ...session, origin: 'https://evil.example' }, tx, chain), /Only OURO/);
  const tampered = JSON.parse(JSON.stringify(tx)); tampered.operations[1].upload_contract.bytecode = 'AGFzbQEAAAAB';
  await assert.rejects(validateLaunch(session, tampered, chain), /altered/);
  await assert.rejects(validateLaunch(session, await fixture(treasury), chain), /Invalid launch fee/);
  await assert.rejects(validateLaunch(session, { ...tx, signatures: [] }, chain), /signed/);
  await assert.rejects(validateLaunch(session, tx, { ...chain, chainId: async () => 'another-chain' }), /different chain/);
  const extra = JSON.parse(JSON.stringify(tx)); extra.operations.push(tx.operations[0]);
  await assert.rejects(validateLaunch(session, extra, chain), /fee and contract upload/);
  console.log('✓ Atomic launch validation: signed upload, decoded fee, origin, owner, chain, operation integrity and ordinary-request isolation');
})().catch(e => { console.error(e); process.exitCode = 1; });
