#!/usr/bin/env node
/* Generate (or adopt) the Bio Wallet's SPONSOR keypair into an env file
   (default wallet.env, chmod 600). Prints the ADDRESS only — the private
   key goes straight to the file.

   The sponsor is this app's own mana sharer: its mana pays for every
   visitor transfer (payer = sponsor, payee = visitor). It is the ONLY
   secret the app holds, and the only wallet that needs funding.

   BRING YOUR OWN key: set SPONSOR_WIF in the environment to keep an
   existing wallet as the sponsor —
     SPONSOR_WIF=<your WIF> node tools/keygen.js
   Otherwise a fresh key is generated.

   Usage: [SPONSOR_WIF=<wif>] node tools/keygen.js [outfile]
*/
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { Signer } = require('koilib');

const out = process.argv[2] || 'wallet.env';

function fromWifOrDie(wif) {
  try { return Signer.fromWif(String(wif).trim()); }
  catch (_) {
    console.error('SPONSOR_WIF is not a valid Koinos private key (WIF).');
    console.error('It should start with 5, K or L. A 64-char hex key converts with:');
    console.error(`  node -e "const {Signer}=require('koilib');console.log(new Signer({privateKey:'<hex>'}).getPrivateKey('wif',true))"`);
    process.exit(1);
  }
}

const byo = !!process.env.SPONSOR_WIF;
const sponsor = byo ? fromWifOrDie(process.env.SPONSOR_WIF)
  : new Signer({ privateKey: crypto.randomBytes(32).toString('hex') });

const text = `# Koinos Bio Wallet sponsor key — generated ${new Date().toISOString()}\n` +
  `# KEEP THIS FILE SECRET. This wallet's mana pays for every visitor transfer.\n` +
  `SPONSOR_WIF=${sponsor.getPrivateKey('wif', true)}\n` +
  `# SPONSOR_ADDR=${sponsor.getAddress()}\n`;

try {
  fs.writeFileSync(out, text, { mode: 0o600, flag: 'wx' });
} catch (e) {
  if (e.code === 'EEXIST') {
    console.error(`${out} already exists — refusing to overwrite it (it may hold a live key).`);
    process.exit(1);
  }
  throw e;
}

console.log(`wrote ${out} (mode 600)\n`);
console.log(`SPONSOR  ${sponsor.getAddress()}${byo ? '  (your wallet)' : '  (generated — fund this one)'}`);
console.log(`\nNext:
  1. Send it 20–50 KOIN (mainnet). Transfers burn ~0.3–1 mana each and mana
     recharges ~20%/day, so 50 KOIN sustains hundreds of sends per day.
  2. Set the server env (see README) and start / redeploy:
       KOINOS_NETWORK=mainnet SPONSOR_WIF=<from ${out}> PASSKEY_RPID=usekoinos.com`);
