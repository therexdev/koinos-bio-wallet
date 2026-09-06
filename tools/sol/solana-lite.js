"use strict";

// The Solana primitives this wallet needs, with no Solana packages.
//
// Everything here is checked byte-for-byte against @solana/web3.js in
// tests/solana-lite.test.js. The point is not to reimplement Solana; it is
// that a deposit rail must not stop working because an optional package was
// skipped on the host — which is exactly what happened in production.
//
// Provided: base58 (via koilib), program-derived addresses (which needs a real
// ed25519 on-curve test), associated token accounts, ed25519 signing through
// Node's own crypto, and legacy/v0 transaction assembly and signing.

const crypto = require("crypto");
const koilib = require("koilib");

const b58 = {
  encode: (bytes) => koilib.utils.encodeBase58(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
  decode: (s) => Buffer.from(koilib.utils.decodeBase58(String(s))),
};
const sha256 = (...parts) => crypto.createHash("sha256").update(Buffer.concat(parts.map(Buffer.from))).digest();

/* ---------------- ed25519, enough to tell a key from a PDA ----------------
   A program-derived address is by definition a point NOT on the curve, so
   deriving one means being able to decide that. This is the standard
   decompression: recover x from y and reject when no square root exists. */
const P = (1n << 255n) - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const SQRT_M1 = 19681161376707505956807079304988542015446066515923890162744021073123829784752n;

function powMod(b, e, m) {
  let r = 1n; b %= m;
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r;
}
const inv = (a) => powMod(a, P - 2n, P);

/** Is this 32-byte value a valid compressed ed25519 point? */
function isOnCurve(bytes) {
  const b = Buffer.from(bytes);
  if (b.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
  const sign = (y >> 255n) & 1n;
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;          // x² = (y² - 1) / (d·y² + 1)
  const v = (D * y2 + 1n) % P;
  if (v === 0n) return false;
  const x2 = (u * inv(v)) % P;
  if (x2 === 0n) return sign === 0n;    // x = 0 only exists with the sign bit clear
  /* The candidate root; if it does not square back, the other root is it
     times sqrt(-1), and if that fails too there is no root and the value is
     not a point on the curve. */
  let x = powMod(x2, (P + 3n) / 8n, P);
  if ((x * x) % P !== x2) x = (x * SQRT_M1) % P;
  return (x * x) % P === x2;
}

const PDA_MARKER = Buffer.from("ProgramDerivedAddress");

/** The address a program derives from these seeds — the first bump, counting
    down from 255, whose hash is not a curve point. */
function findProgramAddress(seeds, programId) {
  const prog = b58.decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(...seeds.map(Buffer.from), Buffer.from([bump]), prog, PDA_MARKER);
    if (!isOnCurve(h)) return { address: b58.encode(h), bump };
  }
  throw new Error("no program address found for those seeds");
}

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/** The owner's associated token account for a mint. */
function associatedTokenAddress(mint, owner, tokenProgram = TOKEN_PROGRAM) {
  return findProgramAddress([b58.decode(owner), b58.decode(tokenProgram), b58.decode(mint)], ASSOCIATED_TOKEN_PROGRAM).address;
}

/* ---------------- keys and signatures ---------------- */

/** Node's crypto speaks ed25519; a Solana secret key is seed||public. */
function keyFromSecret(secretB58) {
  const raw = b58.decode(secretB58);
  if (raw.length !== 64) throw new Error("not a 64-byte Solana secret key");
  const seed = raw.subarray(0, 32);
  /* PKCS#8 wrapper for a raw ed25519 seed. */
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  return { key: crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" }), publicKey: b58.encode(raw.subarray(32)) };
}
const sign = (message, secretB58) => crypto.sign(null, Buffer.from(message), keyFromSecret(secretB58).key);

/* ---------------- transactions ---------------- */

/** Solana's compact-u16 length prefix. */
function shortVec(n) {
  const out = [];
  for (;;) { let b = n & 0x7f; n >>= 7; if (n) { out.push(b | 0x80); } else { out.push(b); break; } }
  return Buffer.from(out);
}
function readShortVec(buf, off) {
  let n = 0, shift = 0, i = off;
  for (;;) { const b = buf[i++]; n |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
  return [n, i];
}

/** Compile a legacy message. `instructions` are
    { programId, keys:[{pubkey,isSigner,isWritable}], data:Buffer }. The payer
    signs, so it leads the account list; the rest follow Solana's order:
    writable signers, readonly signers, writable others, readonly others. */
function compileMessage({ payer, instructions, recentBlockhash }) {
  const metas = new Map();
  const note = (pubkey, isSigner, isWritable) => {
    const cur = metas.get(pubkey) || { pubkey, isSigner: false, isWritable: false };
    cur.isSigner = cur.isSigner || isSigner;
    cur.isWritable = cur.isWritable || isWritable;
    metas.set(pubkey, cur);
  };
  note(payer, true, true);
  for (const ix of instructions) {
    for (const k of ix.keys) note(k.pubkey, !!k.isSigner, !!k.isWritable);
    note(ix.programId, false, false);
  }
  /* Signers first, writable before read-only, and within a class by base58
     — the exact comparison web3.js uses, because the account order is part of
     the message a validator hashes. The fee payer leads regardless. */
  const COLLATE = { localeMatcher: "best fit", usage: "sort", sensitivity: "variant", ignorePunctuation: false, numeric: false, caseFirst: "lower" };
  const all = [...metas.values()].filter((m) => m.pubkey !== payer);
  all.sort((a, b) => {
    if (a.isSigner !== b.isSigner) return a.isSigner ? -1 : 1;
    if (a.isWritable !== b.isWritable) return a.isWritable ? -1 : 1;
    return a.pubkey.localeCompare(b.pubkey, "en", COLLATE);
  });
  const ordered = [metas.get(payer), ...all];

  const numRequiredSignatures = ordered.filter((m) => m.isSigner).length;
  const numReadonlySigned = ordered.filter((m) => m.isSigner && !m.isWritable).length;
  const numReadonlyUnsigned = ordered.filter((m) => !m.isSigner && !m.isWritable).length;
  const index = new Map(ordered.map((m, i) => [m.pubkey, i]));

  const parts = [
    Buffer.from([numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned]),
    shortVec(ordered.length),
    ...ordered.map((m) => b58.decode(m.pubkey)),
    b58.decode(recentBlockhash),
    shortVec(instructions.length),
  ];
  for (const ix of instructions) {
    parts.push(Buffer.from([index.get(ix.programId)]));
    parts.push(shortVec(ix.keys.length));
    parts.push(Buffer.from(ix.keys.map((k) => index.get(k.pubkey))));
    parts.push(shortVec(ix.data.length));
    parts.push(Buffer.from(ix.data));
  }
  return { message: Buffer.concat(parts), signers: ordered.filter((m) => m.isSigner).map((m) => m.pubkey) };
}

/** Sign a compiled message with every required signer and serialize it. */
function signTransaction(message, signerOrder, secretsByPubkey) {
  const sigs = signerOrder.map((pk) => {
    const secret = secretsByPubkey[pk];
    if (!secret) throw new Error(`no key to sign for ${pk}`);
    return sign(message, secret);
  });
  return Buffer.concat([shortVec(sigs.length), ...sigs, message]);
}

/** Re-sign a transaction someone else built (Jupiter's swap): replace the
    fee payer's signature slot, leaving the message untouched. */
function signSerialized(base64OrBuf, secretB58) {
  const tx = Buffer.isBuffer(base64OrBuf) ? base64OrBuf : Buffer.from(String(base64OrBuf), "base64");
  const [count, afterLen] = readShortVec(tx, 0);
  const msgStart = afterLen + count * 64;
  const message = tx.subarray(msgStart);
  const { publicKey } = keyFromSecret(secretB58);
  /* The signer's slot is its position among the required signers, which for a
     v0 or legacy message begins right after the header. */
  const [msgHeaderOff, versioned] = message[0] & 0x80 ? [1, true] : [0, false];
  const numSigners = message[msgHeaderOff];
  const [keyCount, keysStart] = readShortVec(message, msgHeaderOff + 3);
  let slot = -1;
  for (let i = 0; i < numSigners && i < keyCount; i++) {
    if (b58.encode(message.subarray(keysStart + i * 32, keysStart + (i + 1) * 32)) === publicKey) { slot = i; break; }
  }
  if (slot < 0) throw new Error("this transaction does not ask for our signature");
  const out = Buffer.from(tx);
  sign(message, secretB58).copy(out, afterLen + slot * 64);
  return { raw: out, signature: b58.encode(out.subarray(afterLen, afterLen + 64)), versioned };
}

module.exports = {
  b58, sha256, isOnCurve, findProgramAddress, associatedTokenAddress,
  keyFromSecret, sign, compileMessage, signTransaction, signSerialized, shortVec, readShortVec,
  TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, SYSTEM_PROGRAM,
};
