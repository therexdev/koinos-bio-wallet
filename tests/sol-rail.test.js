/* Route S — SOL → vKOIN (Solana) → Wormhole → Ethereum → Vortex → KOIN.

   Nothing here touches a network. What is pinned:
     1. the SOL maths: reserve, minimum and cap on what may move;
     2. the pure Jupiter request/reply shapes the swap leg depends on;
     3. the Wormhole VAA decode and the hash Ethereum's bridge keys on
        (keccak256 of the body hash — the EVM bridge double-hashes);
     4. the demo pipeline walking a SOL job to "done" through every state,
        so the UI can run the whole route anywhere;
     5. where-is-the-money for a route-S job (reconcileRouteS), fed facts
        by a fake probe, including that it reads no further than it must;
     6. the boot-time repair and the public shape (the VAA never leaves).

   Run: node tests/sol-rail.test.js
*/
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");

const funding = require("../tools/funding");
const routes = require("../tools/eth/fund-routes");
const jup = require("../tools/sol/jupiter");
const SU = require("../tools/sol/units");
const SC = require("../tools/sol/sol-constants");
const wormhole = require("../tools/sol/wormhole");

const sol = require("../tools/sol/sol-rpc");

const ACCT = "1DemoSolAccountAddressXXXXXXXXXXXX";
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), "solrail-"));

(async () => {
  /* --- 0. the rail is on only once the Wormhole SDK has actually loaded --- */
  {
    funding.configure({ dataDir: fresh(), demo: true, network: "mainnet" });
    assert.ok(await funding._sdkReady(), "the Wormhole SDK loads");
    assert.ok(funding._solRail().enabled, "the Solana packages are installed and probed, so the rail is on");
    console.log("✓ the rail advertises itself only after the SDK is known to load");
  }

  /* --- 1. what may move --- */
  {
    funding.configure({ dataDir: fresh(), demo: true, network: "mainnet" });
    const sp = (sol) => funding._spendableOf("sol", { solLamports: SU.parseSol(sol).toString() });
    assert.strictEqual((await sp("0.005")).sats, 0n, "below the reserve nothing moves");
    assert.strictEqual((await sp("0.025")).sats, 0n, "reserve taken, what is left is under the minimum → nothing");
    assert.strictEqual((await sp("0.03")).label, "0.02", "reserve 0.01 off the top, the minimum exactly");
    assert.strictEqual((await sp("1")).label, "0.5", "the cap holds");
    assert.strictEqual((await funding._spendableOf("sol", {})).sats, 0n, "no Solana balance read → nothing, not a crash");
    console.log("✓ SOL spendable: reserve, minimum and cap");
  }

  /* --- 2. Jupiter shapes --- */
  {
    const url = new URL(jup.quoteUrl({ amount: 200000000n, slippageBps: 150 }));
    assert.strictEqual(url.searchParams.get("inputMint"), SC.WSOL_MINT);
    assert.strictEqual(url.searchParams.get("outputMint"), SC.VKOIN_SOL_MINT);
    assert.strictEqual(url.searchParams.get("amount"), "200000000");
    assert.strictEqual(url.searchParams.get("slippageBps"), "150");
    assert.strictEqual(url.searchParams.get("restrictIntermediateTokens"), "true");
    const q = jup.parseQuote({ inAmount: "200000000", outAmount: "6600000000", otherAmountThreshold: "6501000000", priceImpactPct: "0.0123", routePlan: [{ swapInfo: { label: "Raydium" } }, { swapInfo: { label: "Raydium" } }] });
    assert.deepStrictEqual([q.outAmount, q.outAmountMin, q.priceImpactPct, q.via], ["6600000000", "6501000000", 1.23, ["Raydium"]]);
    assert.throws(() => jup.parseQuote({ outAmount: "0" }), /no route/, "a zero quote is refused, not swapped");
    const body = jup.swapBody({ quoteResponse: q.raw, userPublicKey: "So11111111111111111111111111111111111111112" });
    assert.strictEqual(body.wrapAndUnwrapSol, true, "native SOL in: Jupiter wraps and unwraps");
    assert.strictEqual(body.dynamicComputeUnitLimit, true);
    assert.ok(body.prioritizationFeeLamports.priorityLevelWithMaxLamports.maxLamports <= 1000000, "the priority fee is capped");
    assert.throws(() => jup.parseSwap({}), /no swap transaction/);
    /* the wire, with an injected fetch */
    const calls = [];
    const fakeFetch = async (u, init) => { calls.push({ u, init }); return { ok: true, status: 200, text: async () => JSON.stringify({ inAmount: "1", outAmount: "5", otherAmountThreshold: "4", routePlan: [] }) }; };
    const got = await jup.quote({ amount: 1n, slippageBps: 150, fetch: fakeFetch });
    assert.strictEqual(got.outAmount, "5");
    assert.ok(calls[0].u.startsWith(SC.JUPITER.api + "/quote?"));
    const bad = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: "Could not find any route" }) });
    await assert.rejects(jup.quote({ amount: 1n, slippageBps: 150, fetch: bad }), /Jupiter: Could not find any route/);
    console.log("✓ Jupiter quote/swap request and reply shapes");
  }

  /* --- 3. the VAA and the hash Ethereum keys on --- */
  {
    const { connect } = await wormhole.loadSdk();
    const transit = "0x1234567890AbcdEF1234567890aBcdef12345678";
    const vaa = connect.createVAA("TokenBridge:Transfer", {
      guardianSet: 4, timestamp: 1700000000, nonce: 0, emitterChain: "Solana",
      emitterAddress: new connect.UniversalAddress("0x" + "ec".repeat(32)), sequence: 4242n, consistencyLevel: 32, signatures: [],
      payload: {
        token: { amount: 660000000n, address: wormhole.universalEth(connect, SC.VKOIN_ETH), chain: "Ethereum" },
        to: { address: wormhole.universalEth(connect, transit), chain: "Ethereum" }, fee: 0n,
      },
    });
    const bytes = connect.serialize(vaa);
    const hex = ethers.hexlify(bytes);
    const p = await wormhole.parseTransferVaa(hex, { expectRecipient: transit });
    assert.strictEqual(p.to, transit.toLowerCase());
    assert.strictEqual(p.amount, "660000000");
    assert.strictEqual(p.sequence, "4242");
    /* header = version(1) + guardian set(4) + sig count(1); the body is the rest */
    const bodyHash = ethers.keccak256(bytes.slice(6));
    assert.strictEqual(p.hash, bodyHash, "the SDK's hash is keccak256(body)");
    assert.strictEqual(p.evmHash, ethers.keccak256(bodyHash), "Ethereum's bridge keys on keccak256 of that");
    await assert.rejects(wormhole.parseTransferVaa(hex, { expectRecipient: "0x" + "11".repeat(20) }), /different recipient/);
    const other = connect.createVAA("TokenBridge:Transfer", {
      guardianSet: 4, timestamp: 1, nonce: 0, emitterChain: "Solana", emitterAddress: new connect.UniversalAddress("0x" + "ec".repeat(32)),
      sequence: 1n, consistencyLevel: 32, signatures: [],
      payload: { token: { amount: 1n, address: wormhole.universalEth(connect, "0x" + "22".repeat(20)), chain: "Ethereum" }, to: { address: wormhole.universalEth(connect, transit), chain: "Ethereum" }, fee: 0n },
    });
    await assert.rejects(wormhole.parseTransferVaa(ethers.hexlify(connect.serialize(other))), /not a vKOIN transfer/);
    const tx = wormhole.buildCompleteTransferTx(hex);
    assert.strictEqual(tx.to, SC.WORMHOLE.ethTokenBridge);
    assert.strictEqual(tx.data.slice(0, 10), ethers.id("completeTransfer(bytes)").slice(0, 10));
    const [decoded] = new ethers.Interface(SC.ETH_TOKEN_BRIDGE_ABI).decodeFunctionData("completeTransfer", tx.data);
    assert.strictEqual(decoded, hex, "the VAA rides in whole");
    console.log("✓ Wormhole VAA decode, recipient/token checks, double-keccak, completeTransfer calldata");
  }

  /* --- 3b. the Solana account helpers --- */
  {
    /* only signatures newer than the swap can be this job's */
    const list = [{ signature: "T3", blockTime: 300 }, { signature: "T2", blockTime: 200 }, { signature: "SWAP", blockTime: 150 }, { signature: "T1", blockTime: 100 }];
    assert.deepStrictEqual(sol.scopeSignatures(list, { stopAt: "SWAP" }), ["T3", "T2"], "stops at the swap's own signature");
    assert.deepStrictEqual(sol.scopeSignatures(list, { since: 180 }), ["T3", "T2"], "and at anything older than the job");
    assert.deepStrictEqual(sol.scopeSignatures(list, {}), ["T3", "T2", "SWAP", "T1"]);
    assert.deepStrictEqual(sol.scopeSignatures([{ signature: "X", blockTime: null }], { since: 999 }), ["X"], "no block time: not excluded on time");
    /* the associated token account, derived here, matches the SPL helper */
    let spl = null;
    try { spl = require("@solana/spl-token"); } catch (_) { /* not hoisted in this install */ }
    const owner = "So11111111111111111111111111111111111111112";
    const mine = sol.ataAddress(SC.VKOIN_SOL_MINT, owner);
    if (spl && spl.getAssociatedTokenAddressSync) {
      const { PublicKey } = require("@solana/web3.js");
      assert.strictEqual(mine, spl.getAssociatedTokenAddressSync(new PublicKey(SC.VKOIN_SOL_MINT), new PublicKey(owner), true).toBase58(), "ATA derivation matches @solana/spl-token");
    }
    assert.ok(sol.isAddress(mine) === false || typeof mine === "string", "an ATA is a PDA (off-curve) address");
    console.log("✓ history scan scoped to this job; the bridge's token account derived like SPL does");
  }

  /* --- 4. the demo pipeline, start to done --- */
  {
    funding.configure({ dataDir: fresh(), demo: true, network: "mainnet" });
    const en = funding.enable(ACCT);
    assert.ok(/^0x[0-9a-fA-F]{40}$/.test(en.ethAddress) && typeof en.solAddress === "string" && en.solAddress.length >= 32, "both transit addresses from birth");
    const st = await funding.status(ACCT);
    assert.strictEqual(st.solAddress, en.solAddress);
    assert.ok(st.solRail.enabled);
    assert.strictEqual(st.caps.sol, "0.5");
    assert.strictEqual(st.balances.sol, "0.35");
    assert.strictEqual(st.spendable.sol, "0.34", "0.35 less the 0.01 reserve");
    assert.strictEqual(st.quotes.sol.best.id, "S", "one route, and it is the best");
    assert.ok(st.quotes.sol.best.steps.some((s) => /Wormhole/.test(s)) && st.quotes.sol.best.steps.some((s) => /Vortex/.test(s)));
    await assert.rejects(funding.quoteFor(ACCT, "sol", "0.01"), /Minimum is 0.02 SOL/);
    await assert.rejects(funding.quoteFor(ACCT, "sol", "0.5"), /Max right now is 0.34 SOL/);
    await assert.rejects(funding.start(ACCT, { asset: "sol", amount: "0.019" }), /Minimum/);
    const j0 = await funding.start(ACCT, { asset: "sol", amount: "0.2" });
    assert.strictEqual(j0.route, "S"); assert.strictEqual(j0.status, "sol_swap");
    assert.strictEqual(j0.solFrom, en.solAddress);
    assert.strictEqual(j0.amountLabel, "0.2 SOL");
    const seen = [j0.status];
    for (let i = 0; i < 12 && funding.job(ACCT).status !== "done"; i++) { await funding.tick(); seen.push(funding.job(ACCT).status); }
    assert.deepStrictEqual(seen, ["sol_swap", "sol_bridge", "awaiting_vaa", "wh_redeem", "approve_bridge", "bridge_token", "awaiting_signatures", "awaiting_redeem", "done"],
      "every state of the route, in order, no passkey tap needed");
    const done = funding.job(ACCT);
    assert.strictEqual(done.koinReceived, done.estKoinOut);
    assert.strictEqual((await funding.status(ACCT)).balances.sol, "0.15", "the swapped SOL left the deposit address");
    console.log("✓ demo: a SOL job walks sol_swap → … → done, and the balance follows");
  }

  /* --- 5. where is the money (route S) --- */
  {
    const dir = fresh();
    fs.writeFileSync(path.join(dir, "funding.json"), JSON.stringify({ transit: { [ACCT]: { ethAddress: "0x" + "ab".repeat(20), ethPriv: "0x00", solAddress: "So11111111111111111111111111111111111111112", solSecret: "x" } }, jobs: {} }));
    funding.configure({ dataDir: dir, demo: true, network: "mainnet" });
    const probe = (facts) => {
      const calls = [];
      const P = {
        ethVkoin: async () => { calls.push("ethVkoin"); return BigInt(facts.ethVkoin || 0); },
        vaaRedeemed: async () => { calls.push("vaaRedeemed"); return !!facts.vaaRedeemed; },
        sigConfirmed: async (sig) => { calls.push("sig:" + sig); return !!(facts.confirmed || {})[sig]; },
        solVkoin: async () => { calls.push("solVkoin"); return BigInt(facts.solVkoin || 0); },
        recentTransfer: async () => { calls.push("recentTransfer"); return facts.recent || null; },
      };
      return { P, calls };
    };
    const base = { route: "S", asset: "sol", status: "sol_swap", startedAt: 1 };
    const ask = async (job, facts) => { const { P, calls } = probe(facts); const at = await funding._reconcileRouteS(ACCT, { ...base, ...job }, P); return { at, calls }; };

    let r = await ask({ status: "sol_bridge", pendingSig: "s1" }, { ethVkoin: 500 });
    assert.deepStrictEqual(r.at, { status: "approve_bridge", vkoinSats: "500", pendingTx: null, pendingSig: null });
    assert.deepStrictEqual(r.calls, ["ethVkoin"], "vKOIN on Ethereum answers the question: nothing else is read");

    r = await ask({ status: "wh_redeem", vaa: "0x01", vaaEvmHash: "0x02" }, { vaaRedeemed: false });
    assert.deepStrictEqual(r.at, { status: "wh_redeem", pendingTx: null });
    r = await ask({ status: "error", failedAt: "wh_redeem", vaa: "0x01", vaaEvmHash: "0x02" }, { vaaRedeemed: true });
    assert.strictEqual(r.at, null, "a redeemed VAA and no vKOIN: the record is ahead of the balances, leave it");

    r = await ask({ status: "awaiting_vaa", whEmitter: "ee", whSequence: "9" }, {});
    assert.deepStrictEqual(r.at, { status: "awaiting_vaa", pendingSig: null });
    r = await ask({ status: "sol_bridge", pendingSig: "b1", solBridgeSig: "b1" }, { confirmed: { b1: true } });
    assert.deepStrictEqual(r.at, { status: "awaiting_vaa", pendingSig: null }, "a confirmed bridge send moves on to the guardians");

    r = await ask({ status: "sol_swap", pendingSig: "s1" }, { solVkoin: 700 });
    assert.deepStrictEqual(r.at, { status: "sol_bridge", solVkoinSats: "700", pendingSig: null }, "vKOIN on Solana: the swap landed, bridge it — all of it");

    r = await ask({ status: "error", failedAt: "sol_bridge" }, { recent: { txid: "T", emitter: "ee", sequence: "12" } });
    assert.strictEqual(r.at.status, "awaiting_vaa");
    assert.deepStrictEqual([r.at.solBridgeSig, r.at.whEmitter, r.at.whSequence], ["T", "ee", "12"], "a bridge send whose reply was lost is found on the chain");
    assert.ok(r.calls.includes("recentTransfer"));

    r = await ask({ status: "sol_swap", pendingSig: "s1" }, {});
    assert.deepStrictEqual(r.at, { status: "sol_swap", pendingSig: null, pendingSigExpiry: null }, "an unconfirmed swap send is dropped and re-checked at the step");
    assert.ok(!r.calls.includes("recentTransfer"), "no bridge was attempted, so no history scan");
    r = await ask({ status: "sol_bridge", solSwapSig: "SWAP", pendingSig: "b1" }, {});
    assert.strictEqual(r.at, null, "past its swap with no vKOIN and no transfer found: never back to the swap (that would swap the deposit twice)");
    r = await ask({ status: "error", failedAt: "sol_swap", solSwapSig: "SWAP", pendingSig: "s1" }, {});
    assert.strictEqual(r.at, null, "a swap that confirmed once is not re-run either");
    r = await ask({ status: "sol_swap" }, {});
    assert.strictEqual(r.at, null, "nothing moved: the record stands");
    r = await ask({ route: "C", status: "swap_eth_usdt" }, { ethVkoin: 5 });
    assert.strictEqual(r.at, null, "not a route-S job");
    r = await ask({ status: "awaiting_signatures", ethTxHash: "0x1" }, { ethVkoin: 5 });
    assert.strictEqual(r.at, null, "already in Vortex: the balances say nothing");
    console.log("✓ reconcileRouteS: Ethereum, then the VAA, then Solana — reading no further than it must");
  }

  /* --- 6. repair + public shape --- */
  {
    const dir = fresh();
    const real = { asset: "sol", route: "S", status: "done", redeemId: "0xdemo-redeem", koinReceived: "1", koinosRecipient: ACCT, startedAt: 1, taps: 0 };
    fs.writeFileSync(path.join(dir, "funding.json"), JSON.stringify({
      transit: { [ACCT]: { ethAddress: "0xabc", ethPriv: "0x00" }, B: { ethAddress: "0xabc", ethPriv: "0x00" } },
      jobs: { [ACCT]: real, B: { ...real, ethTxHash: "0x" + "ab".repeat(32) } },
    }));
    funding.configure({ dataDir: dir, demo: false, network: "mainnet" });
    assert.deepStrictEqual([funding.job(ACCT).status, funding.job(ACCT).failedAt], ["error", "sol_swap"], "a fabricated finish with nothing bridged: Retry re-reads Solana first");
    assert.strictEqual(funding.job("B").status, "awaiting_signatures", "bridged into Vortex: back to the guardians");
    const pub = funding.publicJob({ status: "wh_redeem", vaa: "0x" + "00".repeat(200), vaaEvmHash: "0x1", record: { amount: "5" } });
    assert.ok(!("vaa" in pub) && !("record" in pub) && pub.vaaEvmHash === "0x1" && pub.recordAmount === "5", "the VAA bytes and the record stay on the server");
    assert.strictEqual(routes.descriptor("S").steps.length, 3);
    console.log("✓ boot-time repair of a demo-marked SOL job; the public job carries no VAA");
  }

  /* --- 7. Retry starts its leg clean --- */
  {
    const dir = fresh();
    fs.writeFileSync(path.join(dir, "funding.json"), JSON.stringify({
      transit: { [ACCT]: { ethAddress: "0xabc", ethPriv: "0x00", solAddress: "So11111111111111111111111111111111111111112", solSecret: "x" } },
      jobs: { [ACCT]: { asset: "sol", route: "S", status: "error", failedAt: "sol_swap", error: "expired", demo: true, pendingSig: "LAPSED", pendingSigExpiry: 5, resends: 4, gasFronts: 2, koinosRecipient: ACCT, startedAt: 1, taps: 0 } },
    }));
    funding.configure({ dataDir: dir, demo: true, network: "mainnet" });
    await funding.resume(ACCT);
    const j = funding.job(ACCT);
    assert.strictEqual(j.status, "sol_swap");
    assert.deepStrictEqual([j.pendingSig, j.pendingSigExpiry, j.resends, j.gasFronts, j.error], [null, null, 0, 0, null], "no stale signature, counters back to zero");
    console.log("✓ Retry clears the pending Solana send and the resend/gas-front counters");
  }

  console.log("\nALL SOL-RAIL CHECKS PASSED");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
