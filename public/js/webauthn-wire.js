/* ============================================================
   webauthn-wire — packs a WebAuthn assertion into the on-chain
   signature format Veive's mod-sign-webauthn contract verifies.

   The wire format (byte-exact, proven against the module's own
   test vector in tests/wire-format.test.js):

     transaction.signatures[i] = base64url(
       0xFF 0x02 ‖ protobuf modsignwebauthn.authentication_data {
         string credential_id     = 1;  // base64url of the raw credential id
         bytes  signature         = 2;  // the assertion's ECDSA DER, normalized (below)
         bytes  authenticator_data = 3; // assertion.response.authenticatorData verbatim
         bytes  client_data       = 4;  // assertion.response.clientDataJSON verbatim
       }
     )

   The WebAuthn challenge MUST be the ASCII bytes of the "0x"-prefixed
   lowercase-hex transaction id — the contract recomputes it from the
   transaction and compares against clientDataJSON.challenge.

   DER normalization: the contract's ASN.1 reader assumes r and s are
   encoded in exactly 32 bytes (optionally led by one 0x00 pad). A
   naturally short r or s (~1 in 256 signatures) would fail on-chain,
   so every DER is re-encoded with both integers as 0x00 + 32 padded
   bytes — always parseable, value unchanged.

   Zero dependencies; loads in the browser (window.WebauthnWire) and
   in node (module.exports) so tests exercise the very same code the
   wallet ships.
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WebauthnWire = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- bytes + base64url ---------- */

  function toU8(x) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    throw new Error('expected bytes');
  }

  const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function encodeB64u(bytes) {
    bytes = toU8(bytes);
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      out += B64U[b0 >> 2] + B64U[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
      out += b1 === undefined ? '' : B64U[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
      out += b2 === undefined ? '' : B64U[b2 & 63];
    }
    return out; // unpadded
  }
  function decodeB64u(str) {
    str = String(str).replace(/=+$/, '');
    const out = new Uint8Array(Math.floor(str.length * 3 / 4));
    let o = 0, buf = 0, bits = 0;
    for (let i = 0; i < str.length; i++) {
      const v = B64U.indexOf(str[i] === '+' ? '-' : str[i] === '/' ? '_' : str[i]);
      if (v < 0) throw new Error('bad base64url');
      buf = (buf << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 0xff; }
    }
    return out.subarray(0, o);
  }

  /* ---------- minimal protobuf writer (length-delimited fields) ---------- */

  function varint(n) {
    const out = [];
    while (n > 127) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
    out.push(n);
    return out;
  }
  function ldField(fieldNo, bytes) {
    bytes = toU8(bytes);
    return [ (fieldNo << 3) | 2, ...varint(bytes.length), ...bytes ];
  }

  /* ---------- DER signature normalization ---------- */

  /** Parse an ECDSA ASN.1 DER signature into { r, s } (Uint8Array, minimal). */
  function parseDer(der) {
    der = toU8(der);
    let i = 0;
    if (der[i++] !== 0x30) throw new Error('DER: not a sequence');
    let seqLen = der[i++];
    if (seqLen & 0x80) { const n = seqLen & 0x7f; seqLen = 0; for (let k = 0; k < n; k++) seqLen = (seqLen << 8) | der[i++]; }
    function readInt() {
      if (der[i++] !== 0x02) throw new Error('DER: expected integer');
      let len = der[i++];
      if (len & 0x80) { const n = len & 0x7f; len = 0; for (let k = 0; k < n; k++) len = (len << 8) | der[i++]; }
      let v = der.subarray(i, i + len); i += len;
      while (v.length > 1 && v[0] === 0x00) v = v.subarray(1); // strip pads
      if (v.length > 32) throw new Error('DER: integer wider than 32 bytes');
      return v;
    }
    const r = readInt(), s = readInt();
    return { r, s };
  }

  function pad32(v) {
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  }

  /** Re-encode so r and s are each 0x00 + 32 padded bytes — the one shape the
      on-chain reader parses correctly for every possible signature. 72 bytes. */
  function normalizeDerSignature(der) {
    const { r, s } = parseDer(der);
    const r32 = pad32(r), s32 = pad32(s);
    const out = new Uint8Array(72);
    out.set([0x30, 0x46, 0x02, 0x21, 0x00], 0);
    out.set(r32, 5);
    out.set([0x02, 0x21, 0x00], 37);
    out.set(s32, 40);
    return out;
  }

  /* ---------- the packer ---------- */

  /** Protobuf-encode authentication_data (unprefixed). All fields required. */
  function packAuthenticationData(a) {
    if (!a || !a.credentialId || !a.signature || !a.authenticatorData || !a.clientDataJSON) {
      throw new Error('credentialId, signature, authenticatorData, clientDataJSON are all required');
    }
    const credIdUtf8 = typeof TextEncoder !== 'undefined'
      ? new TextEncoder().encode(String(a.credentialId))
      : toU8(Buffer.from(String(a.credentialId), 'utf8'));
    const bytes = [
      ...ldField(1, credIdUtf8),
      ...ldField(2, toU8(a.signature)),
      ...ldField(3, toU8(a.authenticatorData)),
      ...ldField(4, toU8(a.clientDataJSON)),
    ];
    return new Uint8Array(bytes);
  }

  /** The full transaction signature entry: base64url(0xFF 0x02 ‖ authentication_data).
      `signature` here is the assertion's raw DER — normalized inside. */
  function packSignatureBlob(a) {
    const body = packAuthenticationData({
      credentialId: a.credentialId,
      signature: normalizeDerSignature(a.signature),
      authenticatorData: a.authenticatorData,
      clientDataJSON: a.clientDataJSON,
    });
    const out = new Uint8Array(2 + body.length);
    out[0] = 0xff; out[1] = 0x02;
    out.set(body, 2);
    return encodeB64u(out);
  }

  /** The WebAuthn challenge for a Koinos transaction: ASCII of its "0x…" id. */
  function challengeForTxId(txId) {
    if (!/^0x[0-9a-f]+$/.test(String(txId))) throw new Error('transaction id must be 0x-prefixed lowercase hex');
    return typeof TextEncoder !== 'undefined'
      ? new TextEncoder().encode(String(txId))
      : toU8(Buffer.from(String(txId), 'utf8'));
  }

  return {
    encodeB64u, decodeB64u,
    parseDer, normalizeDerSignature,
    packAuthenticationData, packSignatureBlob, challengeForTxId,
  };
});
