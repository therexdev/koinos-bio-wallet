"use strict";

// KoinDX swap: vETH -> KOIN, the final hop of Route B, adapted for the
// smart-account wallet: instead of a secp-signed transaction, this exposes
// the approve + swap OPERATIONS for the prepare → passkey-sign → co-sign
// pipeline. Quote logic is verbatim from the desktop app (verified on-chain
// 2026-08-09).
//
// Gotcha that cost the desktop app: KoinDX keys system tokens by STRING, so
// KOIN in a path or get_pair is the literal "koin", not its contract address.
// vETH stays base58.

const { Contract } = require("koilib");
const fs = require("fs");
const path = require("path");
const PeripheryAbi = require("./abi/koindx-periphery-abi.json");
const CoreAbi = require("./abi/koindx-core-abi.json");
const { BRIDGE } = require("./bridge-constants");

const TOKEN_ABI = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "abi", "token-abi.json")));

const KOINDX = {
  mainnet: { router: "17e1q6Fh5RgnuA8K7v4KvXXH4k9qHgsT5s" },
  testnet: { router: null },
};
const KOIN_KEY = "koin"; // KoinDX's string key for KOIN (not its address)
const DEFAULT_SLIPPAGE_BPS = 100; // 1%
// Mana ceiling for approve + swap through a smart account (adds the on-chain
// WebAuthn verification to the desktop app's 4-KOIN ceiling).
const DEFAULT_SWAP_RC = "2000000000";

// Uniswap-v2 constant-product output with KoinDX's 0.25% fee (9975/10000).
// Matches the router's on-chain get_amount_out exactly (verified).
function getAmountOut(amountIn, reserveIn, reserveOut) {
  const aIn = BigInt(amountIn), rIn = BigInt(reserveIn), rOut = BigInt(reserveOut);
  if (aIn <= 0n) throw new Error("amountIn must be greater than 0");
  if (rIn <= 0n || rOut <= 0n) throw new Error("Pool has no liquidity");
  const inWithFee = aIn * 9975n;
  return (inWithFee * rOut) / (rIn * 10000n + inWithFee);
}

function applySlippage(amount, slippageBps) {
  const a = BigInt(amount), bps = BigInt(slippageBps);
  if (bps < 0n || bps >= 10000n) throw new Error("slippage out of range");
  return (a * (10000n - bps)) / 10000n;
}

function swapPath(network = "mainnet") {
  return [BRIDGE[network].veth, KOIN_KEY];
}

// Quote vETH -> KOIN from live reserves. Read-only, no mana.
async function quoteSwap({ amountInSats, slippageBps = DEFAULT_SLIPPAGE_BPS, network = "mainnet", provider } = {}) {
  const cfg = KOINDX[network];
  if (!cfg || !cfg.router) throw new Error(`KoinDX not configured for ${network}`);
  const veth = BRIDGE[network].veth;
  const router = new Contract({ id: cfg.router, abi: PeripheryAbi, provider }).functions;
  const pool = (await router.get_pair({ tokenA: veth, tokenB: KOIN_KEY })).result?.value;
  if (!pool) throw new Error("No vETH/KOIN pool found on KoinDX");

  const token = new Contract({ id: veth, abi: TOKEN_ABI, provider }).functions;
  const reserves = (await new Contract({ id: pool, abi: CoreAbi, provider }).functions.get_reserves()).result;
  // Reserve A/B -> token mapping isn't implied by ordering; derive it from the
  // pool's actual vETH balance.
  const vethInPool = (await token.balance_of({ owner: pool })).result?.value ?? "0";
  let reserveIn, reserveOut;
  if (String(vethInPool) === String(reserves.reserveA)) {
    reserveIn = reserves.reserveA;
    reserveOut = reserves.reserveB;
  } else {
    reserveIn = reserves.reserveB;
    reserveOut = reserves.reserveA;
  }
  const amountOut = getAmountOut(amountInSats, reserveIn, reserveOut);
  return {
    pool,
    amountOut: amountOut.toString(),
    amountOutMin: applySlippage(amountOut, slippageBps).toString(),
    reserveIn: String(reserveIn),
    reserveOut: String(reserveOut),
    path: swapPath(network),
    slippageBps,
  };
}

// The approve + swap_tokens_in OPERATIONS for the wallet's co-sign pipeline
// (the smart account signs with its passkey; the sponsor pays the mana).
async function opsKoindxSwap({ account, amountInSats, amountOutMin, network = "mainnet", provider } = {}) {
  const cfg = KOINDX[network];
  if (!cfg || !cfg.router) throw new Error(`KoinDX not configured for ${network}`);
  if (BigInt(amountInSats) <= 0n) throw new Error("amountIn must be greater than 0");
  if (BigInt(amountOutMin) <= 0n) throw new Error("amountOutMin must be set (slippage floor)");
  const veth = BRIDGE[network].veth;

  const vethToken = new Contract({ id: veth, abi: TOKEN_ABI, provider });
  const router = new Contract({ id: cfg.router, abi: PeripheryAbi, provider });
  const { operation: approve } = await vethToken.functions.approve(
    { owner: account, spender: cfg.router, value: String(amountInSats) }, { onlyOperation: true });
  const { operation: swap } = await router.functions.swap_tokens_in({
    from: account,
    receiver: account,
    amountIn: String(amountInSats),
    amountOutMin: String(amountOutMin),
    path: swapPath(network),
  }, { onlyOperation: true });
  return [approve, swap];
}

module.exports = {
  getAmountOut,
  applySlippage,
  swapPath,
  quoteSwap,
  opsKoindxSwap,
  KOINDX,
  KOIN_KEY,
  DEFAULT_SWAP_RC,
};
