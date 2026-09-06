"use strict";

// The Wormhole leg: a wrapped token on Solana, sent home to Ethereum.
//
// vKOIN and wETH on Solana are both Wormhole wrapped assets whose originals
// live on Ethereum. Sending one home is a token-bridge transfer: the Solana
// program burns the wrapped tokens and posts a message, the guardians sign it
// into a VAA once the block is final, and Ethereum's token bridge releases the
// original to whoever the VAA names — our transit address — when anyone
// submits it. Only the recipient sealed in the guardian-signed VAA can ever
// receive it, which is the same custody shape as the Vortex tail.
//
// This is built on tools/sol/{solana-lite,wormhole-lite,rpc-lite}.js rather
// than the Wormhole SDK, so it runs on any Node 18 with no extra packages —
// the rail must not stop working because an optional install was skipped.
// Every instruction and transaction those files produce is checked
// byte-for-byte against the real SDK in tests/.

const { ethers } = require("ethers");
const C = require("./sol-constants");
const L = require("./solana-lite");
const WL = require("./wormhole-lite");
const rpc = require("./rpc-lite");
const keys = require("./keys");

/** Nothing to load any more; kept so callers need not care. */
const loadSdk = async () => true;
const forget = () => {};

/** A 20-byte Ethereum address in Wormhole's 32-byte universal form. */
const universalEth = (ethAddress) =>
  Buffer.concat([Buffer.alloc(12), Buffer.from(ethers.getAddress(ethAddress).slice(2), "hex")]);

/** This bridge always emits from the token bridge's own emitter, so the VAA's
    address is that emitter and the sequence the transaction logged. */
const EMITTER_HEX = L.b58.decode(WL.ACCOUNTS.emitter).toString("hex");

/** Build and sign — but do not send — a transfer of `amountSats` of `mint` to
    `ethRecipient`. Returns the signed bytes, the signature they will confirm
    under, and the block height after which they can no longer land. The caller
    sends and then polls, so a crash between the two is recoverable from the
    chain (see reconcileSol in tools/funding.js). */
async function buildTransfer({ rpcUrl, secret, mint = C.VKOIN_SOL_MINT, amountSats, ethRecipient }) {
  const opts = rpcUrl ? { urls: [rpcUrl] } : undefined;
  const owner = keys.addressOf(secret);
  const from = L.associatedTokenAddress(mint, owner);
  /* The message account is fresh each time and signs for its own creation. */
  const message = keys.newKeypair();
  const amount = BigInt(amountSats);

  const price = await rpc.priorityFeeMicroLamports(opts || {});
  const instructions = [
    WL.computeUnitLimit(400000),
    WL.computeUnitPrice(price),
    WL.approveInstruction({ source: from, owner, amount }),
    WL.transferWrappedInstruction({
      payer: owner, message: message.solAddress, from, fromOwner: owner, mint,
      nonce: 0, amount, fee: 0n,
      recipient32: universalEth(ethRecipient), targetChainId: C.WORMHOLE.chainIdEthereum,
    }),
  ];
  const { blockhash, lastValidBlockHeight } = await rpc.latestBlockhash(opts);
  const { message: msg, signers } = L.compileMessage({ payer: owner, instructions, recentBlockhash: blockhash });
  const raw = L.signTransaction(msg, signers, { [owner]: secret, [message.solAddress]: message.solSecret });
  /* The fee payer signs first, so its signature — the transaction's id — is
     the first one after the count. */
  const [, sigsAt] = L.readShortVec(raw, 0);
  return { raw, signature: L.b58.encode(raw.subarray(sigsAt, sigsAt + 64)), lastValidBlockHeight };
}

/** The Wormhole message a confirmed transfer emitted — { emitter, sequence } —
    which is the VAA's address. null while the RPC does not have it yet. */
async function messageIdFromTx({ rpcUrl, txid }) {
  const opts = rpcUrl ? { urls: [rpcUrl] } : undefined;
  const sequence = await rpc.wormholeSequenceFromTx(txid, opts);
  return sequence ? { emitter: EMITTER_HEX, sequence } : null;
}

/** The most recent transfer from `address` that posted a Wormhole message
    AFTER this job's swap — how a send whose reply was lost is found again. */
async function findRecentTransfer({ rpcUrl, address, limit = 25, stopAt = null, since = null }) {
  const opts = rpcUrl ? { urls: [rpcUrl] } : undefined;
  const list = await rpc.recentSignatures(address, limit, opts);
  for (const s of list) {
    if (stopAt && s.signature === stopAt) break;
    if (since && s.blockTime && s.blockTime < since) break;
    const id = await messageIdFromTx({ rpcUrl, txid: s.signature });
    if (id) return { txid: s.signature, ...id };
  }
  return null;
}

/** The guardian-signed VAA for a message, from Wormholescan. null until the
    guardians have signed. */
async function fetchVaa({ emitter, sequence, fetch: fetchImpl = globalThis.fetch }) {
  if (!fetchImpl) throw new Error("no fetch available for Wormholescan");
  const url = `${C.WORMHOLE.scanApi}/v1/signed_vaa/${C.WORMHOLE.chainIdSolana}/${String(emitter).replace(/^0x/i, "")}/${sequence}`;
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Wormholescan: HTTP ${res.status}`);
  const j = await res.json();
  if (!j || !j.vaaBytes) return null;
  return { hex: "0x" + Buffer.from(String(j.vaaBytes), "base64").toString("hex") };
}

const CHAIN_NAME = { 1: "Solana", 2: "Ethereum" };

/** Decode a transfer VAA and check it is the one we expect. Returns the hash
    Ethereum's bridge keys completed transfers on (keccak of the body hash —
    the EVM core bridge hashes twice) and the transfer's fields. */
async function parseTransferVaa(hex, { expectRecipient, expectToken = C.VKOIN_ETH } = {}) {
  const b = Buffer.from(ethers.getBytes(hex));
  if (b.length < 57) throw new Error("Wormhole VAA is too short");
  const sigCount = b[5];
  const bodyAt = 6 + sigCount * 66;
  const body = b.subarray(bodyAt);
  if (body.length < 51 + 1) throw new Error("Wormhole VAA body is too short");
  const emitterChain = body.readUInt16BE(8);
  const sequence = body.readBigUInt64BE(42).toString();
  const p = body.subarray(51);
  if (p[0] !== 1) throw new Error(`Wormhole VAA is payload type ${p[0]}, not a plain transfer`);
  const amount = BigInt("0x" + p.subarray(1, 33).toString("hex"));
  const token = "0x" + p.subarray(33 + 12, 65).toString("hex");
  const tokenChain = p.readUInt16BE(65);
  const to = "0x" + p.subarray(67 + 12, 99).toString("hex");
  const toChain = p.readUInt16BE(99);

  const hash = ethers.keccak256(body);
  const out = {
    hash, evmHash: ethers.keccak256(hash), amount: amount.toString(), token: token.toLowerCase(),
    tokenChain: CHAIN_NAME[tokenChain] || String(tokenChain), toChain: CHAIN_NAME[toChain] || String(toChain),
    to: to.toLowerCase(), sequence, emitterChain: CHAIN_NAME[emitterChain] || String(emitterChain),
  };
  if (out.emitterChain !== "Solana") throw new Error(`Wormhole VAA was emitted on ${out.emitterChain}, not Solana`);
  if (out.toChain !== "Ethereum") throw new Error(`Wormhole VAA is for ${out.toChain}, not Ethereum`);
  if (out.tokenChain !== "Ethereum" || out.token !== String(expectToken).toLowerCase()) {
    throw new Error(`Wormhole VAA is not a ${String(expectToken).toLowerCase() === C.WETH_ETH.toLowerCase() ? "wETH" : "vKOIN"} transfer`);
  }
  if (expectRecipient && out.to !== String(expectRecipient).toLowerCase()) {
    throw new Error("Wormhole VAA names a different recipient than the deposit address");
  }
  return out;
}

/** Has Ethereum's token bridge already honoured this VAA? */
async function isRedeemedOnEthereum(provider, evmHash) {
  const c = new ethers.Contract(C.WORMHOLE.ethTokenBridge, C.ETH_TOKEN_BRIDGE_ABI, provider);
  return !!(await c.isTransferCompleted(evmHash));
}

/** The Ethereum transaction that releases what the VAA holds. `unwrap` is for
    a wETH transfer: completeTransferAndUnwrapETH hands the recipient NATIVE
    ether, which is what lets a Solana deposit pay its own Ethereum gas.

    Either call may be submitted by ANYONE — the recipient is sealed in the
    guardian-signed VAA and the caller cannot redirect it. */
function buildCompleteTransferTx(vaaHex, { unwrap = false } = {}) {
  const iface = new ethers.Interface(C.ETH_TOKEN_BRIDGE_ABI);
  const fn = unwrap ? "completeTransferAndUnwrapETH" : "completeTransfer";
  return { to: C.WORMHOLE.ethTokenBridge, data: iface.encodeFunctionData(fn, [vaaHex]), value: 0n };
}

module.exports = {
  loadSdk, forget, buildTransfer, messageIdFromTx, findRecentTransfer, fetchVaa, parseTransferVaa,
  isRedeemedOnEthereum, buildCompleteTransferTx, universalEth, EMITTER_HEX,
};
