'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const chain = require('../tools/chain');
const auth = require('../tools/dapp-auth');
const wire = require('../public/js/webauthn-wire');
const origin = 'https://wallet.example';
const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
async function proof(challenge, overrides = {}) {
  const data = Buffer.alloc(37);
  crypto.createHash('sha256').update('wallet.example').digest().copy(data);
  data[32] = overrides.flags ?? 5;
  const client = { type: 'webauthn.get', origin, challenge: Buffer.from(challenge).toString('base64url'), ...overrides.client };
  const clientBytes = Buffer.from(JSON.stringify(client));
  const message = Buffer.concat([data, crypto.createHash('sha256').update(clientBytes).digest()]);
  const signature = crypto.sign('sha256', message, overrides.privateKey || pair.privateKey);
  if (overrides.tamper) signature[signature.length - 1] ^= 1;
  return wire.packSignatureBlob({ credentialId: overrides.credentialId || 'test', signature, authenticatorData: data, clientDataJSON: clientBytes });
}
(async () => {
  const verifier = { modSignSerializer: chain.modSignSerializer, accountCredentials: async address => {
    assert.equal(address, 'address');
    return [{ credential_id: 'test', public_key: publicKey }];
  } };
  let c = auth.issue('session', 'address', origin, 'wallet.example');
  const sig = await proof(c);
  await auth.verify('session', 'address', c, sig, verifier);
  await assert.rejects(auth.verify('session', 'address', c, sig, verifier), /expired/);
  for (const overrides of [{ flags: 1 }, { client: { origin: 'https://evil.example' } }, { client: { crossOrigin: true } }, { client: { challenge: 'wrong' } }]) {
    c = auth.issue('session', 'address', origin, 'wallet.example');
    await assert.rejects(auth.verify('session', 'address', c, await proof(c, overrides), verifier));
  }
  c = auth.issue('session', 'address', origin, 'wallet.example');
  await assert.rejects(auth.verify('other-session', 'address', c, await proof(c), verifier), /expired/);
  c = auth.issue('session', 'address', origin, 'wallet.example');
  await assert.rejects(auth.verify('session', 'address', c, await proof(c), { ...verifier, accountCredentials: async () => { throw new Error('RPC unavailable'); } }), /Could not read/);
  for (const overrides of [{ tamper: true }, { credentialId: 'unregistered' }, { privateKey: crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey }]) {
    c = auth.issue('session', 'address', origin, 'wallet.example');
    await assert.rejects(auth.verify('session', 'address', c, await proof(c, overrides), verifier));
  }
  for (const credentials of [[], [{ credential_id: 'test', public_key: 'invalid' }]]) {
    c = auth.issue('session', 'address', origin, 'wallet.example');
    await assert.rejects(auth.verify('session', 'address', c, await proof(c), { ...verifier, accountCredentials: async () => credentials }));
  }
  // Verifier ABI requires HEX; connection challenge is not a valid transaction multihash.
  assert.ok(c.startsWith('0x62696f'));
  const abi = require('../contracts/vendor/mod-sign-webauthn/modsignwebauthn-abi.json');
  await chain.modSignSerializer().serialize({ sender: chain.newAccountKey().getAddress(), signature: sig, tx_id: c }, abi.methods.is_valid_signature.argument);
  console.log('✓ Connection proof: real P-256 signatures, tampering, wrong key, registry failures, replay, session, origin, challenge and user verification');
})().catch(e => { console.error(e); process.exitCode = 1; });
