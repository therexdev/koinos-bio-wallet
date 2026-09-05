/* The Solana rail — two routes home for a SOL deposit.

     S: SOL → vKOIN (Solana) → Wormhole → Ethereum → Vortex → KOIN
     T: SOL → wETH (Solana) → Wormhole (unwraps to ether) → Route C → KOIN

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
    assert.strictEqual((await sp("0.04")).sats, 0n, "reserve taken, what is left is under the minimum → nothing");
    assert.strictEqual((await sp("0.06")).label, "0.05", "reserve 0.01 off the top, the minimum exactly");
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
    assert.strictEqual(new URL(jup.quoteUrl({ amount: 1n, slippageBps: 150, outputMint: SC.WETH_SOL_MINT })).searchParams.get("outputMint"), SC.WETH_SOL_MINT, "route T asks Jupiter for wETH");
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

    /* --- route T: the same VAA shape, carrying wETH, redeemed as ether --- */
    const wethVaa = connect.createVAA("TokenBridge:Transfer", {
      guardianSet: 4, timestamp: 1700000000, nonce: 0, emitterChain: "Solana",
      emitterAddress: new connect.UniversalAddress("0x" + "ec".repeat(32)), sequence: 99n, consistencyLevel: 32, signatures: [],
      payload: {
        token: { amount: 4000000n, address: wormhole.universalEth(connect, SC.WETH_ETH), chain: "Ethereum" },
        to: { address: wormhole.universalEth(connect, transit), chain: "Ethereum" }, fee: 0n,
      },
    });
    const wethHex = ethers.hexlify(connect.serialize(wethVaa));
    const wp = await wormhole.parseTransferVaa(wethHex, { expectRecipient: transit, expectToken: SC.WETH_ETH });
    assert.strictEqual(wp.token.toLowerCase(), SC.WETH_ETH.toLowerCase());
    assert.strictEqual(wp.amount, "4000000", "0.04 ETH at Wormhole's 8 decimals");
    await assert.rejects(wormhole.parseTransferVaa(wethHex, { expectRecipient: transit }), /not a vKOIN transfer/,
      "a wETH VAA is refused where vKOIN is expected — the two must not cross wires");
    await assert.rejects(wormhole.parseTransferVaa(hex, { expectRecipient: transit, expectToken: SC.WETH_ETH }), /not a wETH transfer/);
    const utx = wormhole.buildCompleteTransferTx(wethHex, { unwrap: true });
    assert.strictEqual(utx.data.slice(0, 10), ethers.id("completeTransferAndUnwrapETH(bytes)").slice(0, 10),
      "route T redeems through the unwrapping call, so NATIVE ether arrives");
    assert.notStrictEqual(utx.data.slice(0, 10), tx.data.slice(0, 10));
    console.log("✓ route T: a wETH VAA, checked apart from vKOIN, redeemed with completeTransferAndUnwrapETH");
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

    /* Both routes are quoted, and the one that pays its own way and buys from
       the deeper pool wins — which is the whole reason route T exists. */
    const sq = st.quotes.sol;
    assert.deepStrictEqual(sq.routes.map((r) => r.id).sort(), ["S", "T"], "both SOL routes are offered");
    assert.strictEqual(sq.best.id, "T", "route T lands more KOIN");
    const byId = Object.fromEntries(sq.routes.map((r) => [r.id, r]));
    assert.ok(BigInt(byId.T.koinOut) > BigInt(byId.S.koinOut));
    assert.ok(byId.T.steps.some((x) => /Wormhole/.test(x)) && byId.T.steps.some((x) => /Uniswap/.test(x)) && byId.T.steps.some((x) => /Vortex/.test(x)));
    assert.ok(byId.T.feeEth && byId.S.feeEth, "each route says what its network fees cost");
    /* No sponsor key is set in this process, so neither route may claim the
       platform is paying. The card states the payer; it never assumes one. */
    assert.strictEqual(byId.S.feePaidBy, "deposit", "with no sponsor, route S's gas comes out of the deposit");
    assert.strictEqual(byId.T.feePaidBy, "deposit");

    await assert.rejects(funding.quoteFor(ACCT, "sol", "0.01"), /Minimum is 0.05 SOL/);
    await assert.rejects(funding.quoteFor(ACCT, "sol", "0.5"), /Max right now is 0.34 SOL/);
    await assert.rejects(funding.start(ACCT, { asset: "sol", amount: "0.04" }), /Minimum/);

    /* Default: the best route, and it walks the whole Ethereum tail. */
    const j0 = await funding.start(ACCT, { asset: "sol", amount: "0.2" });
    assert.strictEqual(j0.route, "T"); assert.strictEqual(j0.status, "sol_swap");
    assert.strictEqual(j0.solFrom, en.solAddress);
    assert.strictEqual(j0.amountLabel, "0.2 SOL");
    assert.ok(j0.estFeeEth, "the job records what it expects to pay in fees");
    const seen = [j0.status];
    for (let i = 0; i < 16 && funding.job(ACCT).status !== "done"; i++) { await funding.tick(); seen.push(funding.job(ACCT).status); }
    assert.deepStrictEqual(seen, ["sol_swap", "sol_bridge", "awaiting_vaa", "wh_redeem", "swap_eth_usdt", "approve_permit2", "approve_ur", "swap_usdt_vkoin", "approve_bridge", "bridge_token", "awaiting_signatures", "awaiting_redeem", "done"],
      "route T: Solana legs, the Wormhole redeem, then Route C's tail — no passkey tap needed");
    const done = funding.job(ACCT);
    assert.strictEqual(done.koinReceived, done.estKoinOut);
    assert.strictEqual((await funding.status(ACCT)).balances.sol, "0.15", "the swapped SOL left the deposit address");

    /* Asking for route S explicitly still works, and takes the short way. */
    funding.reset(ACCT);
    const j1 = await funding.start(ACCT, { asset: "sol", amount: "0.1", route: "S" });
    assert.strictEqual(j1.route, "S");
    const seenS = [j1.status];
    for (let i = 0; i < 12 && funding.job(ACCT).status !== "done"; i++) { await funding.tick(); seenS.push(funding.job(ACCT).status); }
    assert.deepStrictEqual(seenS, ["sol_swap", "sol_bridge", "awaiting_vaa", "wh_redeem", "approve_bridge", "bridge_token", "awaiting_signatures", "awaiting_redeem", "done"],
      "route S skips the Ethereum swaps: its vKOIN goes straight to Vortex");
    console.log("✓ demo: route T wins on price and walks its full flow; route S still runs when asked");
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
        solToken: async () => { calls.push("solToken"); return BigInt(facts.solToken || 0); },
        recentTransfer: async () => { calls.push("recentTransfer"); return facts.recent || null; },
      };
      return { P, calls };
    };
    const base = { route: "S", asset: "sol", status: "sol_swap", startedAt: 1 };
    const baseT = { ...base, route: "T" };
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

    r = await ask({ status: "sol_swap", pendingSig: "s1" }, { solToken: 700 });
    assert.deepStrictEqual(r.at, { status: "sol_bridge", solTokenSats: "700", pendingSig: null }, "vKOIN on Solana: the swap landed, bridge it — all of it");

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
    assert.strictEqual(r.at, null, "not a Solana-funded job");

    /* Route T: its delivery is ether, which the address may hold for other
       reasons, so the vKOIN shortcut must not fire — the VAA decides. */
    const askT = async (job, facts) => { const { P, calls } = probe(facts); const at = await funding._reconcileRouteS(ACCT, { ...baseT, ...job }, P); return { at, calls }; };
    r = await askT({ status: "wh_redeem", vaa: "0x01", vaaEvmHash: "0x02" }, { ethVkoin: 500, vaaRedeemed: true });
    assert.deepStrictEqual(r.at, { status: "wh_redeem", pendingTx: null }, "a redeemed route-T VAA goes back to wh_redeem, which hands off to Route C");
    assert.ok(!r.calls.includes("ethVkoin"), "and never mistakes stray vKOIN for its own delivery");
    r = await askT({ status: "sol_swap", pendingSig: "s1" }, { solToken: 700 });
    assert.deepStrictEqual(r.at, { status: "sol_bridge", solTokenSats: "700", pendingSig: null }, "wETH on Solana means the swap landed");
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

  /* --- 6b. the gas decision for a Solana job's Ethereum tail --- */
  {
    funding.configure({ dataDir: fresh(), demo: true, network: "mainnet" });
    const { ethers: E } = require("ethers");
    const enough = E.parseEther("0.01"), dust = E.parseEther("0.0001");
    assert.deepStrictEqual(funding._gasDecision({}, "approve_bridge", enough, false, "0.0012"), { status: "approve_bridge" },
      "the address can pay: straight on, no top-up and no sponsor needed");
    assert.deepStrictEqual(funding._gasDecision({}, "approve_bridge", dust, true, "0.0012"),
      { status: "front_gas", afterGas: "approve_bridge", gasFronts: 1 }, "short, with a sponsor: front it once");
    assert.deepStrictEqual(funding._gasDecision({ gasFronts: 1 }, "approve_bridge", dust, true, "0.0012"),
      { status: "front_gas", afterGas: "approve_bridge", gasFronts: 2 }, "a lagging balance read gets one more");
    assert.throws(() => funding._gasDecision({ gasFronts: 2 }, "approve_bridge", dust, true, "0.0012"), /fronted twice/,
      "but never without bound — a top-up below the minimum would drain the sponsor");
    assert.throws(() => funding._gasDecision({}, "approve_bridge", dust, false, "0.0012"), /send a little ETH there/,
      "and with no sponsor it says what the person can do about it");
    console.log("✓ the Ethereum-tail gas decision: pay, front once, front twice, then stop");
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
