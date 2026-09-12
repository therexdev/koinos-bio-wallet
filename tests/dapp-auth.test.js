'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const chain = require('../tools/chain');
const auth = require('../tools/dapp-auth');
const origin = 'https://wallet.example';
async function proof(challenge, overrides = {}) {
  const data = Buffer.alloc(37);
  crypto.createHash('sha256').update('wallet.example').digest().copy(data);
  data[32] = overrides.flags ?? 5;
  const client = { type: 'webauthn.get', origin, challenge: Buffer.from(challenge).toString('base64url'), ...overrides.client };
  const bytes = await chain.modSignSerializer().serialize({ credential_id: 'test', signature: 'AA==', authenticator_data: data.toString('base64url'), client_data: Buffer.from(JSON.stringify(client)).toString('base64url') }, 'authentication_data');
  return Buffer.concat([Buffer.from([255, 2]), bytes]).toString('base64url');
}
(async () => {
  const verifier = { modSignSerializer: chain.modSignSerializer, verifyPasskeyOnChain: async () => ({ ok: true }) };
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
  await assert.rejects(auth.verify('session', 'address', c, await proof(c), { ...verifier, verifyPasskeyOnChain: async () => ({ ok: null }) }), /Could not verify/);
  // Verifier ABI requires HEX; connection challenge is not a valid transaction multihash.
  assert.ok(c.startsWith('0x62696f'));
  const abi = require('../contracts/vendor/mod-sign-webauthn/modsignwebauthn-abi.json');
  await chain.modSignSerializer().serialize({ sender: chain.newAccountKey().getAddress(), signature: sig, tx_id: c }, abi.methods.is_valid_signature.argument);
  console.log('✓ Fresh connection proof: replay, session, origin, challenge, user verification and unavailable verifier checks');
})().catch(e => { console.error(e); process.exitCode = 1; });
