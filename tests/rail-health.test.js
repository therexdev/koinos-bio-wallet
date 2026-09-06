/* Did ETH_RPC, SOLANA_RPC and ETH_GAS_SPONSOR_KEY actually take?

   Both RPC settings fall through to public endpoints when they fail. That
   is right for a deposit that must not go dark, and it means a mistyped
   key is INVISIBLE: the wallet keeps working on public nodes until they
   start refusing datacenter traffic, and the only symptom is intermittent
   failure weeks later. railHealth exists to say so out loud, and this file
   holds it to two promises:

     1. it probes each configured endpoint on its own, so a healthy
        fallback can never disguise a broken setting;
     2. it gives away nothing. The key lives inside the RPC URL, and RPC
        errors love to echo the whole URL back — so the 403 case below is
        served by a stand-in that does exactly that, and the answer is
        checked for the key, the path and the query string.

   Run: node tests/rail-health.test.js
*/
"use strict";
const assert = require("assert");
const http = require("http");
const fs = require("fs"), os = require("os"), path = require("path");

/* Two local stand-ins: one healthy, one that refuses like the public Solana
   endpoint does to datacenter traffic. */
const okSrv = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    /* ethers sends batches, and every reply must carry back its own id. */
    const answer = (r) => ({
      jsonrpc: "2.0", id: r.id,
      result: r.method === "eth_blockNumber" ? "0x1500000"
        : r.method === "eth_chainId" ? "0x1"
        : r.method === "getBlockHeight" ? 298000000 : 0,
    });
    const req_ = JSON.parse(b || "{}");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(req_) ? req_.map(answer) : answer(req_)));
  });
});
const denySrv = http.createServer((req, res) => {
  /* Echo the URL back in the error, exactly as a real gateway would — this
     is the leak the scrubber has to catch. */
  res.statusCode = 403;
  res.end(JSON.stringify({ error: { message: `forbidden for http://127.0.0.1:${DENY}/v2/SUPER_SECRET_KEY?apikey=SECRET2` } }));
});
let OK, DENY;
(async () => {
  await new Promise((r) => okSrv.listen(0, r)); OK = okSrv.address().port;
  await new Promise((r) => denySrv.listen(0, r)); DENY = denySrv.address().port;

  const SECRET = "SUPER_SECRET_KEY";
  process.env.ETH_RPC = `http://127.0.0.1:${OK}/v2/${SECRET}`;
  process.env.SOLANA_RPC = `http://127.0.0.1:${DENY}/v2/${SECRET}?apikey=SECRET2`;
  process.env.ETH_GAS_SPONSOR_KEY = "";

  const funding = require("../tools/funding");
  funding.configure({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "rail-")), demo: false, network: "mainnet" });

  const h = await funding.railHealth();
  const json = JSON.stringify(h, null, 1);
  console.log(json);

  /* 1. A working ETH_RPC is recognised as the operator's own. */
  assert.strictEqual(h.ethRpc.configured, 1);
  assert.strictEqual(h.ethRpc.endpoints[0].ok, true, "the healthy endpoint answered");
  assert.match(h.ethRpc.verdict, /your endpoint answered/);

  /* 2. A refusing SOLANA_RPC is called out, not hidden by the fallback. */
  assert.strictEqual(h.solanaRpc.endpoints[0].ok, false);
  assert.match(h.solanaRpc.verdict, /did NOT answer/);
  assert.match(h.solanaRpc.endpoints[0].hint || "", /refuses server traffic/);

  /* 3. THE POINT: nothing secret came out. Not the key, not a path, not a
     query string, not a scheme. */
  assert.ok(!json.includes(SECRET), "the API key must never appear");
  assert.ok(!json.includes("SECRET2"), "a key in the query string must never appear");
  assert.ok(!/https?:\/\//.test(json), "no URL may appear, only hosts");
  assert.ok(!json.includes("/v2/"), "no URL path may appear");
  assert.ok(json.includes(`127.0.0.1:${OK}`), "the host itself is reported, so it can be recognised");

  /* 4. No sponsor key means no float claim. */
  assert.strictEqual(h.gasSponsor.sponsored, false);

  /* --- with a sponsor key: the float is reported, the key never is --- */
  {
    const KEY = "0x" + "42".repeat(32);
    /* The key is read into config at require time, so set it through the
       same knob the server would rather than reloading the module. */
    funding.configure({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "rail2-")), demo: false, network: "mainnet", gasSponsorKey: KEY });
    const h2 = await funding.railHealth();
    const j2 = JSON.stringify(h2);
    assert.strictEqual(h2.gasSponsor.sponsored, true, "a set key is reported as sponsoring");
    assert.ok(!j2.includes(KEY.slice(2)) && !j2.includes(KEY), "the sponsor PRIVATE key must never appear");
    assert.ok(!j2.includes(SECRET), "nor the RPC key, on this path either");
    /* The address is public and the operator needs it to top the float up —
       and needs it MOST when the node is down, which is the case here. */
    const expected = new (require("ethers").Wallet)(KEY).address;
    assert.strictEqual(h2.gasSponsor.address, expected,
      "the address to fund survives a float reading that could not be taken");
    console.log("✓ the sponsor's address is reported even when the node is down");
    console.log("✓ its private key never is");
  }

  console.log("\n✓ probes each endpoint on its own");
  console.log("✓ a refusing endpoint is named, with the cure");
  console.log("✓ no key, URL, path or query escapes into the answer");
  okSrv.close(); denySrv.close();
  console.log("\nALL RAIL-HEALTH CHECKS PASSED");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
