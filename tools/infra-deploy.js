#!/usr/bin/env node
/* ============================================================
   One-command deployment of the Veive smart-account infrastructure:

     1. builds mod-sign-webauthn from source with OUR verifier address
        baked in (contracts/mod-sign-webauthn-as — needs `npm install`
        run once in that folder),
     2. uploads the three shared contracts, sponsor-paid:
          · verifier-p256            (Veive's binary, as published)
          · mod-sign-webauthn        (our rebuild)
          · mod-validation-signature (Veive's binary, as published)
     3. proves the deployment: reads both modules' manifests back and
        runs a REAL P-256 verification against the deployed verifier
        using the reference vector from Veive's test suite.

   Idempotent: contracts already on-chain are skipped (re-upload with
   --force). Needs wallet.env (funded sponsor) and wallet-infra.env
   (tools/infra-keygen.js). One-time cost ≈ 160 mana.

   Usage:
     KOINOS_NETWORK=mainnet node tools/infra-deploy.js [--force] [--dry-run]
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Contract, Serializer, utils } = require('koilib');
const chain = require('./chain');
const { pickRpcs } = require('./rpc');

const ROOT = path.join(__dirname, '..');
const MOD_SRC = path.join(ROOT, 'contracts', 'mod-sign-webauthn-as');
const FORCE = process.argv.includes('--force');
const DRY = process.argv.includes('--dry-run');

function readEnvFile(name) {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, name), 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
  } catch (_) {}
  return out;
}

function die(msg) { console.error('\n✗ ' + msg); process.exit(1); }

(async () => {
  const network = process.env.KOINOS_NETWORK || 'harbinger';
  const walletEnv = readEnvFile('wallet.env');
  const infra = readEnvFile('wallet-infra.env');
  const sponsorWif = process.env.SPONSOR_WIF || walletEnv.SPONSOR_WIF;
  if (!sponsorWif) die('no sponsor key — run `node tools/keygen.js` and fund the address first');
  for (const k of ['VERIFIER_WIF', 'VERIFIER_ADDR', 'MOD_SIGN_WEBAUTHN_WIF', 'MOD_VALIDATION_SIGNATURE_WIF']) {
    if (!infra[k]) die('wallet-infra.env is missing ' + k + ' — run `node tools/infra-keygen.js`');
  }

  /* ---- 1. build the sign module with our verifier address ---- */
  const wasmOut = path.join(MOD_SRC, 'build', 'release', 'ModSignWebauthn.wasm');
  if (!fs.existsSync(path.join(MOD_SRC, 'node_modules'))) {
    die('contracts/mod-sign-webauthn-as has no node_modules — run `npm install` in that folder once');
  }
  console.log(`building mod-sign-webauthn with verifier ${infra.VERIFIER_ADDR} …`);
  execSync('npm run build', { cwd: MOD_SRC, stdio: 'pipe', env: { ...process.env, VERIFIER_ADDR: infra.VERIFIER_ADDR } });
  const modSignWasm = fs.readFileSync(wasmOut);
  const addrUtf16 = Buffer.from(infra.VERIFIER_ADDR, 'utf16le');
  if (!modSignWasm.includes(addrUtf16)) die('built wasm does not embed our verifier address — build is broken');
  console.log(`  built ${modSignWasm.length} bytes, verifier address embedded ✓`);

  const artifacts = [
    { label: 'verifier-p256', wif: infra.VERIFIER_WIF,
      wasm: fs.readFileSync(path.join(chain.VENDOR, 'verifier-p256', 'verifier.wasm')) },
    { label: 'mod-sign-webauthn', wif: infra.MOD_SIGN_WEBAUTHN_WIF, wasm: modSignWasm },
    { label: 'mod-validation-signature', wif: infra.MOD_VALIDATION_SIGNATURE_WIF,
      wasm: fs.readFileSync(path.join(chain.VENDOR, 'mod-validation-signature', 'ModValidationSignature.wasm')) },
  ];

  /* ---- 2. chain setup + preflight ---- */
  const rpcs = await pickRpcs(network);
  chain.configure({ network, rpcs, sponsorWif });
  const sponsorAddr = chain.sponsorAddress();
  const sponsorMana = await chain.mana(sponsorAddr);
  const totalBytes = artifacts.reduce((n, a) => n + a.wasm.length, 0);
  const estMana = Math.ceil(totalBytes * 0.00077) + 10;
  console.log(`\nnetwork: ${network}\nsponsor: ${sponsorAddr} (${Math.floor(sponsorMana)} mana free)`);
  console.log(`uploading ${artifacts.length} contracts, ${totalBytes} bytes ≈ ${estMana} mana`);
  if (sponsorMana < estMana && !FORCE) {
    die(`sponsor has ${Math.floor(sponsorMana)} mana but ~${estMana} is needed — fund it or wait for regeneration (--force to try anyway)`);
  }
  if (DRY) { console.log('\n--dry-run: stopping before any upload.'); return; }

  /* ---- 3. upload (skip what already exists) ---- */
  const MODSIGN_ABI = JSON.parse(fs.readFileSync(path.join(chain.VENDOR, 'mod-sign-webauthn', 'modsignwebauthn-abi.json')));
  async function manifestOf(addr, abi) {
    try {
      const c = new Contract({ id: addr, abi, provider: chain.provider() });
      const { result } = await c.functions.manifest({});
      return result || null;
    } catch (_) { return null; }
  }

  for (const a of artifacts) {
    const key = chain.keyFromWif(a.wif);
    a.address = key.getAddress();
    const existing = await chain.accountModules(a.address); // any-contract probe: null = nothing there
    if (existing !== null && !FORCE) {
      console.log(`\n${a.label} @ ${a.address} — already on-chain, skipping (--force re-uploads)`);
      continue;
    }
    console.log(`\nuploading ${a.label} (${a.wasm.length} bytes) → ${a.address} …`);
    try {
      const txId = await chain.sendAsAccount(key, [await chain.opUploadContract(a.address, a.wasm)], { rcLimit: chain.K.rcLimitUpload });
      console.log(`  mined ✓  ${txId}`);
    } catch (e) {
      if (e.broadcast) {
        console.log(`  broadcast ambiguous (${e.txId}) — re-checking …`);
        if (await chain.accountModules(a.address) === null) die(`${a.label} did not land — re-run this script`);
        console.log('  it landed ✓');
      } else die(`${a.label} upload failed: ${chain.humanChainError(e)}`);
    }
  }

  /* ---- 4. prove it ---- */
  console.log('\nverifying deployment …');
  const mvAbi = JSON.parse(fs.readFileSync(path.join(chain.VENDOR, 'mod-validation-signature', 'modvalidationsignature-abi.json')));
  const m1 = await manifestOf(artifacts[1].address, MODSIGN_ABI);
  const m2 = await manifestOf(artifacts[2].address, mvAbi);
  if (m1) console.log(`  mod-sign-webauthn manifest: ${m1.name} v${m1.version} (type ${m1.type_id}) ✓`);
  else console.log('  ! mod-sign-webauthn manifest unreadable — investigate before going live');
  if (m2) console.log(`  mod-validation-signature manifest: ${m2.name} v${m2.version} (type ${m2.type_id}) ✓`);
  else console.log('  ! mod-validation-signature manifest unreadable — investigate before going live');

  /* Real P-256 check against the deployed verifier, using the reference
     assertion from Veive's module test suite. */
  try {
    const vAbi = JSON.parse(fs.readFileSync(path.join(chain.VENDOR, 'verifier-p256', 'verifier.koilib.abi')));
    vAbi.methods.verify.read_only = true; vAbi.methods.verify['read-only'] = true; // pure math — callable in read context
    const REF = {
      SIGNATURE: 'CitmRHlfMGF1Z3RHV21FeUlkMXBLQ05maUpnaDdQSHBNOW1hM1FpRWpSbFk0EkYwRAIgc6P7ynTGRZrC-zUnLol6gmwF7tKkwTQR5BUG7iYs2HICICDa1yU_Bstlk50hL10ETjk7xEWEoS_YBz9txsZfKTmRGiVJlg3liA6MaHQ0Fw9kdmBbj-SuuaKGMseZXPO6gx2XYwUAAAACIrkBeyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiTUhneE1qSXdZakZsTmpsaVpUQTFZelZsWkRGbU5HWm1aalk0WldZMFl6TXhOamd4TkRKbE5XTTVaV0prTVRnMU5tWmxNamRpWVdGaU4yTmtObUZpTlRZd09XSTBZZyIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6MzAwMCIsImNyb3NzT3JpZ2luIjpmYWxzZX0=',
      PUBLIC_KEY: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEkOe-rg0JSTZXpREXYNFPSzI3i1uj1NP2041_oYHd9FKwPOowTrf6nP1vD8qkQv5G0CHVoKkTR6ua6FFPuHLLtQ==',
    };
    const ad = await new Serializer(MODSIGN_ABI.koilib_types).deserialize(utils.decodeBase64url(REF.SIGNATURE), 'authentication_data');
    const der = Buffer.from(utils.decodeBase64url(ad.signature));
    const rStart = der[4] === 0 ? 5 : 4, rEnd = rStart + 32;
    const sStart = der[rEnd + 2] === 0 ? rEnd + 3 : rEnd + 2;
    const rs = Buffer.concat([der.subarray(rStart, rEnd), der.subarray(sStart)]);
    const spki = Buffer.from(utils.decodeBase64url(REF.PUBLIC_KEY));
    const pub = Buffer.concat([Buffer.from([4]), spki.subarray(spki.length - 64)]);
    const authData = Buffer.from(utils.decodeBase64url(ad.authenticator_data));
    const clientData = Buffer.from(utils.decodeBase64url(ad.client_data));
    const msg = Buffer.concat([authData, require('crypto').createHash('sha256').update(clientData).digest()]);
    const vc = new Contract({ id: artifacts[0].address, abi: vAbi, provider: chain.provider() });
    const { result } = await vc.functions.verify({
      signature: utils.encodeBase64url(rs),
      publicKey: utils.encodeBase64url(pub),
      msg: utils.encodeBase64url(msg),
    });
    if (result && Number(result.value) === 1) console.log('  verifier-p256 verified the reference WebAuthn assertion on-chain ✓');
    else console.log('  ! verifier returned', JSON.stringify(result), '— expected {value:1}; investigate before going live');
  } catch (e) {
    console.log('  (verifier self-test could not run in read context: ' + chain.humanChainError(e).slice(0, 120) + ')');
  }

  console.log(`\nDONE. Add to the server environment:
  VERIFIER_ADDR=${artifacts[0].address}
  MOD_SIGN_WEBAUTHN_ADDR=${artifacts[1].address}
  MOD_VALIDATION_SIGNATURE_ADDR=${artifacts[2].address}`);
})().catch((e) => die(chain.humanChainError(e)));
