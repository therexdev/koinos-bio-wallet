'use strict';
const crypto = require('node:crypto');
const pending = new Map();
function issue(session, address, origin, rpId) {
  for (const [key, value] of pending) if (value.expires <= Date.now()) pending.delete(key);
  // HEX for the on-chain verifier, with a domain prefix that cannot be a transaction id.
  const challenge = '0x' + Buffer.from('bio-wallet:connect:').toString('hex') + crypto.randomBytes(32).toString('hex');
  pending.set(challenge, { session, address, origin, rpId, expires: Date.now() + 120000 });
  return challenge;
}
async function verify(session, address, challenge, signature, chain) {
  const expected = pending.get(challenge);
  pending.delete(challenge); // single use, including failed attempts
  if (!expected || expected.session !== session || expected.address !== address || expected.expires <= Date.now()) throw new Error('Connection approval expired; scan again');
  const raw = Buffer.from(String(signature || ''), 'base64url');
  if (raw.length > 8192 || raw[0] !== 255 || raw[1] !== 2) throw new Error('Passkey approval required');
  const auth = await chain.modSignSerializer().deserialize(raw.subarray(2), 'authentication_data');
  const client = JSON.parse(Buffer.from(auth.client_data, 'base64url').toString());
  const data = Buffer.from(auth.authenticator_data, 'base64url');
  if (client.type !== 'webauthn.get' || client.origin !== expected.origin || client.crossOrigin === true || client.challenge !== Buffer.from(challenge).toString('base64url')) throw new Error('Passkey approval does not match this connection');
  if (data.length < 37 || (data[32] & 5) !== 5 || !data.subarray(0, 32).equals(crypto.createHash('sha256').update(expected.rpId).digest())) throw new Error('Fresh device verification required');
  const result = await chain.verifyPasskeyOnChain(address, signature, challenge);
  if (result.ok !== true) throw new Error('Could not verify your passkey on-chain. Please try again.');
}
module.exports = { issue, verify };
