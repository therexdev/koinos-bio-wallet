#!/usr/bin/env node
/* Generate the three INFRASTRUCTURE keypairs of the Veive smart-account
   wallet into wallet-infra.env (chmod 600):

     VERIFIER        — where the P-256 verifier contract lives
     MOD_SIGN        — where mod-sign-webauthn lives
     MOD_VALIDATION  — where mod-validation-signature lives

   These are deployed ONCE (tools/infra-deploy.js) and shared by every
   account the wallet creates. Their keys keep upgrade authority over the
   module contracts, so the file must stay secret.

   Usage: node tools/infra-keygen.js [outfile]      (default wallet-infra.env)
*/
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { Signer } = require('koilib');

const out = process.argv[2] || 'wallet-infra.env';
const mk = () => new Signer({ privateKey: crypto.randomBytes(32).toString('hex') });

const verifier = mk(), modSign = mk(), modValidation = mk();

const text = `# Veive smart-account infrastructure keys — generated ${new Date().toISOString()}
# KEEP THIS FILE SECRET: these keys hold upgrade authority over the shared
# module contracts every wallet account trusts.
VERIFIER_WIF=${verifier.getPrivateKey('wif', true)}
VERIFIER_ADDR=${verifier.getAddress()}
MOD_SIGN_WEBAUTHN_WIF=${modSign.getPrivateKey('wif', true)}
MOD_SIGN_WEBAUTHN_ADDR=${modSign.getAddress()}
MOD_VALIDATION_SIGNATURE_WIF=${modValidation.getPrivateKey('wif', true)}
MOD_VALIDATION_SIGNATURE_ADDR=${modValidation.getAddress()}
`;

try {
  fs.writeFileSync(out, text, { mode: 0o600, flag: 'wx' });
} catch (e) {
  if (e.code === 'EEXIST') {
    console.error(`${out} already exists — refusing to overwrite it (it may hold live keys).`);
    console.error('Delete it yourself first if you truly want fresh infrastructure.');
    process.exit(1);
  }
  throw e;
}

console.log(`wrote ${out} (mode 600)\n`);
console.log(`VERIFIER                  ${verifier.getAddress()}`);
console.log(`MOD_SIGN_WEBAUTHN         ${modSign.getAddress()}`);
console.log(`MOD_VALIDATION_SIGNATURE  ${modValidation.getAddress()}`);
console.log(`\nNext: node tools/infra-deploy.js   (needs wallet.env's funded sponsor — ~160 mana one-time)`);
