"use strict";

// The Wormhole token-bridge transfer, built without the Wormhole SDK.
//
// Sending a wrapped token home is one instruction with a fixed byte layout and
// a fixed set of accounts, almost all of them addresses that never change.
// tests/wormhole-lite.test.js builds the same transfer with the real SDK and
// requires the bytes to be identical, so this is a transcription rather than a
// reimplementation — but one that runs on any Node 18 with no extra packages.

const L = require("./solana-lite");
const C = require("./sol-constants");

const TOKEN_BRIDGE = C.WORMHOLE.solanaTokenBridge;
const CORE_BRIDGE = C.WORMHOLE.solanaCore;
const CLOCK = "SysvarC1ock11111111111111111111111111111111";
const RENT = "SysvarRent111111111111111111111111111111111";

/* Addresses derived from the two program ids and nothing else, so they are
   the same forever. Derived here at load and pinned in the test against the
   SDK's own derivations. */
const seed = (s) => Buffer.from(s);
const pda = (seeds, prog) => L.findProgramAddress(seeds, prog).address;
const ACCOUNTS = {
  config: pda([seed("config")], TOKEN_BRIDGE),
  authoritySigner: pda([seed("authority_signer")], TOKEN_BRIDGE),
  emitter: pda([seed("emitter")], TOKEN_BRIDGE),
  bridge: pda([seed("Bridge")], CORE_BRIDGE),
  feeCollector: pda([seed("fee_collector")], CORE_BRIDGE),
};
ACCOUNTS.sequence = pda([seed("Sequence"), L.b58.decode(ACCOUNTS.emitter)], CORE_BRIDGE);

const u16be = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

/** The mint Wormhole uses on Solana for a token native to another chain. */
const wrappedMint = (originChainId, originAddress32) =>
  pda([seed("wrapped"), u16be(originChainId), Buffer.from(originAddress32)], TOKEN_BRIDGE);
/** Its metadata account. */
const wrappedMeta = (mint) => pda([seed("meta"), L.b58.decode(mint)], TOKEN_BRIDGE);

/** SPL Token "Approve": let the bridge's authority move `amount` from `source`. */
function approveInstruction({ source, owner, amount }) {
  return {
    programId: L.TOKEN_PROGRAM,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: ACCOUNTS.authoritySigner, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([4]), u64le(amount)]),
  };
}

/** Token bridge "transfer_wrapped": burn the wrapped token here and post the
    message that becomes the VAA. `recipient32` is the destination address in
    Wormhole's 32-byte form. */
function transferWrappedInstruction({ payer, message, from, fromOwner, mint, nonce = 0, amount, fee = 0n, recipient32, targetChainId }) {
  return {
    programId: TOKEN_BRIDGE,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ACCOUNTS.config, isSigner: false, isWritable: false },
      { pubkey: from, isSigner: false, isWritable: true },
      { pubkey: fromOwner, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: wrappedMeta(mint), isSigner: false, isWritable: false },
      { pubkey: ACCOUNTS.authoritySigner, isSigner: false, isWritable: false },
      { pubkey: ACCOUNTS.bridge, isSigner: false, isWritable: true },
      { pubkey: message, isSigner: true, isWritable: true },
      { pubkey: ACCOUNTS.emitter, isSigner: false, isWritable: false },
      { pubkey: ACCOUNTS.sequence, isSigner: false, isWritable: true },
      { pubkey: ACCOUNTS.feeCollector, isSigner: false, isWritable: true },
      { pubkey: CLOCK, isSigner: false, isWritable: false },
      { pubkey: RENT, isSigner: false, isWritable: false },
      { pubkey: L.SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: L.TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: CORE_BRIDGE, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      Buffer.from([4]), u32le(nonce), u64le(amount), u64le(fee),
      Buffer.from(recipient32), u16le(targetChainId),
    ]),
  };
}

/** Compute budget: pay for inclusion, within a fixed ceiling. */
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const computeUnitLimit = (units) => ({ programId: COMPUTE_BUDGET, keys: [], data: Buffer.concat([Buffer.from([2]), u32le(units)]) });
const computeUnitPrice = (micro) => ({ programId: COMPUTE_BUDGET, keys: [], data: Buffer.concat([Buffer.from([3]), u64le(micro)]) });

module.exports = {
  ACCOUNTS, TOKEN_BRIDGE, CORE_BRIDGE, CLOCK, RENT,
  wrappedMint, wrappedMeta, approveInstruction, transferWrappedInstruction,
  computeUnitLimit, computeUnitPrice, u16be, u16le, u32le, u64le,
};
