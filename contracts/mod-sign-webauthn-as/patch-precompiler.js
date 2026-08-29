/**
 * koinos-precompiler-as shells out to `yarn protoc`, which breaks on any
 * machine without a global yarn (stock Windows). Inside an npm build,
 * node_modules/.bin is already on PATH, so plain `protoc` resolves the
 * locally installed binary — yarn is pure indirection here.
 *
 * This rewrites that one invocation in the installed package. Idempotent;
 * runs automatically as part of `npm run build`.
 */
const fs = require("fs");
const path = require("path");

const target = path.join(__dirname, "node_modules", "koinos-precompiler-as", "lib", "generateProto.js");
if (!fs.existsSync(target)) {
  console.error("koinos-precompiler-as is not installed — run `npm install` in this folder first");
  process.exit(1);
}
const src = fs.readFileSync(target, "utf8");
if (src.includes("yarn protoc")) {
  fs.writeFileSync(target, src.split("yarn protoc").join("protoc"));
  console.log("patched koinos-precompiler-as: `yarn protoc` → `protoc` (no yarn needed)");
} else if (src.includes("protoc")) {
  console.log("koinos-precompiler-as already patched (no yarn needed)");
} else {
  console.error("koinos-precompiler-as looks unfamiliar — could not find its protoc call");
  process.exit(1);
}
