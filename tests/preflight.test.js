/* The on-chain passkey pre-flight: does verifyPasskeyOnChain() read the sign
   module's answer correctly?

   This matters because the module returns a protobuf bool: `true` encodes to
   one byte, but `false` encodes to NOTHING AT ALL. A naive reader sees an
   empty result and concludes "no answer" — exactly backwards for the one case
   worth catching. These checks pin the three outcomes the submit path acts on:

     accepted   → ok true      (submit)
     rejected   → ok false + the module's own reason (block, and say why)
     unreadable → ok null      (never block on a quiet RPC)
*/
"use strict";
const assert = require("assert");

/* koilib captures cross-fetch through __importDefault at load time, so the
   seam has to be in place BEFORE koilib is required — hence the dispatcher
   swap here, above every other require. */
let HOOK = null;
{
  const path = require.resolve("cross-fetch");
  require(path);
  const real = require.cache[path].exports;
  const dispatcher = (...args) => (HOOK ? HOOK(...args) : real(...args));
  dispatcher.default = dispatcher;
  require.cache[path].exports = dispatcher;
}

const { Serializer, Signer, utils } = require("koilib");
const chain = require("../tools/chain");
const ABI = require("../contracts/vendor/mod-sign-webauthn/modsignwebauthn-abi.json");

const M = ABI.methods.is_valid_signature;
const ACCOUNT = Signer.fromSeed("preflight-account").getAddress();
const MODSIGN = Signer.fromSeed("preflight-modsign").getAddress();
const TXID = "0x1220" + "ab".repeat(32);
const SIG = "_wJKMwoUY3JlZGVudGlhbA==";

/** Answer every RPC call with `reply(body)`; returns the calls it saw. */
function serve(reply) {
  const calls = [];
  HOOK = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    return { json: async () => reply(body) };
  };
  return calls;
}

const ser = new Serializer(ABI.koilib_types);
const encodeResult = async (value) =>
  utils.encodeBase64url(await ser.serialize({ value }, M.return));

chain.configure({
  network: "mainnet",
  rpcs: ["http://stub.invalid"],
  modules: { modSign: MODSIGN, modValidation: "", verifier: "" },
});

(async () => {
  /* --- 1. accepted: the module returns true --- */
  {
    const encoded = await encodeResult(true);
    const calls = serve(() => ({ jsonrpc: "2.0", id: 1, result: { result: encoded, logs: [] } }));
    const out = await chain.verifyPasskeyOnChain(ACCOUNT, SIG, TXID);
    assert.strictEqual(out.ok, true, "a true result must read as accepted");
    assert.strictEqual(calls[0].method, "chain.read_contract");
    assert.strictEqual(calls[0].params.contract_id, MODSIGN);
    assert.strictEqual(calls[0].params.entry_point, M.entry_point);
    const args = await ser.deserialize(utils.decodeBase64url(calls[0].params.args), M.argument);
    assert.deepStrictEqual(args, { sender: ACCOUNT, signature: SIG, tx_id: TXID },
      "the module must be asked about THIS account, signature and transaction");
    console.log("✓ accepted: reads true, and asks about the right account/sig/tx");
  }

  /* --- 2. rejected: false encodes to nothing; the log carries the reason --- */
  assert.strictEqual(await encodeResult(false), "",
    "protobuf must omit a false bool — the whole reason this test exists");
  for (const reason of [
    "[mod-sign-webauthn] credential not registered",
    "[mod-sign-webauthn] invalid signature",
    "[mod-sign-webauthn] txId mismatch [tx_id: AAA] [challenge: BBB]",
  ]) {
    serve(() => ({ jsonrpc: "2.0", id: 1, result: { logs: [reason] } }));
    const out = await chain.verifyPasskeyOnChain(ACCOUNT, SIG, TXID);
    assert.strictEqual(out.ok, false, `an empty result plus "${reason}" must read as rejected`);
    assert.deepStrictEqual(out.logs, [reason], "the module's own reason must survive");
    console.log(`✓ rejected: ${reason.replace("[mod-sign-webauthn] ", "")}`);
  }

  /* --- 3. unreadable: never block on silence or an RPC failure --- */
  {
    serve(() => ({ jsonrpc: "2.0", id: 1, result: {} }));
    const out = await chain.verifyPasskeyOnChain(ACCOUNT, SIG, TXID);
    assert.strictEqual(out.ok, null, "no result and no log must stay undecided, not 'rejected'");
    console.log("✓ silence stays undecided (a quiet node must not block a good signature)");
  }
  {
    serve(() => ({ jsonrpc: "2.0", id: 1, error: { message: "cannot put object during read only call" } }));
    const out = await chain.verifyPasskeyOnChain(ACCOUNT, SIG, TXID);
    assert.strictEqual(out.ok, null, "an RPC error must stay undecided");
    assert.ok(out.error, "and must be reported as an error, not a verdict");
    console.log("✓ an RPC error stays undecided and never throws");
  }

  HOOK = null;
  console.log("\nALL PRE-FLIGHT CHECKS PASSED");
})().catch((e) => { console.error("FAILED:", e.message, "\n", e.stack); process.exit(1); });
