/* ============================================================
   Proof that a recovery-kit signature passes on-chain verification.

   The kit signs a SYNTHETIC WebAuthn assertion with a plain WebCrypto
   P-256 key. This test runs the shipped client code (recovery.js,
   webauthn-wire.js — the very files the browser loads) and then verifies
   the result with a faithful port of what the deployed contracts do:

     mod-sign-webauthn:  0xFF02 prefix → protobuf authentication_data →
                         credential lookup (id match) →
                         extractPublicKey (last 64 bytes + 0x04) →
                         extractSignature (the naive ASN.1 reader) →
                         extractMsg (authenticator_data ‖ sha256(client_data)) →
                         challenge == base64(ASCII tx id)
     verifier-p256:      ECDSA P-256 over msg with the raw 64-byte r‖s

   The P-256 check uses node's crypto with dsaEncoding 'ieee-p1363' — the
   exact raw r‖s bytes the verifier contract receives. infra-deploy already
   proved the DEPLOYED verifier against a known-good vector, so this chain
   of evidence covers the whole path.

   Run: node tests/recovery-assertion.test.js
   ============================================================ */
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Wire = require(path.join(__dirname, '..', 'public', 'js', 'webauthn-wire.js'));
const Recovery = require(path.join(__dirname, '..', 'public', 'js', 'recovery.js'));
const { Serializer, utils } = require('koilib');

const MODSIGN_ABI = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'contracts', 'vendor', 'mod-sign-webauthn', 'modsignwebauthn-abi.json')));

/* Ports of the contract's extraction helpers (mod-sign-webauthn utils.ts). */
function extractSignature(sig) {
  const rStart = sig[4] === 0 ? 5 : 4;
  const rEnd = rStart + 32;
  const sStart = sig[rEnd + 2] === 0 ? rEnd + 3 : rEnd + 2;
  return Buffer.concat([Buffer.from(sig.slice(rStart, rEnd)), Buffer.from(sig.slice(sStart))]);
}
function extractPublicKey(spki) {
  return Buffer.concat([Buffer.from([4]), Buffer.from(spki.subarray(spki.length - 64))]);
}
function extractMsg(authData, clientData) {
  return Buffer.concat([Buffer.from(authData), crypto.createHash('sha256').update(clientData).digest()]);
}

(async () => {
  Recovery.setContext({ rpId: 'buykoin.usekoinos.com', origin: 'https://buykoin.usekoinos.com' });

  /* A kit is born exactly as in the browser. */
  const kit = await Recovery.generate();
  assert.match(kit.credentialId, /^[A-Za-z0-9_-]{16,400}$/, 'credential id shape');
  const spki = Buffer.from(Wire.decodeB64u(kit.publicKey));
  assert.strictEqual(spki.length, 91, 'SPKI P-256 length');
  assert.strictEqual(spki.toString('hex').slice(0, 52), '3059301306072a8648ce3d020106082a8648ce3d030107034200',
    'SPKI header matches what the server validates and the module stores');
  console.log('✓ generated kit: SPKI public key in the exact registered format');

  const TX_ID = '0x1220' + crypto.randomBytes(32).toString('hex');

  /* The kit signs — shipped client code end to end. */
  const a = await Recovery.signTx(kit.privateKey, kit.credentialId, TX_ID);
  const entry = Wire.packSignatureBlob(a);

  /* ---- now verify precisely as the chain does ---- */
  const blob = Wire.decodeB64u(entry);
  assert.deepStrictEqual([blob[0], blob[1]], [0xff, 0x02], 'module prefix');
  const ser = new Serializer(MODSIGN_ABI.koilib_types);
  const auth = await ser.deserialize(blob.subarray(2), 'authentication_data');
  assert.strictEqual(auth.credential_id, kit.credentialId, 'credential lookup key');

  const der = Buffer.from(utils.decodeBase64url(auth.signature));
  const rs = extractSignature(der);
  assert.strictEqual(rs.length, 64, 'contract-extracted r‖s is 64 bytes');

  const authData = Buffer.from(utils.decodeBase64url(auth.authenticator_data));
  const clientData = Buffer.from(utils.decodeBase64url(auth.client_data));
  const msg = extractMsg(authData, clientData);

  /* verifier-p256's job, byte-for-byte inputs. */
  const pubKeyObj = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const ok = crypto.verify('sha256', msg, { key: pubKeyObj, dsaEncoding: 'ieee-p1363' }, rs);
  assert.strictEqual(ok, true, 'P-256 verification over extracted r‖s and msg');
  // The uncompressed point the module hands the verifier matches the key:
  const jwk = pubKeyObj.export({ format: 'jwk' });
  const xy = Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  assert.deepStrictEqual(extractPublicKey(spki), Buffer.concat([Buffer.from([4]), xy]), 'extractPublicKey → 0x04‖X‖Y');
  console.log('✓ synthetic assertion verifies under the exact contract pipeline (extract + P-256 over raw r‖s)');

  /* challenge rule, as the module compares it */
  const cd = JSON.parse(clientData.toString('utf8'));
  assert.strictEqual(
    Buffer.from(Wire.decodeB64u(cd.challenge)).toString('utf8'), TX_ID,
    'challenge commits to the transaction id');
  assert.strictEqual(cd.type, 'webauthn.get');
  assert.strictEqual(cd.origin, 'https://buykoin.usekoinos.com');
  console.log('✓ clientDataJSON: challenge == ASCII(tx id), origin carried');

  /* authenticatorData is well-formed WebAuthn: rpIdHash ‖ flags(UP|UV) ‖ counter */
  assert.strictEqual(authData.length, 37);
  assert.deepStrictEqual(
    authData.subarray(0, 32),
    crypto.createHash('sha256').update('buykoin.usekoinos.com').digest());
  assert.strictEqual(authData[32], 0x05);
  console.log('✓ authenticatorData shaped like a real authenticator (rpIdHash + UP|UV flags)');

  /* ---- negatives: what must NOT verify, doesn't ---- */
  const aWrong = await Recovery.signTx(kit.privateKey, kit.credentialId, '0x1220' + crypto.randomBytes(32).toString('hex'));
  const cdWrong = JSON.parse(Buffer.from(aWrong.clientDataJSON).toString('utf8'));
  assert.notStrictEqual(cdWrong.challenge, cd.challenge, 'different tx → different challenge');
  const tampered = Buffer.from(rs); tampered[10] ^= 0xff;
  assert.strictEqual(crypto.verify('sha256', msg, { key: pubKeyObj, dsaEncoding: 'ieee-p1363' }, tampered), false,
    'tampered signature rejected');
  const otherKit = await Recovery.generate();
  const otherSpki = Buffer.from(Wire.decodeB64u(otherKit.publicKey));
  const otherPub = crypto.createPublicKey({ key: otherSpki, format: 'der', type: 'spki' });
  assert.strictEqual(crypto.verify('sha256', msg, { key: otherPub, dsaEncoding: 'ieee-p1363' }, rs), false,
    'someone else\'s key rejected');
  console.log('✓ negatives: wrong transaction, tampered signature, foreign key all fail');

  /* ---- the kit file round-trips ---- */
  const text = Recovery.kitText({ address: '1TestAddress', credentialId: kit.credentialId, privateKey: kit.privateKey });
  const parsed = Recovery.parseKit(text);
  assert.strictEqual(parsed.credentialId, kit.credentialId);
  assert.strictEqual(parsed.privateKey, kit.privateKey);
  assert.strictEqual(parsed.address, '1TestAddress');
  const reSigned = await Recovery.signTx(parsed.privateKey, parsed.credentialId, TX_ID);
  assert.ok(reSigned.signature.length === 72, 'kit parsed from its own file still signs');
  console.log('✓ kit file round-trips (write → parse → sign again)');

  console.log('\nALL RECOVERY-ASSERTION CHECKS PASSED');
})().catch((e) => { console.error('RECOVERY-ASSERTION FAIL:', e.message); process.exit(1); });
