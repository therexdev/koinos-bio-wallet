# Koinos Bio Wallet — Veive smart accounts

**Your wallet is your fingerprint — on-chain.** One button, one biometric scan
(face, fingerprint, or device PIN; the OS decides), and a **real smart
account** exists on Koinos: an on-chain contract, built from the
[Veive protocol](https://github.com/veive-io)'s audited contracts, whose only
registered authority is your passkey. Every transaction is authorized by a
WebAuthn assertion that **the blockchain itself verifies** (P-256, on-chain) —
there is no private key to steal, phish, or back up, anywhere, ever.

Live at **https://wallet.usekoinos.com**. This app is a deliberately separate
playground for the smart-account concept — its own sponsor, its own passkeys,
its own contracts — so it can grow without touching the other usekoinos apps.

## How an account is born

```
tap the button
   └─ WebAuthn create ceremony → a passkey with a P-256 keypair in secure hardware
        └─ the server bootstraps, mana-sponsored (two atomic transactions):
             tx1  upload Veive's Account contract to a fresh address,
                  all three authorize overrides on
             tx2  install mod-sign-webauthn (type 3)
                  register YOUR passkey's public key as the account's credential
                  install mod-validation-signature (type 1) with scopes
                  contract_call + contract_upload + transaction_application
                       └─ from this instant, only your passkey moves the account
```

The bootstrap is driven by a throwaway secp256k1 key that names the address;
once the validator module is live that key is powerless (the account routes
every authority check into passkey-signature validation). The server keeps it
only to heal interrupted bootstraps.

## How a send works

```
server prepares the exact transaction   (payer = sponsor, payee = you)
   └─ your passkey signs — the WebAuthn challenge IS the transaction id
        └─ the browser packs the assertion into the Veive signature format
             (0xFF02 ‖ protobuf authentication_data, see contracts/README.md)
             └─ the sponsor co-signs as mana payer and broadcasts
                  └─ ON-CHAIN: account → validator → sign module → P-256
                     verifier check the assertion against your registered
                     credential and the transaction id. The server never
                     could have forged it.
```

The signature packing is proven **byte-identical** to the reference vector
from Veive's own module test suite (`node tests/wire-format.test.js`), and our
packer fixes an upstream client bug: every DER signature is normalized so the
on-chain ASN.1 reader parses it correctly (~1 in 128 raw assertions would
otherwise fail).

## The contracts

See [contracts/README.md](contracts/README.md) for the full story. Short
version: three shared contracts are deployed once (Veive's P-256 verifier and
validation module as published; the WebAuthn sign module rebuilt from source
solely to point at our verifier — the rebuild is byte-identical to their npm
binary when built with their address), plus one 97KB Account contract per
user, uploaded at signup.

## Honest mana economics

| action | burns (≈) |
|---|---|
| shared infrastructure (once) | 160 mana |
| **each new account** | **85 mana** (the 97KB contract upload + module setup) |
| each passkey-verified transfer | 1–10 mana (on-chain P-256 costs more than a plain transfer) |

Mana regenerates ~20%/day of KOIN held. A sponsor holding **200 KOIN** can
mint 2 accounts immediately and roughly one more every two days sustained —
fine for a playground; scale the sponsor with adoption. Guardrails:
`MAX_ACCOUNTS_PER_DAY` per IP (default 3), `MAX_ACCOUNTS_PER_DAY_GLOBAL`
(default 20), `MIN_CREATE_MANA` floor (default 120), per-address/IP transfer
budgets, and a sponsor mana floor for sends.

## Run it

```bash
npm install
npm start            # http://localhost:3000 — DEMO mode until configured
npm test             # wire-format proof against Veive's reference vector
```

Demo mode is fully interactive: the passkey ceremonies and signature packing
are real (the server verifies every packed signature exactly like the live
path); only the chain is simulated.

### Go live (once)

```bash
# 1. Sponsor (mana sharer) — writes wallet.env, chmod 600
node tools/keygen.js                     # or SPONSOR_WIF=<wif> node tools/keygen.js
#    …fund the printed address: 150–200 KOIN recommended (see economics above)

# 2. Infrastructure keys — writes wallet-infra.env, chmod 600
node tools/infra-keygen.js

# 3. Build the sign module + deploy the three shared contracts (~160 mana)
cd contracts/mod-sign-webauthn-as && npm install && cd ../..
KOINOS_NETWORK=mainnet node tools/infra-deploy.js
#    …verifies itself: reads module manifests back and has the DEPLOYED
#    verifier verify a real WebAuthn assertion before declaring success.
#    Prints the three *_ADDR values for the server environment.
```

### Serve

```bash
KOINOS_NETWORK=mainnet \
SPONSOR_WIF=…            # from wallet.env
VERIFIER_ADDR=…          # the three addresses infra-deploy printed
MOD_SIGN_WEBAUTHN_ADDR=… \
MOD_VALIDATION_SIGNATURE_ADDR=… \
node server.js
```

### Environment variables

| var | default | meaning |
|---|---|---|
| `PORT` | `3000` | listen port |
| `KOINOS_NETWORK` | `harbinger` | `harbinger` or `mainnet` |
| `KOINOS_RPC` | *(probe list)* | own RPC endpoint(s), comma-separated by priority |
| `SPONSOR_WIF` | — | the mana sharer — pays for bootstraps and transfers |
| `VERIFIER_ADDR` | — | deployed P-256 verifier (infra-deploy) |
| `MOD_SIGN_WEBAUTHN_ADDR` | — | deployed WebAuthn sign module (infra-deploy) |
| `MOD_VALIDATION_SIGNATURE_ADDR` | — | deployed signature validator (infra-deploy) |
| `PASSKEY_RPID` | *(page hostname)* | WebAuthn relying-party id. Leave unset on wallet.usekoinos.com — this playground's passkeys stay separate from other usekoinos apps by design |
| `DATA_DIR` | `./data` | account store location. Set `../bio-wallet-data` on Hostinger — a relative value resolves against the app folder, so that lands just OUTSIDE the checkout and survives redeploys |
| `TRUST_PROXY_HOPS` | `0` | proxy hops in front (Hostinger = 1) for real client IPs |
| `MAX_ACCOUNTS_PER_DAY` | `3` | account creations per IP per day |
| `MAX_ACCOUNTS_PER_DAY_GLOBAL` | `20` | account creations per day, total |
| `MIN_CREATE_MANA` | `120` | refuse signups when sponsor mana is below this |
| `MAX_TRANSFERS_PER_DAY` | `30` | per-address daily transfer budget (per-IP is 2×) |
| `MIN_SPONSOR_MANA` | `5` | refuse transfers when sponsor mana is below this |
| `DEMO_MODE` | — | `1` forces demo mode |

Missing sponsor **or** module addresses ⇒ the app boots in demo mode and says
why on `/api/config`.

### Deploy at wallet.usekoinos.com (Hostinger)

1. DNS: add `wallet` as a record on `usekoinos.com` pointing at the hosting.
2. Create a Node.js app from this repo (start command `node server.js`).
3. Run the go-live steps above **on your own machine** (the secrets never
   need to touch the host), then set the env vars — including
   `DATA_DIR=../bio-wallet-data` (survives redeploys; created automatically)
   and `TRUST_PROXY_HOPS=1`.
4. Visit `/api/config` — expect `"demo":false` and the three module
   addresses under `"modules"`.

WebAuthn requires HTTPS (any real domain qualifies; `localhost` works for dev).

## Security model

- **Your authority**: a P-256 keypair inside your device's secure hardware,
  registered on-chain as the account's credential. Assertions are verified by
  the chain; the server's checks are merely a courtesy pre-flight.
- **The server holds**: the sponsor key, and each account's bootstrap key
  (`data/accounts.json`, mode 600) — powerless after bootstrap, kept to heal
  interrupted signups. It cannot move an active account: with the validator
  installed, the chain accepts only passkey-signed transactions.
- **Recovery**: your passkey syncs via iCloud Keychain / Google Password
  Manager; any synced device opens the account. A lost passkey is currently a
  lost account (module-based recovery is the natural next Veive step) — say
  so honestly to users before real value goes in.
- **Send-path hardening** (learned on mainnet): ambiguous node replies are
  arbitrated by a mined-poll; RPC failover; error bodies unwrapped; and the
  sponsor's signature is ordered BEFORE the WebAuthn blob — the chain's payer
  check walks signatures in order and must match the sponsor before touching
  the non-secp entry.

## What happened to v1 (PRF wallets)?

v1 derived a secp256k1 key from the passkey's PRF extension. This rework
replaces it with the real thing — accounts as contracts, per the Veive
concept. If you made a v1 wallet: the same passkey still opens that same
PRF wallet on [usekoinos.com](https://usekoinos.com) (shared salt + apex
rpId), or import the WIF you exported. This app's passkeys are now scoped to
its own hostname and its accounts live on-chain.
