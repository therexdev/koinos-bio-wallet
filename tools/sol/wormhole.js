"use strict";

// The Wormhole leg: vKOIN on Solana → vKOIN on Ethereum.
//
// vKOIN on Solana is a Wormhole wrapped asset whose original lives on
// Ethereum (see sol-constants.js). Sending it "home" is a token-bridge
// transfer: the Solana program burns the wrapped tokens and posts a message,
// the guardians sign that message into a VAA once the Solana block is final,
// and the Ethereum token bridge releases the original vKOIN from custody to
// whoever the VAA names — our transit address — when anyone submits the VAA
// to completeTransfer. Only the recipient sealed in the guardian-signed VAA
// can ever receive it, which is the same custody shape as the Vortex tail.
//
// Package shape: the Wormhole SDK is ESM-only, so it is imported lazily from
// this CommonJS module. The four packages used are the Solana platform, its
// core and token-bridge protocol modules (each registers itself on import)
// and sdk-connect; the Ethereum side is two plain ethers calls, so no EVM
// package is needed. Every call below was exercised against the packages
// offline; the network paths run only on a live server.

const { ethers } = require("ethers");
const { ComputeBudgetProgram } = require("@solana/web3.js");
const koilib = require("koilib");
const C = require("./sol-constants");
const rpc = require("./sol-rpc");

let _sdk = null;
/** Load the SDK once; a failed load is retried next time (and reported). */
function loadSdk() {
  if (!_sdk) {
    _sdk = (async () => {
      const connect = await import("@wormhole-foundation/sdk-connect");
      const solana = await import("@wormhole-foundation/sdk-solana");
      await import("@wormhole-foundation/sdk-solana-core");        // registers WormholeCore for Solana
      await import("@wormhole-foundation/sdk-solana-tokenbridge"); // registers TokenBridge for Solana
      return { connect, solana };
    })().catch((e) => { _sdk = null; throw e; });
  }
  return _sdk;
}

const CTX = new Map(); // rpcUrl → { connect, solana, wh, chain }
async function context(rpcUrl) {
  if (!CTX.has(rpcUrl)) {
    const { connect, solana } = await loadSdk();
    const wh = new connect.Wormhole("Mainnet", [solana.SolanaPlatform], { chains: { Solana: { rpc: rpcUrl } } });
    CTX.set(rpcUrl, { connect, solana, wh, chain: wh.getChain("Solana") });
  }
  return CTX.get(rpcUrl);
}
function forget() { CTX.clear(); }

/** A 20-byte Ethereum address in Wormhole's 32-byte universal form. */
function universalEth(connect, ethAddress) {
  return new connect.UniversalAddress("0x" + "00".repeat(12) + ethers.getAddress(ethAddress).slice(2).toLowerCase());
}

/** Build and sign — but do not send — the transfer of `amountSats` of the
    Solana vKOIN mint to `ethRecipient` on Ethereum. Returns the signed bytes,
    the signature they will confirm under, and the block height after which
    they can no longer land. The caller sends and then polls the signature,
    so a crash between the two is recoverable from the chain (see
    reconcileRouteS in tools/funding.js). */
async function buildTransfer({ rpcUrl, secret, mint = C.VKOIN_SOL_MINT, amountSats, ethRecipient }) {
  const { connect, chain } = await context(rpcUrl);
  const keypair = rpc.keypairFrom(secret);
  const conn = await chain.getRpc();
  const tb = await chain.getTokenBridge();
  const recipient = { chain: "Ethereum", address: universalEth(connect, ethRecipient) };
  const unsigned = [];
  for await (const tx of tb.transfer(keypair.publicKey.toBase58(), recipient, mint, BigInt(amountSats))) unsigned.push(tx);
  if (unsigned.length !== 1) throw new Error(`Wormhole transfer built ${unsigned.length} transactions, expected 1`);
  const { transaction, signers } = unsigned[0].transaction;
  if (typeof transaction.partialSign !== "function") throw new Error("Wormhole transfer is not a legacy transaction");
  /* Pay for inclusion like the swap does, within the same clamp. */
  const price = await rpc.priorityFeeMicroLamports(conn);
  transaction.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
  );
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = keypair.publicKey;
  transaction.partialSign(keypair, ...(signers || []));
  const raw = transaction.serialize();
  if (!transaction.signature) throw new Error("Wormhole transfer did not sign");
  return { raw, signature: koilib.utils.encodeBase58(new Uint8Array(transaction.signature)), lastValidBlockHeight: Number(lastValidBlockHeight) };
}

/** The Wormhole message a confirmed transfer emitted — { emitter (hex, no
    0x), sequence } — which is the VAA's address. null while the RPC does not
    have the transaction yet, or the transaction posted no message. */
async function messageIdFromTx({ rpcUrl, txid }) {
  const { chain } = await context(rpcUrl);
  let msgs;
  try { msgs = await chain.parseTransaction(txid); }
  catch (e) {
    if (/not found|no bridge messages/i.test(String(e.message || e))) return null;
    throw e;
  }
  if (!msgs || !msgs.length) return null;
  const m = msgs[0];
  const e = m.emitter && typeof m.emitter.toUniversalAddress === "function" ? m.emitter.toUniversalAddress().toString() : String(m.emitter);
  return { emitter: e.replace(/^0x/i, "").toLowerCase(), sequence: String(m.sequence) };
}

/** The most recent transaction from `address` that posted a Wormhole
    message AFTER this job's swap — how a bridge transfer whose reply was
    lost is found again. The scan stops at the swap's own signature
    (`stopAt`) and at anything older than the job (`since`, seconds), so a
    previous job's transfer in the same address history is never mistaken
    for this one. */
async function findRecentTransfer({ rpcUrl, address, limit = 25, stopAt = null, since = null }) {
  const { chain } = await context(rpcUrl);
  const conn = await chain.getRpc();
  const sigs = rpc.scopeSignatures(await rpc.recentSignatures(conn, address, limit), { stopAt, since });
  for (const txid of sigs) {
    const id = await messageIdFromTx({ rpcUrl, txid });
    if (id) return { txid, ...id };
  }
  return null;
}

/** The guardian-signed VAA for a message, from Wormholescan. null until the
    guardians have signed (the Solana block must be final first). */
async function fetchVaa({ emitter, sequence, fetch: fetchImpl = globalThis.fetch }) {
  if (!fetchImpl) throw new Error("no fetch available for Wormholescan");
  const url = `${C.WORMHOLE.scanApi}/v1/signed_vaa/${C.WORMHOLE.chainIdSolana}/${String(emitter).replace(/^0x/i, "")}/${sequence}`;
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Wormholescan: HTTP ${res.status}`);
  const j = await res.json();
  if (!j || !j.vaaBytes) return null;
  const bytes = Buffer.from(String(j.vaaBytes), "base64");
  return { hex: "0x" + bytes.toString("hex") };
}

/** Decode a transfer VAA and check it is the one we expect. Returns the
    hash the Ethereum bridge keys completed transfers on (keccak256 of the
    body hash — the EVM core bridge double-hashes; the SDK's own EVM module
    does exactly this) and the transfer's fields. */
async function parseTransferVaa(hex, { expectRecipient } = {}) {
  const { connect } = await loadSdk();
  const vaa = connect.deserialize("TokenBridge:Transfer", ethers.getBytes(hex));
  const to = vaa.payload.to;
  const out = {
    hash: ethers.hexlify(vaa.hash),
    evmHash: ethers.keccak256(vaa.hash),
    amount: String(vaa.payload.token.amount),
    token: "0x" + vaa.payload.token.address.toString().slice(-40),
    tokenChain: String(vaa.payload.token.chain),
    toChain: String(to.chain),
    to: "0x" + to.address.toString().slice(-40).toLowerCase(),
    sequence: String(vaa.sequence),
    emitterChain: String(vaa.emitterChain),
  };
  if (out.emitterChain !== "Solana") throw new Error(`Wormhole VAA was emitted on ${out.emitterChain}, not Solana`);
  if (out.toChain !== "Ethereum") throw new Error(`Wormhole VAA is for ${out.toChain}, not Ethereum`);
  if (out.tokenChain !== "Ethereum" || out.token.toLowerCase() !== C.VKOIN_ETH.toLowerCase()) {
    throw new Error("Wormhole VAA is not a vKOIN transfer");
  }
  if (expectRecipient && out.to !== String(expectRecipient).toLowerCase()) {
    throw new Error("Wormhole VAA names a different recipient than the deposit address");
  }
  return out;
}

/** Has the Ethereum token bridge already honoured this VAA? */
async function isRedeemedOnEthereum(provider, evmHash) {
  const c = new ethers.Contract(C.WORMHOLE.ethTokenBridge, C.ETH_TOKEN_BRIDGE_ABI, provider);
  return !!(await c.isTransferCompleted(evmHash));
}

/** The Ethereum transaction that releases the vKOIN: completeTransfer(vaa).
    Shaped for eth-swap-exec's sendTx. */
function buildCompleteTransferTx(vaaHex) {
  const iface = new ethers.Interface(C.ETH_TOKEN_BRIDGE_ABI);
  return { to: C.WORMHOLE.ethTokenBridge, data: iface.encodeFunctionData("completeTransfer", [vaaHex]), value: 0n };
}

module.exports = {
  loadSdk, forget, buildTransfer, messageIdFromTx, findRecentTransfer, fetchVaa, parseTransferVaa,
  isRedeemedOnEthereum, buildCompleteTransferTx, universalEth,
};
