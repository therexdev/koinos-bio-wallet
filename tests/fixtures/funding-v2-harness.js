"use strict";
// Deterministic chain simulator: real ABI builders and real signatures, no RPC.
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { Signer } = require("koilib");
const A = require("../../tools/eth/gas-accounting");
const { create, GAS } = require("../../tools/eth/funding-v2");
const fees = require("../../tools/eth/fees");
const quotes = require("../../tools/eth/eth-swap");
const swap = require("../../tools/eth/eth-swap-exec");
const recovery = require("../../tools/eth/gas-recovery");
const wormhole = require("../../tools/sol/wormhole");
const jup = require("../../tools/sol/jupiter");
const koindx = require("../../tools/eth/koindx");
const RC = require("../../tools/eth/route-constants");
const SC = require("../../tools/sol/sol-constants");
const eth = (n) => ethers.parseEther(String(n));
const account = Signer.fromSeed("gas-recovery-fixture-account").getAddress();
const second = Signer.fromSeed("gas-recovery-fixture-second").getAddress();
const tokenKey = (owner, token) => owner.toLowerCase() + ":" + token.toLowerCase();
const allowanceKey = (owner, token, spender) => tokenKey(owner, token) + ":" + spender.toLowerCase();

function harness({ own = "0", sponsor = "1", policy = {}, service = "1" } = {}) {
  const transitWallet = new ethers.Wallet("0x" + "11".repeat(32));
  const sponsorWallet = new ethers.Wallet("0x" + "22".repeat(32));
  const otherWallet = new ethers.Wallet("0x" + "44".repeat(32));
  const wallets = { [account]: transitWallet, [second]: otherWallet };
  const ethBalances = new Map([[transitWallet.address, eth(own)], [otherWallet.address, eth(own)], [sponsorWallet.address, eth(sponsor)]]);
  const tokens = new Map(), allowances = new Map(), receipts = new Map(), jobs = {}, history = {}, sends = [];
  for (const w of Object.values(wallets)) for (const token of [RC.USDC, RC.USDT, RC.VKOIN]) tokens.set(tokenKey(w.address, token), token === RC.VKOIN ? 0n : 150000000n);
  const opts = { gas: 1000000000n, unavailableRecovery: false, loseNextSend: false, revertNext: false, dropReceipt: false };
  const getToken = (owner, token) => tokens.get(tokenKey(owner, token)) || 0n;
  const changeToken = (owner, token, by) => tokens.set(tokenKey(owner, token), getToken(owner, token) + by);
  const changeEth = (owner, by) => ethBalances.set(owner, (ethBalances.get(owner) || 0n) + by);
  const transferLog = (token, from, to, value) => ({ address: token, topics: [ethers.id("Transfer(address,address,uint256)"),
    ethers.zeroPadValue(from, 32), ethers.zeroPadValue(to, 32)], data: ethers.toBeHex(value, 32) });
  const estimate = (state) => ["front_gas", "collect_fee"].includes(state) ? GAS[state] : GAS[state] * 7n / 10n;
  const provider = {
    getFeeData: async () => ({ gasPrice: opts.gas, maxFeePerGas: opts.gas, maxPriorityFeePerGas: 0n }),
    getBalance: async (address) => ethBalances.get(ethers.getAddress(address)) || 0n,
    getNetwork: async () => ({ chainId: 1n }),
    getTransactionCount: async (address) => sends.filter((s) => s.from === address).length,
    getTransactionReceipt: async (hash) => opts.dropReceipt ? null : receipts.get(hash) || null,
    getBlockNumber: async () => 100,
    getCode: async () => "0x",
    broadcastTransaction: async (raw) => {
      const tx = ethers.Transaction.from(raw), hash = tx.hash;
      const j = Object.values(jobs).find((v) => v.pendingEth?.hash === hash);
      assert.ok(j, "a transaction journal exists BEFORE broadcast");
      assert.equal(j.pendingEth.raw, raw, "the saved bytes are the sent bytes");
      if (opts.loseNextSend) { opts.loseNextSend = false; throw new Error("network lost before acknowledgement"); }
      if (receipts.has(hash)) return { hash }; // exact same transaction replay
      const sender = ethers.getAddress(tx.from), owner = j.ethFrom;
      const gasUsed = estimate(j.status), gasPrice = opts.gas;
      changeEth(sender, -gasUsed * gasPrice);
      const logs = [], success = !opts.revertNext;
      opts.revertNext = false;
      const moveToken = (token, from, to, amount) => {
        if (from !== ethers.ZeroAddress) changeToken(from, token, -amount);
        if (to !== ethers.ZeroAddress) changeToken(to, token, amount);
        logs.push(transferLog(token, from, to, amount));
      };
      if (success) {
        if (tx.value > 0n) { changeEth(sender, -tx.value); changeEth(ethers.getAddress(tx.to), tx.value); }
        switch (j.status) {
          case "gas_approve_reset": case "gas_approve": case "approve_v3_usdc":
          case "approve_permit2_reset": case "approve_permit2": case "approve_bridge": {
            const [spender, amount] = new ethers.Interface(swap.ERC20_ABI).decodeFunctionData("approve", tx.data);
            allowances.set(allowanceKey(owner, tx.to, spender), amount); break;
          }
          case "gas_buy_eth": {
            const iface = new ethers.Interface(recovery.ROUTER_ABI);
            const [, calls] = iface.decodeFunctionData("multicall(uint256,bytes[])", tx.data);
            const [args] = iface.decodeFunctionData("exactOutputSingle", calls[0]);
            const input = recoveryInput(args.amountOut);
            assert.ok(input <= args.amountInMaximum);
            moveToken(args.tokenIn, owner, tx.to, input);
            changeEth(owner, args.amountOut); break;
          }
          case "wh_redeem": {
            if (j.route === "T") changeEth(owner, BigInt(j.vaaAmount) * 10n ** 10n);
            else moveToken(RC.VKOIN, ethers.ZeroAddress, owner, BigInt(j.vaaAmount));
            break;
          }
          case "swap_usdc_usdt": {
            moveToken(RC.USDC, owner, tx.to, BigInt(j.usdcSats));
            moveToken(RC.USDT, tx.to, owner, BigInt(j.usdcSats)); break;
          }
          case "swap_eth_usdt": moveToken(RC.USDT, tx.to, owner, BigInt(j.amountWei) * 3000000000n / 10n ** 18n); break;
          case "swap_usdt_vkoin": {
            moveToken(RC.USDT, owner, tx.to, BigInt(j.usdtSats));
            moveToken(RC.VKOIN, ethers.ZeroAddress, owner, BigInt(j.usdtSats) * 2000n); break;
          }
          case "bridge_token": moveToken(RC.VKOIN, owner, tx.to, BigInt(j.vkoinSats)); break;
        }
      }
      assert.ok((ethBalances.get(sender) || 0n) >= 0n, "simulated sender never runs out of ETH");
      sends.push({ hash, from: sender, to: ethers.getAddress(tx.to), state: j.status, value: tx.value, nonce: tx.nonce, raw });
      receipts.set(hash, { hash, status: success ? 1 : 0, blockNumber: 99, blockHash: "0x" + "dd".repeat(32), gasUsed, gasPrice, logs });
      return { hash };
    },
  };
  for (const w of [...Object.values(wallets), sponsorWallet]) w.estimateGas = async () => {
    const j = Object.values(jobs).find((j) => !j.pendingEth && !j.confirmedEth && (j.ethFrom === w.address || w.address === sponsorWallet.address));
    return estimate(j.status);
  };
  swap.balanceOf = async (_p, token, owner) => getToken(owner, token);
  swap.allowance = async (_p, token, owner, spender) => allowances.get(allowanceKey(owner, token, spender)) || 0n;
  swap.permit2Allowance = async () => ({ amount: 0n, expiration: 0 });
  const min = (v) => quotes.applySlippage(v, 150);
  quotes.quoteUsdtOut = async ({ amountWei }) => ({ usdt: BigInt(amountWei) * 3000000000n / 10n ** 18n, fee: 500 });
  quotes.quoteEthToVkoin = async ({ amountEth }) => {
    const out = eth(amountEth) * 6000000000000n / 10n ** 18n;
    return { koinOut: String(out), koinOutMin: String(min(min(out))) };
  };
  quotes.quoteVkoinOut = async ({ usdtSats }) => BigInt(usdtSats) * 2000n;
  quotes.quoteUsdcOut = async ({ usdcSats }) => ({ usdt: BigInt(usdcSats), fee: 100 });
  quotes.quoteUsdcToVkoin = async ({ usdcSats }) => ({ koinOut: String(BigInt(usdcSats) * 2000n), koinOutMin: String(min(min(BigInt(usdcSats) * 2000n))) });
  const recoveryInput = (w) => A.ceilDiv(BigInt(w) * 3000000000n * 1000n, 10n ** 18n * 999n);
  recovery.quote = async ({ outputWei, slippageBps }) => {
    if (opts.unavailableRecovery) throw new Error("Recovery pool unavailable");
    const amountIn = recoveryInput(outputWei);
    return { amountIn, outputWei: BigInt(outputWei), maxInput: amountIn + A.bps(amountIn, slippageBps), fee: 500, gasEstimate: 100000n };
  };
  jup.quote = async ({ amount, outputMint }) => {
    const out = outputMint === SC.WETH_SOL_MINT ? BigInt(amount) * 15n / 1000n : BigInt(amount) * 600n;
    return { outAmount: String(out), outAmountMin: String(min(out)), via: ["fixture"], priceImpactPct: 0 };
  };
  wormhole.isRedeemedOnEthereum = async () => false;
  koindx.quoteSwap = async ({ amountInSats }) => ({ amountOut: String(BigInt(amountInSats) * 50000n), amountOutMin: String(min(BigInt(amountInSats) * 50000n)) });
  const settings = { network: "mainnet", maxEth: "0.05", slippageBps: 150, solReserve: "0.01",
    gasSponsorKey: sponsorWallet.privateKey,
    fee: fees.config({ FUND_FEE_PCT: service, FUND_FEE_TREASURY: "0x3333333333333333333333333333333333333333" }),
    gasPolicy: { ...A.config({}), ...policy },
  };
  const ctx = { settings, provider: async () => provider, wallet: async (a) => wallets[a], sponsorWallet: async () => sponsorWallet,
    transit: (a) => ({ ethAddress: wallets[a].address, ethPriv: wallets[a].privateKey, solAddress: "fixture" }),
    job: (a) => jobs[a], save: (a, j) => { jobs[a] = A.serialize(j); history[j.id] = jobs[a]; },
    records: () => Object.values(history), koinosProvider: () => ({}), relayer: () => "" };
  let engine = create(ctx);
  return { account, second, ctx, settings, get engine() { return engine; }, restart: () => { engine = create(ctx); },
    jobs, history, opts, sends, receipts, tokens, allowances, ethBalances, provider, wallets, sponsorWallet,
    balance: (a) => ethBalances.get(a), setOwn: (value, a = account) => ethBalances.set(wallets[a].address, eth(value)),
    async start(asset = "usdt", route = "C", input = "100", a = account) {
      const amount = ethers.parseUnits(input, asset === "eth" ? 18 : asset === "sol" ? 9 : 6);
      const q = await engine.quote(a, asset, amount), line = q.routes.find((r) => r.id === route);
      if (!line || !line.quoteId) throw new Error(line?.error || "No quote");
      await engine.start(a, { asset, amount, route, quoteId: line.quoteId }, {});
      return { quote: line, job: jobs[a] };
    },
    arriveSol(a = account) {
      const j = jobs[a];
      ctx.save(a, { ...j, status: "wh_redeem", vaa: "0x01", vaaEvmHash: "fixture",
        vaaAmount: j.route === "T" ? String(BigInt(j.feePlan.expectedNativeArrivalWei) / 10n ** 10n) : String(120000000000n) });
    },
    async run(a = account, until = "awaiting_signatures") {
      for (let i = 0; i < 70 && jobs[a].status !== until; i++) {
        if (jobs[a].status === "error") throw new Error(jobs[a].error);
        await engine.advance(a, jobs[a]);
      }
      assert.equal(jobs[a].status, until, "the route reaches its expected bridge state");
      return jobs[a];
    },
  };
}
module.exports = { harness, eth, A, RC, allowanceKey };
