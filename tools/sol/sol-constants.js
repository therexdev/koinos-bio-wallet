"use strict";

// Route S — fund with KOIN from SOL.
//   SOL → vKOIN on Solana (Jupiter, via the Raydium KOIN/SOL pool)
//       → Wormhole token bridge, Solana → Ethereum (vKOIN is Ethereum-native)
//       → Vortex bridge, Ethereum → Koinos (vKOIN → KOIN, 1:1)
//
// Why the detour through Ethereum: the Vortex bridge has no Solana side. The
// "vKOIN" that trades on Solana is Vortex Koin WRAPPED BY WORMHOLE — the mint
// below is exactly the Wormhole token bridge's wrapped-asset PDA for the
// Ethereum vKOIN contract (seeds ["wrapped", chain 2 as u16 BE, the 32-byte
// padded token address] under the Solana token bridge program; derived and
// checked offline on 2026-09-05). So the only way it becomes native KOIN is
// the way it came: back across Wormhole to Ethereum, then through Vortex —
// the same tail the ETH and stablecoin routes already use.

/** The original: Vortex Koin on Ethereum (tools/eth/route-constants.js). */
const VKOIN_ETH = "0xa50ad3a559A10f384a5bB2e27516f63E0B937b1A";
/** vKOIN on Solana — Wormhole-wrapped Vortex Koin. 8 decimals, like vKOIN. */
const VKOIN_SOL_MINT = "8AUxdPqYU4FBy5rZDhMJxTniPs7gtEfdHjP3UKM71m6G";
const VKOIN_SOL_DECIMALS = 8;
/** Wormhole-wrapped ETH on Solana ("ETH (Portal)") — the wrapped-asset
    account for Ethereum's WETH contract, derived the same way as vKOIN
    above and checked against the known mint on 2026-09-05. Route T buys
    THIS with the SOL, because bridging it back to Ethereum unwraps into
    native ETH, which is what pays for the Ethereum legs that follow. */
const WETH_SOL_MINT = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs";
const WETH_SOL_DECIMALS = 8; // Wormhole wraps at min(origin, 8) decimals
/** WETH on Ethereum — what the Wormhole VAA names as the token. */
const WETH_ETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

/** Native SOL as Jupiter's input mint (the wrapped-SOL mint). */
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_DECIMALS = 9;
const LAMPORTS_PER_SOL = 1000000000n;

/** Wormhole — mainnet, from @wormhole-foundation/sdk-base's contract table. */
const WORMHOLE = {
  solanaCore: "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth",
  solanaTokenBridge: "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb",
  ethTokenBridge: "0x3ee18B2214AFF97000D974cf647E7C347E8fa585",
  chainIdSolana: 1,
  chainIdEthereum: 2,
  /** Guardian-signed VAAs are served here once the Solana transfer is final. */
  scanApi: "https://api.wormholescan.io",
};

/** The two Ethereum token-bridge calls the rail makes. */
const ETH_TOKEN_BRIDGE_ABI = [
  "function completeTransfer(bytes encodedVm)",
  /* Only for a transfer whose token IS WETH: releases it and unwraps, so
     the recipient receives NATIVE ether — the gas for the legs after it. */
  "function completeTransferAndUnwrapETH(bytes encodedVm)",
  "function isTransferCompleted(bytes32 hash) view returns (bool)",
];

/** Jupiter's swap API. The lite endpoint needs no key; a paid key switches
    to api.jup.ag automatically. */
const JUPITER = {
  api: (process.env.JUPITER_API || (process.env.JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1")).replace(/\/$/, ""),
  apiKey: (process.env.JUPITER_API_KEY || "").trim(),
};

/** Public Solana RPCs, tried in order; SOLANA_RPC (comma-separated) goes first. */
function solanaRpcCandidates() {
  const own = String(process.env.SOLANA_RPC || "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...own, "https://api.mainnet-beta.solana.com"];
}

/** Solana mainnet's genesis hash — the Wormhole SDK identifies the chain by it. */
const SOLANA_MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

module.exports = {
  VKOIN_ETH, VKOIN_SOL_MINT, WETH_SOL_MINT, WETH_SOL_DECIMALS, WETH_ETH, VKOIN_SOL_DECIMALS, WSOL_MINT, SOL_DECIMALS, LAMPORTS_PER_SOL,
  WORMHOLE, ETH_TOKEN_BRIDGE_ABI, JUPITER, solanaRpcCandidates, SOLANA_MAINNET_GENESIS,
};
