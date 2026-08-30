/* ============================================================
   Wire-format proof for the WebAuthn signature packer.

   The reference vector comes from Veive's own module test suite
   (mod-sign-webauthn-as/tests/mod-sign-webauthn-e2e.spec.ts): a real
   authenticator assertion that their deployed contract verified. If
   our packer reproduces that blob byte-for-byte from its parts, the
   wallet's signatures are in exactly the format the chain expects.

   Run: node tests/wire-format.test.js
   ============================================================ */
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Wire = require(path.join(__dirname, '..', 'public', 'js', 'webauthn-wire.js'));
const { Serializer, utils } = require('koilib');

/* Verbatim from Veive's mod-sign-webauthn-as e2e spec (a real device assertion). */
const TEST_DATA = {
  CREDENTIAL_ID: 'fDy_0augtGWmEyId1pKCNfiJgh7PHpM9ma3QiEjRlY4',
  SIGNATURE: 'CitmRHlfMGF1Z3RHV21FeUlkMXBLQ05maUpnaDdQSHBNOW1hM1FpRWpSbFk0EkYwRAIgc6P7ynTGRZrC-zUnLol6gmwF7tKkwTQR5BUG7iYs2HICICDa1yU_Bstlk50hL10ETjk7xEWEoS_YBz9txsZfKTmRGiVJlg3liA6MaHQ0Fw9kdmBbj-SuuaKGMseZXPO6gx2XYwUAAAACIrkBeyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiTUhneE1qSXdZakZsTmpsaVpUQTFZelZsWkRGbU5HWm1aalk0WldZMFl6TXhOamd4TkRKbE5XTTVaV0prTVRnMU5tWmxNamRpWVdGaU4yTmtObUZpTlRZd09XSTBZZyIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6MzAwMCIsImNyb3NzT3JpZ2luIjpmYWxzZX0=',
  TX_ID: '0x1220b1e69be05c5ed1f4fff68ef4c3168142e5c9ebd1856fe27baab7cd6ab5609b4b',
};

const MODSIGN_ABI = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'contracts', 'vendor', 'mod-sign-webauthn', 'modsignwebauthn-abi.json')));

/** Port of the contract's ASN.1 reader (mod-sign-webauthn utils.extractSignature)
    — what the CHAIN will do to whatever DER we send. */
function contractExtractSignature(sig) {
  const rStart = sig[4] === 0 ? 5 : 4;
  const rEnd = rStart + 32;
  const sStart = sig[rEnd + 2] === 0 ? rEnd + 3 : rEnd + 2;
  return Buffer.concat([Buffer.from(sig.slice(rStart, rEnd)), Buffer.from(sig.slice(sStart))]);
}

(async () => {
  const raw = utils.decodeBase64url(TEST_DATA.SIGNATURE);
  const ser = new Serializer(MODSIGN_ABI.koilib_types);
  const parts = await ser.deserialize(raw, 'authentication_data');

  /* 1 — our hand-rolled protobuf writer reproduces Veive's blob byte-for-byte */
  const packed = Wire.packAuthenticationData({
    credentialId: parts.credential_id,
    signature: utils.decodeBase64url(parts.signature),
    authenticatorData: utils.decodeBase64url(parts.authenticator_data),
    clientDataJSON: utils.decodeBase64url(parts.client_data),
  });
  assert.strictEqual(Buffer.from(packed).toString('hex'), Buffer.from(raw).toString('hex'),
    'hand-rolled protobuf must equal the reference blob');
  console.log('✓ packAuthenticationData reproduces the Veive vector byte-for-byte (' + raw.length + ' bytes)');

  /* 2 — koilib Serializer agrees (independent encoder, same bytes) */
  const reSer = await ser.serialize(parts, 'authentication_data');
  assert.strictEqual(Buffer.from(reSer).toString('hex'), Buffer.from(raw).toString('hex'));
  console.log('✓ koilib Serializer round-trip is also byte-identical');

  /* 3 — the full signature entry (0xFF02 prefix + base64url) matches the module e2e packing */
  const prefixed = new Uint8Array(2 + raw.length);
  prefixed[0] = 0xff; prefixed[1] = 0x02; prefixed.set(raw, 2);
  const expectedEntry = utils.encodeBase64url(prefixed).replace(/=+$/, '');
  const derSig = utils.decodeBase64url(parts.signature);
  const ourEntry = Wire.packSignatureBlob({
    credentialId: parts.credential_id,
    signature: derSig, // raw DER in → normalized inside
    authenticatorData: utils.decodeBase64url(parts.authenticator_data),
    clientDataJSON: utils.decodeBase64url(parts.client_data),
  });
  // Our entry normalizes the DER (72B vs their 70B) — same r,s once the contract parses it:
  const ourBlob = Wire.decodeB64u(ourEntry);
  assert.deepStrictEqual([ourBlob[0], ourBlob[1]], [0xff, 0x02], 'prefix');
  const ourParts = await ser.deserialize(ourBlob.subarray(2), 'authentication_data');
  assert.strictEqual(ourParts.credential_id, parts.credential_id);
  assert.strictEqual(ourParts.authenticator_data, parts.authenticator_data);
  assert.strictEqual(ourParts.client_data, parts.client_data);
  const rsTheirs = contractExtractSignature(derSig);
  const rsOurs = contractExtractSignature(utils.decodeBase64url(ourParts.signature));
  assert.strictEqual(rsOurs.toString('hex'), rsTheirs.toString('hex'),
    'contract must extract identical r‖s from the normalized DER');
  /* The node's JSON codec REQUIRES padded base64url in transaction.signatures
     — an unpadded entry is rejected with "Unable to translate request". */
  assert.strictEqual(ourEntry.length % 4, 0, 'signature entry must be padded base64url');
  assert.strictEqual(utils.encodeBase64url(ourBlob), ourEntry, 'entry must match koilib\'s padded encoding exactly');
  console.log('✓ packSignatureBlob: 0xFF02 prefix + protobuf verified; normalized DER parses to identical r‖s on-chain; node-safe PADDED base64url');
  // And when the DER is already in reference shape, byte-equality of the whole entry:
  assert.strictEqual(
    Wire.encodeB64u(prefixed), expectedEntry,
    'reference prefix+encode self-check');

  /* 4 — DER normalization survives the pathological short-integer cases */
  function derFrom(r, s) {
    function int(v) {
      let b = Buffer.from(v);
      while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
      if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); // minimal DER pad
      return Buffer.concat([Buffer.from([0x02, b.length]), b]);
    }
    const body = Buffer.concat([int(r), int(s)]);
    return Buffer.concat([Buffer.from([0x30, body.length]), body]);
  }
  const cases = [
    ['r short (31 bytes)', Buffer.concat([Buffer.from([0]), Buffer.alloc(30, 7), Buffer.from([9])]), Buffer.alloc(32, 0x44)],
    ['s short (30 bytes)', Buffer.alloc(32, 0x22), Buffer.concat([Buffer.from([0, 0]), Buffer.alloc(29, 5), Buffer.from([1])])],
    ['both high bit (33-byte DER ints)', Buffer.alloc(32, 0xee), Buffer.alloc(32, 0x91)],
    ['r tiny (1 byte)', Buffer.concat([Buffer.alloc(31, 0), Buffer.from([2])]), Buffer.alloc(32, 0x33)],
  ];
  for (const [name, r, s] of cases) {
    const der = derFrom(r, s);
    const wide = Wire.normalizeDerSignature(der);
    assert.strictEqual(wide.length, 72, name + ': normalized length');
    const rs = contractExtractSignature(wide);
    assert.strictEqual(rs.toString('hex'), Buffer.concat([pad32(r), pad32(s)]).toString('hex'),
      name + ': contract-extracted r‖s must equal the padded true values');
  }
  function pad32(v) { const o = Buffer.alloc(32); Buffer.from(v).copy(o, 32 - Math.min(32, v.length), Math.max(0, v.length - 32)); return o; }
  console.log('✓ DER normalization: short-r, short-s, high-bit and tiny-integer cases all extract correctly on-chain');

  /* 5 — the challenge rule: ASCII of the 0x-hex tx id */
  const challenge = JSON.parse(Buffer.from(utils.decodeBase64url(parts.client_data)).toString('utf8')).challenge;
  const fromRule = Wire.encodeB64u(Wire.challengeForTxId(TEST_DATA.TX_ID));
  assert.strictEqual(fromRule, challenge.replace(/=+$/, ''), 'challenge must be base64url(ASCII(txId))');
  console.log('✓ challenge rule confirmed: base64url(ASCII("' + TEST_DATA.TX_ID.slice(0, 14) + '…"))');

  /* 6 — our own base64url agrees with koilib both ways */
  assert.strictEqual(Wire.encodeB64u(raw), utils.encodeBase64url(raw).replace(/=+$/, ''));
  assert.strictEqual(Buffer.from(Wire.decodeB64u(TEST_DATA.SIGNATURE)).toString('hex'), Buffer.from(raw).toString('hex'));
  console.log('✓ base64url encoder/decoder agrees with koilib');

  console.log('\nALL WIRE-FORMAT CHECKS PASSED');
})().catch((e) => { console.error('WIRE-FORMAT FAIL:', e.message); process.exit(1); });
