"use strict";

// Ethereum side of bridging an ERC-20 (vKOIN) to Koinos via the Vortex bridge's
// transferTokens entrypoint — the token mirror of wrapAndTransferETH. The token
// must already be approved to the bridge (ERC-20 allowance). Guardians then sign
// the lock exactly as for an ETH deposit, and the same complete_transfer redeem
// delivers the mapped Koinos token (vKOIN → native KOIN, 1:1).
//
// transferTokens(address,uint256,uint256,string,string,string,uint32) — selector
// 0x0b47c9da, verified present in the bridge bytecode on 2026-08-10.

const { ethers } = require("ethers");
const { BRIDGE } = require("./bridge-constants");
const { validKoinosAddress } = require("./eth-bridge");

const BRIDGE_TOKEN_ABI = [
  "function transferTokens(address token, uint256 amount, uint256 payment, string relayer, string recipient, string metadata, uint32 toChain) payable",
  "function paused() view returns (bool)",
];

// Build the transferTokens calldata. payment=0, metadata empty, recipient is the
// user's Koinos address, toChain is the bridge's Koinos chain id.
//
// `relayer` is the field that decides who may later claim on Koinos. The Koinos
// side refuses complete_transfer with "tokens can only be claimed by the
// recipient or relayer", so naming our sponsor here is what lets the sponsor
// submit the redeem and land the user's KOIN without asking them to sign. It
// grants no claim on the funds: complete_transfer mints `value` to `recipient`
// and only `payment` — which is 0 — to the relayer. Both are sealed into the
// guardian-signed record at this moment and cannot be changed afterwards, so a
// deposit made without a relayer can only ever be claimed by its recipient.
function buildTransferTokensTx({ token, amountSats, koinosRecipient, relayer = "", network = "mainnet" }) {
  const cfg = BRIDGE[network];
  if (!cfg || !cfg.ethBridge) throw new Error(`Bridge not configured for ${network}`);
  if (!token) throw new Error("token required");
  if (!validKoinosAddress(koinosRecipient)) throw new Error("Invalid Koinos recipient address");
  if (relayer && !validKoinosAddress(relayer)) throw new Error("Invalid Koinos relayer address");
  const amt = BigInt(amountSats);
  if (amt <= 0n) throw new Error("amount must be > 0");
  const data = new ethers.Interface(BRIDGE_TOKEN_ABI).encodeFunctionData("transferTokens", [
    token,
    amt,
    0n, // payment — the relayer is paid nothing
    String(relayer || ""),
    String(koinosRecipient),
    "", // metadata
    cfg.toChain,
  ]);
  return { to: cfg.ethBridge, data, value: 0n };
}

async function bridgePaused(provider, network = "mainnet") {
  const cfg = BRIDGE[network];
  if (!cfg || !cfg.ethBridge) throw new Error(`Bridge not configured for ${network}`);
  return await new ethers.Contract(cfg.ethBridge, BRIDGE_TOKEN_ABI, provider).paused();
}

module.exports = { BRIDGE_TOKEN_ABI, buildTransferTokensTx, bridgePaused };
