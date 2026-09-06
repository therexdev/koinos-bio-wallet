"use strict";

// A Solana keypair with nothing but Node's own crypto.
//
// A Solana address IS an ed25519 public key in base58, and a Solana secret key
// is the 64 bytes seed||public that every Solana wallet imports. Node has
// ed25519 built in and koilib already ships base58, so the deposit address —
// the one thing a person needs before they can send anything at all — costs no
// dependencies and cannot be switched off by a package that failed to install.
// Only converting what arrives needs the Solana and Wormhole packages.

const crypto = require("crypto");
const koilib = require("koilib");

function newKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  /* The raw 32 bytes sit at the end of each DER encoding. */
  const pub = Buffer.from(publicKey.export({ type: "spki", format: "der" })).subarray(-32);
  const seed = Buffer.from(privateKey.export({ type: "pkcs8", format: "der" })).subarray(-32);
  return {
    solAddress: koilib.utils.encodeBase58(new Uint8Array(pub)),
    solSecret: koilib.utils.encodeBase58(new Uint8Array(Buffer.concat([seed, pub]))),
  };
}

/** The address a stored secret belongs to — the public half is its last 32 bytes. */
function addressOf(secretB58) {
  const raw = koilib.utils.decodeBase58(String(secretB58));
  if (raw.length !== 64) throw new Error("not a 64-byte Solana secret key");
  return koilib.utils.encodeBase58(raw.slice(32));
}

/** Shape check only: 32 bytes of base58. */
function looksLikeAddress(s) {
  try { return koilib.utils.decodeBase58(String(s)).length === 32; } catch (_) { return false; }
}

module.exports = { newKeypair, addressOf, looksLikeAddress };
