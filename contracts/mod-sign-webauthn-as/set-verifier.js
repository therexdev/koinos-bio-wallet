/**
 * Bakes the P-256 verifier contract address into src/assembly/Constants.ts
 * before the AssemblyScript build. The upstream module hard-codes Veive's
 * mainnet verifier (1DiZuvY2TMXoBYEJCZ7sEjymSyDq8ubp7g); we deploy our own
 * verifier, so the module must be rebuilt with that address.
 *
 *   VERIFIER_ADDR=1YourVerifierAddress node set-verifier.js
 *   VERIFIER_ADDR=upstream            node set-verifier.js   # original Veive address
 *
 * `npm run build` runs this automatically.
 */
const fs = require("fs");
const path = require("path");

const UPSTREAM = "1DiZuvY2TMXoBYEJCZ7sEjymSyDq8ubp7g";
const B58 = /^[1-9A-HJ-NP-Za-km-z]{33,35}$/;

let addr = (process.env.VERIFIER_ADDR || "").trim();
if (addr.toLowerCase() === "upstream") addr = UPSTREAM;
if (!addr) {
  console.error(
    "VERIFIER_ADDR is required — the address your verifier-p256 contract is (or will be) deployed at.\n" +
    "It comes from tools/infra-keygen.js in the repo root (wallet-infra.env).\n" +
    "Use VERIFIER_ADDR=upstream to build with Veive's original mainnet verifier address."
  );
  process.exit(1);
}
if (!B58.test(addr)) {
  console.error(`VERIFIER_ADDR does not look like a base58 Koinos address: ${addr}`);
  process.exit(1);
}

const file = path.join(__dirname, "src", "assembly", "Constants.ts");
const content = `export const VERIFIER_CONTRACT_ID = "${addr}";`;
const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
if (current === content) {
  console.log(`Constants.ts already set to verifier ${addr}`);
} else {
  fs.writeFileSync(file, content);
  console.log(`Constants.ts → verifier ${addr}${addr === UPSTREAM ? " (upstream)" : ""}`);
}
