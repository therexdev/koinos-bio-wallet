# Koinos Bio Wallet

**Your wallet is your fingerprint.** One button — *Create Account or Sign In* —
one biometric scan (face, fingerprint, or device PIN; the OS decides), and a
real Koinos account exists. The same scan opens it again, on every device the
passkey syncs to. No password, no seed phrase, no fees, and **no server ever
sees a key**.

Live at **https://wallet.usekoinos.com**.

## How the wallet works

```
tap the button
   └─ WebAuthn ceremony (the OS biometric sheet)
        └─ the passkey's PRF extension emits a deterministic 32-byte secret
             └─ SHA-256 + curve-order check → secp256k1 private key
                  └─ Koinos address  (holding a key IS the account — nothing on-chain needed)
```

- **Deterministic**: same passkey + same salt → same key, forever. Creation and
  sign-in are literally the same gesture.
- **Synced**: passkeys ride iCloud Keychain / Google Password Manager, so the
  wallet appears on the user's other devices with a scan.
- **Non-custodial**: the key is derived in the page and cached in the browser's
  localStorage between visits; the passkey re-derives it at any time. Export
  (WIF) is on the wallet screen.

### Two protocol constants (never change them)

| constant | value | why |
|---|---|---|
| derivation salt | `discover-koinos:wallet:v1` | shared across the usekoinos ecosystem — changing it changes every wallet's address |
| `PASSKEY_RPID` | `usekoinos.com` (the APEX domain) | passkeys bound to the apex work on **every** `*.usekoinos.com` app — one passkey, one wallet, everywhere |

Because both are shared with [Discover Koinos](https://usekoinos.com), a
passkey created there opens the same wallet here, and vice versa.

## The mana sharer

This app runs its **own** sponsor wallet (separate from any other app's).
Every transfer a visitor sends is built as `payer = sponsor, payee = visitor`:
the sponsor's regenerating mana covers the cost, the visitor's balance is
never touched by fees, and the visitor's own signature still authorizes every
operation. The server verifies the signed transaction is byte-identical to the
one it prepared before co-signing — a tampered transaction simply doesn't match.

**No new contracts are needed for v1.** Passkey wallets are plain key accounts;
the Veive phase (below) is where on-chain contracts enter.

## Run it

```bash
npm install
npm start            # http://localhost:3000 — DEMO mode until configured
```

### Go live

```bash
# 1. Make (or adopt) the sponsor key — writes wallet.env, chmod 600
node tools/keygen.js                     # fresh key
SPONSOR_WIF=<wif> node tools/keygen.js   # or keep an existing wallet

# 2. Fund the printed SPONSOR address with 20–50 KOIN (mainnet).
#    Transfers burn ~0.3–1 mana each; mana recharges ~20%/day.

# 3. Serve it
KOINOS_NETWORK=mainnet SPONSOR_WIF=... PASSKEY_RPID=usekoinos.com node server.js
```

### Environment variables

| var | default | meaning |
|---|---|---|
| `PORT` | `3000` | listen port |
| `KOINOS_NETWORK` | `harbinger` | `harbinger` or `mainnet` |
| `KOINOS_RPC` | *(probe list)* | own RPC endpoint(s), comma-separated by priority |
| `SPONSOR_WIF` | — | **the mana sharer.** The app's only secret |
| `PASSKEY_RPID` | *(page hostname)* | WebAuthn relying-party id — set the APEX domain (`usekoinos.com`) in production |
| `TRUST_PROXY_HOPS` | `0` | proxy hops in front (Hostinger = 1) for real client IPs |
| `MAX_TRANSFERS_PER_DAY` | `30` | per-address daily transfer budget (per-IP is 2×) |
| `MIN_SPONSOR_MANA` | `5` | refuse transfers when the sponsor is below this mana |
| `DEMO_MODE` | — | `1` forces demo mode |

Without `SPONSOR_WIF` (or with the chain unreachable) the app boots in **demo
mode**: the passkey flow is fully real, transfers simulate.

### Deploy at wallet.usekoinos.com (Hostinger)

1. DNS: add `wallet` as a record on `usekoinos.com` pointing at the hosting.
2. Create a Node.js app from this repo (start command `node server.js`).
3. Set the env vars above — `PASSKEY_RPID=usekoinos.com`, `TRUST_PROXY_HOPS=1`,
   `KOINOS_NETWORK=mainnet`, `SPONSOR_WIF` from `wallet.env`.
4. Visit `/api/config` — expect `"network":"mainnet"`, `"demo":false`,
   `"rpId":"usekoinos.com"`.

WebAuthn requires HTTPS (any real domain qualifies; `localhost` works for dev).

## Security model

- The visitor's key: born in the authenticator, derived in the page, never
  transmitted. localStorage holds it between visits purely as a convenience —
  wiping it costs nothing, the passkey re-derives it.
- The server holds one secret (`SPONSOR_WIF`), keeps no user records, and
  co-signs only transactions it built itself (id + recomputed header +
  recovered visitor signature all verified).
- Send-path hardening (learned on mainnet): node-side "request timeout"
  replies are treated as ambiguous and the mined-poll decides; RPC failover
  across multiple endpoints; error bodies unwrapped to human text.
- Per-address and per-IP daily budgets plus a sponsor mana floor keep one hot
  day from draining the sharer.

## Roadmap: Veive

The plan is to grow this into a [Veive](https://docs.veive.io) smart-account
wallet — on-chain recovery, session policies, key rotation, module-based
signature validation (their `mod-sign-webauthn-as` verifies WebAuthn
assertions on-chain). The current PRF wallet is forward-compatible: a Veive
account can be added alongside and assets moved with one sponsored transfer.
Until Veive's account contract + factory + docs mature, per-user smart-account
deployment costs and integration surface don't fit a free wallet.
