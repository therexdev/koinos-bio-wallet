/* The hand-built Wormhole transfer, held against the real SDK.

   tools/sol/wormhole-lite.js exists so a SOL deposit can be bridged on a host
   that does not have the Wormhole packages. That is only safe if it is exactly
   what the SDK would have sent — this transfer moves real money — so every
   instruction is generated both ways and the bytes must match.

   Run: node tests/wormhole-lite.test.js
*/
"use strict";
const assert = require("node:assert");
const wl = require("../tools/sol/wormhole-lite");
const L = require("../tools/sol/solana-lite");
const C = require("../tools/sol/sol-constants");

let web3 = null, sdk = null;
try { web3 = require("@solana/web3.js"); sdk = require("@wormhole-foundation/sdk-solana-tokenbridge"); }
catch (_) { /* not installed here */ }
if (!web3 || !sdk) {
  console.log("• the Wormhole packages are not installed — nothing to compare against, skipping");
  process.exit(0);
}
const { PublicKey, Connection } = web3;
const conn = new Connection("http://127.0.0.1:1/", "confirmed");
const TB = C.WORMHOLE.solanaTokenBridge, CORE = C.WORMHOLE.solanaCore;
const TOKEN = L.TOKEN_PROGRAM;

const sameIx = (mine, ref, what) => {
  assert.strictEqual(mine.programId, ref.programId.toBase58(), `${what}: program id`);
  assert.strictEqual(Buffer.from(mine.data).toString("hex"), Buffer.from(ref.data).toString("hex"), `${what}: data`);
  assert.strictEqual(mine.keys.length, ref.keys.length, `${what}: account count`);
  ref.keys.forEach((k, i) => {
    assert.strictEqual(mine.keys[i].pubkey, k.pubkey.toBase58(), `${what}: account ${i}`);
    assert.strictEqual(!!mine.keys[i].isSigner, k.isSigner, `${what}: account ${i} signer flag`);
    assert.strictEqual(!!mine.keys[i].isWritable, k.isWritable, `${what}: account ${i} writable flag`);
  });
};

(async () => {
  /* --- 1. the fixed accounts --- */
  {
    const u = sdk;
    assert.strictEqual(wl.ACCOUNTS.config, u.deriveTokenBridgeConfigKey(TB).toBase58());
    assert.strictEqual(wl.ACCOUNTS.authoritySigner, u.deriveAuthoritySignerKey(TB).toBase58());
    const core = require("@wormhole-foundation/sdk-solana-core");
    assert.strictEqual(wl.ACCOUNTS.emitter, core.utils.deriveWormholeEmitterKey(TB).toBase58());
    assert.strictEqual(wl.ACCOUNTS.bridge, core.utils.deriveWormholeBridgeDataKey(CORE).toBase58());
    assert.strictEqual(wl.ACCOUNTS.feeCollector, core.utils.deriveFeeCollectorKey(CORE).toBase58());
    assert.strictEqual(wl.ACCOUNTS.sequence, core.utils.deriveEmitterSequenceKey(wl.ACCOUNTS.emitter, CORE).toBase58());
    console.log("✓ every fixed bridge account matches the SDK's own derivation");
  }

  /* --- 2. the wrapped mints, including the two this wallet uses --- */
  {
    const u = sdk;
    const pad = (hex) => Buffer.from("000000000000000000000000" + hex.replace(/^0x/, ""), "hex");
    for (const [name, addr, expect] of [
      ["wETH", C.WETH_ETH, C.WETH_SOL_MINT],
      ["vKOIN", C.VKOIN_ETH, C.VKOIN_SOL_MINT],
    ]) {
      const mine = wl.wrappedMint(2, pad(addr));
      assert.strictEqual(mine, u.deriveWrappedMintKey(TB, 2, pad(addr)).toBase58(), `${name} mint vs SDK`);
      assert.strictEqual(mine, expect, `${name} mint is the constant this wallet ships`);
      assert.strictEqual(wl.wrappedMeta(mine), u.deriveWrappedMetaKey(TB, mine).toBase58(), `${name} meta`);
    }
    console.log("✓ the wrapped mints derive to the wETH and vKOIN this wallet ships, and their metadata matches");
  }

  /* --- 3. the two instructions, byte for byte, over many shapes --- */
  {
    const rand = () => new web3.Keypair().publicKey ? null : null;
    let n = 0;
    for (const amount of [1n, 42n, 12345678n, 4294967296n, 18446744073709551615n / 2n]) {
      for (const nonce of [0, 7, 65535]) {
        const payer = web3.Keypair.generate().publicKey.toBase58();
        const owner = web3.Keypair.generate().publicKey.toBase58();
        const message = web3.Keypair.generate().publicKey.toBase58();
        const eth = "0x" + Buffer.from(web3.Keypair.generate().publicKey.toBytes()).subarray(0, 20).toString("hex");
        const target = Buffer.concat([Buffer.alloc(12), Buffer.from(eth.slice(2), "hex")]);
        const originAddr = Buffer.concat([Buffer.alloc(12), Buffer.from(C.WETH_ETH.slice(2), "hex")]);
        const mint = wl.wrappedMint(2, originAddr);
        const from = L.associatedTokenAddress(mint, owner);

        sameIx(
          wl.approveInstruction({ source: from, owner, amount }),
          sdk.createApproveAuthoritySignerInstruction(TB, from, owner, amount, new PublicKey(TOKEN)),
          "approve");

        sameIx(
          wl.transferWrappedInstruction({ payer, message, from, fromOwner: owner, mint, nonce, amount, fee: 0n, recipient32: target, targetChainId: 2 }),
          sdk.createTransferWrappedInstruction(conn, TB, CORE, payer, message, from, owner, 2, originAddr, new PublicKey(TOKEN), nonce, amount, 0n, target, 2),
          "transferWrapped");
        n += 2;
      }
    }
    console.log(`✓ ${n} generated instructions are byte-identical to the Wormhole SDK's`);
  }

  /* --- 4. the VAA parser, against VAAs the SDK itself serialised --- */
  {
    const wh = require("../tools/sol/wormhole.js");
    const { ethers } = require("ethers");
    const connect = require("@wormhole-foundation/sdk-connect");
    let n = 0;
    for (const [token, expect] of [[C.WETH_ETH, C.WETH_ETH], [C.VKOIN_ETH, C.VKOIN_ETH]]) {
      for (const sigCount of [0, 1, 13]) {
        for (const amount of [1n, 4000000n, 123456789012n]) {
          const to = "0x" + Buffer.from(web3.Keypair.generate().publicKey.toBytes()).subarray(0, 20).toString("hex");
          const vaa = connect.createVAA("TokenBridge:Transfer", {
            guardianSet: 4, timestamp: 1700000000, nonce: 11, emitterChain: "Solana",
            emitterAddress: new connect.UniversalAddress("0x" + wh.EMITTER_HEX),
            sequence: 987654321n, consistencyLevel: 32,
            signatures: Array.from({ length: sigCount }, (_, i) => ({
              guardianIndex: i, signature: new connect.Signature(1n, 2n, 0),
            })),
            payload: {
              token: { amount, address: new connect.UniversalAddress(ethers.zeroPadValue(token, 32)), chain: "Ethereum" },
              to: { address: new connect.UniversalAddress(ethers.zeroPadValue(to, 32)), chain: "Ethereum" }, fee: 0n,
            },
          });
          const hex = ethers.hexlify(connect.serialize(vaa));
          const mine = await wh.parseTransferVaa(hex, { expectRecipient: to, expectToken: expect });
          assert.strictEqual(mine.amount, amount.toString(), "amount");
          assert.strictEqual(mine.to, to.toLowerCase(), "recipient");
          assert.strictEqual(mine.token, token.toLowerCase(), "token");
          assert.strictEqual(mine.sequence, "987654321", "sequence");
          assert.strictEqual(mine.emitterChain, "Solana");
          assert.strictEqual(mine.toChain, "Ethereum");
          assert.strictEqual(mine.hash, ethers.hexlify(vaa.hash), "the body hash matches the SDK's");
          assert.strictEqual(mine.evmHash, ethers.keccak256(ethers.hexlify(vaa.hash)), "and Ethereum's double hash");
          n++;
        }
      }
    }
    /* and it still refuses the wrong token or the wrong recipient */
    const bad = connect.createVAA("TokenBridge:Transfer", {
      guardianSet: 4, timestamp: 1, nonce: 0, emitterChain: "Solana",
      emitterAddress: new connect.UniversalAddress("0x" + wh.EMITTER_HEX),
      sequence: 1n, consistencyLevel: 32, signatures: [],
      payload: {
        token: { amount: 1n, address: new connect.UniversalAddress(ethers.zeroPadValue(C.WETH_ETH, 32)), chain: "Ethereum" },
        to: { address: new connect.UniversalAddress(ethers.zeroPadValue("0x" + "11".repeat(20), 32)), chain: "Ethereum" }, fee: 0n,
      },
    });
    const badHex = ethers.hexlify(connect.serialize(bad));
    await assert.rejects(wh.parseTransferVaa(badHex, { expectRecipient: "0x" + "22".repeat(20), expectToken: C.WETH_ETH }), /different recipient/);
    await assert.rejects(wh.parseTransferVaa(badHex, { expectToken: C.VKOIN_ETH }), /not a vKOIN transfer/);
    console.log(`✓ ${n} VAAs parsed identically to the SDK, hashes included, with the wrong ones still refused`);
  }

  console.log("\nALL WORMHOLE-LITE CHECKS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
