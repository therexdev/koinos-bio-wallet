/* The dependency-free Solana primitives, held against the real library.

   tools/sol/solana-lite.js exists because the rail must not stop working when
   an optional package is missing from the host. That is only worth anything
   if it is EXACTLY right, so every primitive here is compared against
   @solana/web3.js — the same inputs, the same bytes out. Where web3.js is not
   installed the file is skipped rather than pretended-passed.

   Run: node tests/solana-lite.test.js
*/
"use strict";
const assert = require("node:assert");
const crypto = require("node:crypto");
const lite = require("../tools/sol/solana-lite");
const keys = require("../tools/sol/keys");

let web3 = null;
try { web3 = require("@solana/web3.js"); } catch (_) { /* not installed here */ }
if (!web3) {
  console.log("• @solana/web3.js is not installed — nothing to compare against, skipping");
  process.exit(0);
}
const { PublicKey, Keypair, Transaction, TransactionInstruction, SystemProgram } = web3;

(() => {
  /* --- 1. on-curve: the whole basis of deriving a program address --- */
  {
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      const kp = Keypair.generate();
      assert.strictEqual(lite.isOnCurve(kp.publicKey.toBytes()), PublicKey.isOnCurve(kp.publicKey.toBytes()),
        "a real key must read as on-curve");
      checked++;
      /* random 32 bytes are usually NOT a point — the interesting case */
      const r = crypto.randomBytes(32);
      assert.strictEqual(lite.isOnCurve(r), PublicKey.isOnCurve(r), "random bytes must agree with web3.js");
      checked++;
    }
    assert.strictEqual(lite.isOnCurve(Buffer.alloc(31)), false, "wrong length is not a point");
    console.log(`✓ ed25519 on-curve test agrees with @solana/web3.js on ${checked} values`);
  }

  /* --- 2. program addresses and associated token accounts --- */
  {
    const progs = ["wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb", "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth", lite.ASSOCIATED_TOKEN_PROGRAM];
    for (const prog of progs) {
      for (const seedSet of [[Buffer.from("config")], [Buffer.from("authority_signer")], [Buffer.from("Bridge")], [Buffer.from("emitter")], [Buffer.from("fee_collector")]]) {
        const mine = lite.findProgramAddress(seedSet, prog);
        const [addr, bump] = PublicKey.findProgramAddressSync(seedSet, new PublicKey(prog));
        assert.strictEqual(mine.address, addr.toBase58());
        assert.strictEqual(mine.bump, bump);
      }
    }
    /* seeds with a 32-byte key in them, and the bump loop actually running */
    for (let i = 0; i < 60; i++) {
      const kp = Keypair.generate();
      const seeds = [Buffer.from("meta"), kp.publicKey.toBuffer()];
      const mine = lite.findProgramAddress(seeds, "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb");
      const [addr, bump] = PublicKey.findProgramAddressSync(seeds, new PublicKey("wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb"));
      assert.strictEqual(mine.address, addr.toBase58());
      assert.strictEqual(mine.bump, bump);
    }
    /* the ATA, which is what actually holds the tokens we bridge */
    const spl = (() => { try { return require("@solana/spl-token"); } catch (_) { return null; } })();
    for (let i = 0; i < 60; i++) {
      const owner = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
      const mine = lite.associatedTokenAddress(owner.toBase58(), owner.toBase58());
      const [ref] = PublicKey.findProgramAddressSync(
        [owner.toBuffer(), new PublicKey(lite.TOKEN_PROGRAM).toBuffer(), owner.toBuffer()],
        new PublicKey(lite.ASSOCIATED_TOKEN_PROGRAM));
      assert.strictEqual(mine, ref.toBase58());
      if (spl && spl.getAssociatedTokenAddressSync) {
        assert.strictEqual(lite.associatedTokenAddress(mint.toBase58(), owner.toBase58()),
          spl.getAssociatedTokenAddressSync(mint, owner, true).toBase58(), "matches @solana/spl-token too");
      }
    }
    console.log("✓ program addresses and associated token accounts match, bump for bump");
  }

  /* --- 3. signing: a signature Solana itself would accept --- */
  {
    for (let i = 0; i < 50; i++) {
      const k = keys.newKeypair();
      const kp = Keypair.fromSecretKey(lite.b58.decode(k.solSecret));
      assert.strictEqual(kp.publicKey.toBase58(), k.solAddress);
      const msg = crypto.randomBytes(96);
      const mine = lite.sign(msg, k.solSecret);
      assert.strictEqual(mine.length, 64);
      assert.ok(crypto.verify(null, msg, crypto.createPublicKey({
        key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), kp.publicKey.toBuffer()]),
        format: "der", type: "spki",
      }), mine), "the signature verifies against the public key");
    }
    console.log("✓ ed25519 signing produces valid 64-byte signatures for the right key");
  }

  /* --- 4. a whole transaction, byte for byte --- */
  {
    for (let i = 0; i < 40; i++) {
      const payer = keys.newKeypair();
      const payerKp = Keypair.fromSecretKey(lite.b58.decode(payer.solSecret));
      const other = Keypair.generate().publicKey;
      const extra = Keypair.generate().publicKey;
      const blockhash = Keypair.generate().publicKey.toBase58();
      const data = crypto.randomBytes(1 + (i % 40));
      const progId = "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb";
      const metas = [
        { pubkey: payerKp.publicKey.toBase58(), isSigner: true, isWritable: true },
        { pubkey: other.toBase58(), isSigner: false, isWritable: true },
        { pubkey: extra.toBase58(), isSigner: false, isWritable: false },
        { pubkey: lite.SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      ];
      const mine = lite.compileMessage({
        payer: payer.solAddress,
        instructions: [{ programId: progId, keys: metas, data }],
        recentBlockhash: blockhash,
      });
      const ref = new Transaction();
      ref.add(new TransactionInstruction({
        programId: new PublicKey(progId),
        keys: metas.map((m) => ({ pubkey: new PublicKey(m.pubkey), isSigner: m.isSigner, isWritable: m.isWritable })),
        data,
      }));
      ref.feePayer = payerKp.publicKey;
      ref.recentBlockhash = blockhash;
      assert.strictEqual(mine.message.toString("hex"), ref.serializeMessage().toString("hex"),
        "the compiled message is identical to the one web3.js builds");
      const signed = lite.signTransaction(mine.message, mine.signers, { [payer.solAddress]: payer.solSecret });
      ref.partialSign(payerKp);
      assert.strictEqual(signed.toString("hex"), ref.serialize().toString("hex"),
        "and so is the signed transaction");
    }
    console.log("✓ compiled and signed transactions are byte-identical to @solana/web3.js");
  }

  /* --- 5. re-signing a transaction built elsewhere (Jupiter's swap) --- */
  {
    const payer = keys.newKeypair();
    const payerKp = Keypair.fromSecretKey(lite.b58.decode(payer.solSecret));
    const { VersionedTransaction, TransactionMessage } = web3;
    const msg = new TransactionMessage({
      payerKey: payerKp.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [SystemProgram.transfer({ fromPubkey: payerKp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
    }).compileToV0Message();
    const unsigned = Buffer.from(new VersionedTransaction(msg).serialize());
    const mine = lite.signSerialized(unsigned, payer.solSecret);
    const ref = new VersionedTransaction(msg);
    ref.sign([payerKp]);
    assert.strictEqual(Buffer.from(ref.serialize()).toString("hex"), mine.raw.toString("hex"),
      "a v0 transaction signed in place matches web3.js");
    assert.strictEqual(mine.signature, lite.b58.encode(ref.signatures[0]), "and reports the same signature");
    assert.strictEqual(mine.versioned, true);
    /* and it refuses one that does not want our signature */
    assert.throws(() => lite.signSerialized(unsigned, keys.newKeypair().solSecret), /does not ask for our signature/);
    console.log("✓ re-signing a prebuilt v0 transaction matches, and refuses the wrong key");
  }

  console.log("\nALL SOLANA-LITE CHECKS PASSED");
})();
