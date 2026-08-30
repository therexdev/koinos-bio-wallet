"use strict";

// Koinos side of the Vortex bridge, adapted for the smart-account wallet:
// complete_transfer mints the bridged token (vETH, or native KOIN for vKOIN)
// to the recipient. The recipient must authorize — for a smart account that
// means the PASSKEY signs the prepared transaction (the account's validator
// checks it on-chain), with our sponsor as mana payer. So instead of the
// desktop app's signed-transaction builder, this exposes the OPERATION for
// the wallet's prepare → passkey-sign → co-sign pipeline. Field mapping
// mirrors the reference client (VortexBridge/interface-bridge Redeem.jsx);
// koilib encodes the byte fields via the ABI's btype annotations.

const { Contract } = require("koilib");
const BRIDGE_ABI = require("./abi/koinos-bridge-abi.json");
const { BRIDGE } = require("./bridge-constants");

// Mana ceiling for a smart-account redeem: complete_transfer plus the
// account's on-chain WebAuthn verification.
const DEFAULT_REDEEM_RC = "2000000000";

// Map a Vortex proxy record (GetEthereumTransaction response) to complete_transfer
// arguments — byte-for-byte the desktop app's mapping.
function recordToRedeemArgs(record) {
  if (!record || typeof record !== "object") throw new Error("Missing bridge record");
  if (!record.id) throw new Error("Bridge record missing id (ETH tx hash)");
  if (!record.recipient) throw new Error("Bridge record missing recipient");
  if (!record.koinosToken) throw new Error("Bridge record missing koinosToken");
  if (!Array.isArray(record.signatures) || record.signatures.length === 0) {
    throw new Error("Bridge record has no signatures");
  }
  return {
    transactionId: record.id,
    token: record.koinosToken,
    relayer: record.relayer || "",
    recipient: record.recipient,
    value: String(record.amount),
    payment: String(record.payment == null ? "0" : record.payment),
    metadata: record.metadata || "",
    signatures: record.signatures,
    expiration: String(record.expiration),
  };
}

// The complete_transfer OPERATION for the wallet's co-sign pipeline.
async function opCompleteTransfer({ record, network = "mainnet", provider } = {}) {
  const cfg = BRIDGE[network];
  if (!cfg || !cfg.koinosBridge) throw new Error(`Bridge not configured for ${network}`);
  const args = recordToRedeemArgs(record);
  const bridge = new Contract({ id: cfg.koinosBridge, abi: BRIDGE_ABI, provider });
  const { operation } = await bridge.functions.complete_transfer(args, { onlyOperation: true });
  return operation;
}

module.exports = { recordToRedeemArgs, opCompleteTransfer, BRIDGE_ABI, DEFAULT_REDEEM_RC };
