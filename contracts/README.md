# The smart-account contracts

Every wallet account this app creates is a real on-chain smart account built
from [Veive](https://github.com/veive-io)'s protocol contracts (MIT, published
on npm as `@veive-io/*` v2.0.0 / verifier v1.0.0). Nothing here is written by
us except the build parameterization — we deploy Veive's audited artifacts.

## What gets deployed where

| contract | deployed | source | how we use it |
|---|---|---|---|
| `Account.wasm` (97KB) | **once per user account** | `@veive-io/account-as` binary, vendored as-is | uploaded with all three authorize overrides — the account routes every authority check through its installed modules |
| `verifier.wasm` (80KB) | once, shared | `@veive-io/verifier-p256` binary, vendored as-is | raw P-256 signature verification (WebAuthn's curve, which Koinos can't verify natively) |
| `ModSignWebauthn.wasm` (75KB) | once, shared | **rebuilt** from [source](https://github.com/veive-io/mod-sign-webauthn-as) | verifies passkey assertions on-chain; holds the credential registry (sign module, type 3) |
| `ModValidationSignature.wasm` (48KB) | once, shared | `@veive-io/mod-validation-signature` binary, vendored as-is | routes every scope (contract_call, contract_upload, transaction_application) into signature validation, threshold 1 (validation module, type 1) |

`vendor/` also carries each contract's ABI and proto — the server serializes
with them at runtime, so the wire format can never drift from the contracts.

## Why mod-sign-webauthn is rebuilt — and the proof it's faithful

The module hard-codes the address of the P-256 verifier it calls
(`src/assembly/Constants.ts`). Veive's published binary points at *their*
mainnet verifier (`1DiZuvY2TMXoBYEJCZ7sEjymSyDq8ubp7g`); ours must point at
the verifier *we* deploy. That address is the **only** thing we change.

Provenance proof, reproducible here: building `mod-sign-webauthn-as/` with
`VERIFIER_ADDR=upstream` produces a wasm **byte-identical** (same sha256) to
the binary Veive published on npm — vendored for comparison as
`vendor/mod-sign-webauthn/ModSignWebauthn.upstream.wasm`:

```bash
cd mod-sign-webauthn-as && npm install
VERIFIER_ADDR=upstream npm run build
sha256sum build/release/ModSignWebauthn.wasm ../vendor/mod-sign-webauthn/ModSignWebauthn.upstream.wasm
# 65ca0c572dc53848a739bb66bdc5bbde8ccf22994f1761c62299c96c56c1a444  (both)
```

So a build with our own address differs from the audited upstream binary in
exactly one embedded string. `tools/infra-deploy.js` runs this build, checks
the address is embedded, deploys all three shared contracts, and then makes
the deployed verifier verify a real WebAuthn assertion (the reference vector
from Veive's own test suite) before declaring success.

Local changes to the vendored source, kept deliberately minimal:

- `set-verifier.js` (new) — writes `Constants.ts` from `$VERIFIER_ADDR`.
- `package.json` — `build` script made npm-agnostic and prefixed with
  `set-verifier.js`; `@veive-io/mod-sign-as` added to dependencies (used by
  the code, missing from the upstream manifest).

Upstream's `origin`/`crossOrigin` checks in `is_valid_signature` are commented
out in their source (`TODO attivare in produzione`) and therefore in our build
too: the transaction id in the signed challenge is what binds an assertion to
a transaction; origin pinning would additionally bind it to one web origin.

## The signature wire format

A passkey-signed transaction carries, in `transaction.signatures`:

```
base64url( 0xFF 0x02 ‖ protobuf modsignwebauthn.authentication_data {
  credential_id      = 1   base64url string of the raw credential id
  signature          = 2   the assertion's ECDSA DER (normalized, see below)
  authenticator_data = 3   verbatim from the authenticator
  client_data        = 4   verbatim clientDataJSON
})
```

with the WebAuthn challenge equal to the ASCII bytes of the transaction's
`0x…` id. `public/js/webauthn-wire.js` packs this; `tests/wire-format.test.js`
proves the packing **byte-identical** to the real-device vector in Veive's
module test suite.

One divergence from Veive's own client, on purpose: the module's on-chain
ASN.1 reader assumes r and s occupy exactly 32 bytes, so ~1 in 128 raw
assertions (naturally short r or s) would fail verification. Our packer
re-encodes every DER with both integers padded to the one shape the reader
always parses correctly — value unchanged, failure mode gone.
