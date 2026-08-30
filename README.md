# Koinos Bio Wallet — Veive smart accounts

**Your wallet is your fingerprint — on-chain.** One button, one biometric scan
(face, fingerprint, or device PIN; the OS decides), and a **real smart
account** exists on Koinos: an on-chain contract, built from the
[Veive protocol](https://github.com/veive-io)'s audited contracts, whose only
registered authority is your passkey. Every transaction is authorized by a
WebAuthn assertion that **the blockchain itself verifies** (P-256, on-chain) —
there is no private key to steal, phish, or back up, anywhere, ever.

Live at **https://buykoin.usekoinos.com**. This app is a deliberately separate
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

## Backups: more credentials, same account

The sign module keeps a **list** of credentials per account, and any
registered credential signs with full authority — so both backup paths are
the same mechanism, a `register` transaction authorized by a credential the
account already trusts:

- **Backup passkey** — two deliberate ceremonies: the NEW authenticator
  (another device, another ecosystem, a USB security key) creates its
  credential, then the CURRENT passkey confirms the registration. From then
  on losing the primary (a Google account, say) costs nothing — the backup
  opens the account.
- **Recovery kit** — a manual, offline fallback: the page generates a plain
  P-256 keypair with WebCrypto, the user downloads it as a small text file
  (account address + credential id + private key — the server never sees the
  key), and only after saving it is it registered on-chain. To sign, the kit
  builds a synthetic WebAuthn-shaped assertion — byte-for-byte what the
  deployed sign module verifies (`node tests/recovery-assertion.test.js`
  proves the whole pipeline, negatives included). Lose EVERY passkey and the
  kit still signs you in, re-keys the account with a fresh passkey, or moves
  the funds.

Registered credentials are capped per account (`MAX_CREDENTIALS_PER_ACCOUNT`,
default 6) and rate-limited. The one truly fatal state left is losing every
passkey **and** the kit at once. (The module also has `unregister` for
retiring lost credentials — not yet surfaced in the UI.)

## Fund with ETH · USDC · USDT

Every account can mint a personal **Ethereum deposit address**. Send it ETH,
USDC or USDT from any wallet or exchange, pick an amount, and one tap swaps it
into KOIN on the smart account — through the better of the two routes ported
from [Koinos Node Desktop](https://github.com/therexdev/Koinos-Node)'s
Fund-node pipeline (every calldata builder is proven **byte-identical** to
that battle-tested implementation: `node tests/eth-parity.test.js`):

| route | path | notes |
|---|---|---|
| B | ETH → Vortex (vETH) → KoinDX vETH/KOIN → KOIN | the original path; shallow pool |
| C | ETH → USDT → vKOIN (Uniswap v4) → Vortex 1:1 → KOIN | usually far more KOIN per ETH |

USDC and USDT deposits ride Route C's tail (USDC adds one hop through the
deepest stable pair on Ethereum). The server quotes both routes live, shows
the comparison, and executes the winner. Amounts are capped while the rail is
new (`FUND_MAX_ETH` 0.05, `FUND_MAX_STABLE` $150).

**How custody works here — stated plainly:** the deposit address is a
*transit* address whose key the server holds (like the bootstrap key). The
server drives the Ethereum legs, then tries to complete the Vortex bridge
redeem itself — the recipient is fixed inside the guardian-signed record, so
that transaction can only ever deliver to the user's own account, and the
bridge carries a relayer field precisely so a third party can pay for it.
Nobody, including us, can redirect it, so a tap there would buy no security.
If the deployed bridge disagrees and demands the recipient's own authority,
the job says so and the **passkey** finishes it instead — the chain decides,
not an assumption (`node tests/redeem-fallback.test.js` pins both). Route B's
final KoinDX swap always needs the passkey: it *spends* vETH from the account.
Funds are custodial only while in transit, and land on an account only the
passkey can spend from. Keep transit amounts modest.

Stablecoin-only deposits need a little ETH for Ethereum gas; set
`ETH_GAS_SPONSOR_KEY` (an Ethereum private key holding some ETH) and the app
fronts the gas automatically (`ETH_GAS_TOPUP` per job), mana-sharer style.

Jobs persist and resume across restarts; every swap carries an on-chain
min-out; a mid-flow failure leaves funds in a plain ERC-20 the flow retries
from. The rail runs live only on mainnet (`KOINOS_NETWORK=mainnet` with the
chain configured) — everywhere else the card simulates.

## Honest mana economics

| action | burns (≈) |
|---|---|
| shared infrastructure (once) | 160 mana |
| **each new account** | **85 mana** (the 97KB contract upload + module setup) |
| each passkey-verified transfer | 1–10 mana (on-chain P-256 costs more than a plain transfer) |
| registering a backup credential | 1–5 mana |

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
npm test             # wire format, recovery kit, ETH parity, passkey pre-flight
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
| `PASSKEY_RPID` | *(page hostname)* | WebAuthn relying-party id. Leave unset on buykoin.usekoinos.com — this playground's passkeys stay separate from other usekoinos apps by design |
| `DATA_DIR` | `./data` | account store location. Set `../bio-wallet-data` on Hostinger — a relative value resolves against the app folder, so that lands just OUTSIDE the checkout and survives redeploys |
| `TRUST_PROXY_HOPS` | `0` | proxy hops in front (Hostinger = 1) for real client IPs |
| `MAX_ACCOUNTS_PER_DAY` | `3` | account creations per IP per day |
| `MAX_ACCOUNTS_PER_DAY_GLOBAL` | `20` | account creations per day, total |
| `MAX_CREDENTIALS_PER_ACCOUNT` | `6` | passkeys + recovery kits per account |
| `MIN_CREATE_MANA` | `120` | refuse signups when sponsor mana is below this |
| `MAX_TRANSFERS_PER_DAY` | `30` | per-address daily transfer budget (per-IP is 2×) |
| `MIN_SPONSOR_MANA` | `5` | refuse transfers when sponsor mana is below this |
| `ETH_RPC` | *(public list)* | Ethereum RPC endpoint(s), comma-separated by priority |
| `ETH_GAS_SPONSOR_KEY` | — | Ethereum key that fronts gas for stablecoin-only deposits (optional) |
| `ETH_GAS_TOPUP` | `0.0015` | ETH fronted per job when gas is short |
| `FUND_MAX_ETH` | `0.05` | per-swap ETH cap on the funding rail |
| `FUND_MAX_STABLE` | `150` | per-swap USDC/USDT cap (USD) |
| `FUND_SLIPPAGE_BPS` | `150` | slippage floor for every funding swap (1.5%) |
| `DEMO_MODE` | — | `1` forces demo mode |

Missing sponsor **or** module addresses ⇒ the app boots in demo mode and says
why on `/api/config`.

### Deploy at buykoin.usekoinos.com (Hostinger)

1. DNS: add `buykoin` as a record on `usekoinos.com` pointing at the hosting.
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
- **Recovery**: passkeys sync via iCloud Keychain / Google Password Manager,
  and the account survives any single loss once a backup passkey or the
  recovery kit is registered (see *Backups* above). Nudge users to add one —
  a single credential is a single point of failure.
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
