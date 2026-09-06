# Google Play listing — everything needed, ready to paste

App: **Koinos Bio Wallet** · package `wallet.koinos.app`
Console: <https://play.google.com/console> → your app → the sections below.

Every asset here is generated from the app itself (`android/tools/gen-icons.js`
for the icon, `play/` for the rest) and is already the size Play requires.

---

## Assets in this folder

| File | Where it goes | Size |
|---|---|---|
| `app-icon-512.png` | Store listing → App icon | 512×512 |
| `feature-graphic-1024x500.png` | Store listing → Feature graphic | 1024×500 |
| `screenshots/1-welcome.png` … `4-security.png` | Store listing → Phone screenshots | 1080×1920 |

Play needs **at least 2** phone screenshots; four are provided.

---

## 1. Store presence → Main store listing

**App name** (30 max)
```
Koinos Bio Wallet
```

**Short description** (80 max)
```
A Koinos wallet you open with your fingerprint. No password, no seed phrase.
```

**Full description** (4000 max)
```
Koinos Bio Wallet is a smart-account wallet for the Koinos blockchain that you
open with your fingerprint or face. There is no password and no seed phrase to
write down or lose — your account is created on-chain and secured by a passkey
held in your device's secure hardware.

WHAT YOU CAN DO
• Create a Koinos smart account in one scan, secured by your biometrics.
• Hold and view KOIN, VHP and other Koinos tokens, and your NFTs.
• Send tokens and NFTs to any Koinos address, or to a Gmail address — the
  recipient claims it with their own passkey.
• Add a backup passkey from a second device, so losing a phone is not losing
  the account.
• Export a recovery credential that you keep yourself.
• Top up by converting ETH, USDC, USDT or SOL into KOIN.

NO NETWORK FEES
Koinos transactions cost no gas. Sending KOIN or an NFT from this wallet is
free — the network's mana is sponsored, so you never have to buy a token just
to be allowed to move one.

HOW IT IS SECURED
Your passkey never leaves your device and cannot be exported by the app. Every
transaction is signed on your phone by your own biometric, and the account's
authority lives in a smart contract on Koinos, not on our servers. We cannot
move your funds, freeze them, or recover them for you.

OPEN AND VERIFIABLE
Balances, transfers and account authority are all on the public Koinos
blockchain, so anything the app tells you can be checked independently.

Built on the Veive smart-account protocol.
```

**App icon** → `app-icon-512.png`
**Feature graphic** → `feature-graphic-1024x500.png`
**Phone screenshots** → all four in `screenshots/`

---

## 2. Store settings

| Field | Value |
|---|---|
| App category | **Finance** |
| Tags | Crypto wallet, Blockchain, Finance |
| Store listing contact — email | `support@usekoinos.com` |
| Store listing contact — website | `https://wallet.usekoinos.com` |
| External marketing | leave unchecked unless you run ads |

---

## 3. App content (left menu → "App content")

Each item below is a separate form. All of them must be green before the
release can go out.

### Privacy policy
```
https://wallet.usekoinos.com/privacy
```
Live now — that page ships with the site.

### App access
Choose **All functionality is available without special access**. The wallet
creates an account with a passkey on first launch; there is no login for a
reviewer to be given.

### Ads
**No, my app does not contain ads.** (There are none — no ad SDK is bundled.)

### Content ratings
Fill the questionnaire. For this app every answer is **No** — no violence, no
sexual content, no profanity, no drugs, no gambling. Category: **Utility,
Productivity, Communication or Other**. It will come out rated for everyone.

### Target audience and content
Target age: **18 and over.** Do not tick any under-18 bracket — a finance app
aimed at children triggers Families policy requirements you do not want.

### News app
**No.**

### COVID-19 contact tracing
**No.**

### Data safety
This is a long form. The truthful answers:

- Does your app collect or share any of the required user data types? → **Yes**
- Is all user data encrypted in transit? → **Yes** (the site is HTTPS only)
- Do you provide a way for users to request data deletion? → **Yes**, email
  `support@usekoinos.com` (this is stated in the privacy policy)

Data types to declare:

| Type | Collected | Shared | Purpose | Required? |
|---|---|---|---|---|
| **Financial info → Other financial info** (wallet address, on-chain balances) | Yes | No | App functionality | Required |
| **Personal info → Email address** | Yes | No | App functionality | Optional — only if the user sends to an email |

Declare **nothing else**. No name, no location, no contacts, no photos, no
messages, no analytics identifiers, no advertising ID, no device IDs — none of
those are collected. There are no third-party SDKs in this app.

### Government apps
**No.**

### Financial features  ← read this one carefully

Tick **Crypto exchanges or software wallets**.

Play then asks which of two you are. The facts about this app, so you can
answer accurately:

- Holdings are **non-custodial** — the user's KOIN lives in a Koinos smart
  contract only their passkey can authorise.
- The Buy feature **converts** ETH / USDC / USDT / SOL into KOIN, and while a
  conversion is in flight the funds sit at addresses the app controls. The app
  says so on screen before the user starts.

The conversion feature is exchange-shaped, and the crypto-exchange category
requires licensing in a number of countries. Two ways forward:

1. Declare the **software (non-custodial) wallet** and limit distribution to
   countries where that is sufficient. Fastest route to testing.
2. Declare **exchange** functionality and be ready with licensing paperwork
   for the markets that ask for it.

If you would rather remove the ambiguity, the Buy tab can be hidden in the
Android build so the shipped app is unambiguously a non-custodial wallet.

### Health
**No health features.** Every answer on this form is No.

---

## 4. Release

**Testing → Closed testing** (or Internal testing) → **Create new release**

1. Upload `bio-wallet-<version>.aab` from
   <https://github.com/therexdev/koinos-bio-wallet/releases/tag/android-latest>
2. Release name: fills in by itself, e.g. `21 (1.0.21)`
3. Release notes:

```
<en-US>
First test build of Koinos Bio Wallet for Android.

The app runs wallet.usekoinos.com full-screen in Chrome, so passkeys, the QR
scanner and the offline shell behave exactly as they do in the browser.

Please check:
• Signing in with a passkey (fingerprint or face), and that your wallet loads.
• The Home, Buy and Security screens, and the long-press launcher shortcuts.
• That there is NO browser address bar at the top. If you see one, say so.
</en-US>
```

4. Add testers by email, save, review, roll out.

---

## 5. After the app exists in Play — do not skip

Play re-signs your app with **its own** key, so the certificate the installed
app presents is not your upload key. Until the site vouches for Google's key,
the Play-installed app shows a browser URL bar.

1. **Test and release → Setup → App signing**
2. Copy the **App signing key certificate** SHA-256
3. On Hostinger set, comma-separated (Google's first, your upload key second):

```
ANDROID_SHA256_FINGERPRINTS=<google app-signing SHA-256>,<upload key SHA-256>
```

Your upload key's fingerprint is printed by
`android/tools/setup-signing.sh` and in each build's job summary.

4. Restart the site, then check:
   `https://wallet.usekoinos.com/.well-known/assetlinks.json`
   It must list `wallet.koinos.app` and both fingerprints.

---

## 6. Back up the signing key

Once the app is on Play this key is permanent — lose it and the app can never
be updated.

```bash
cp ~/koinos-bio-wallet-release.jks ~/.koinos-bio-wallet-keystore-password .
# download both from the Explorer, then:
rm koinos-bio-wallet-release.jks .koinos-bio-wallet-keystore-password
```

---

## Regenerating the assets

```bash
node android/tools/gen-icons.js     # app icons from public/assets/icon.svg
```
The feature graphic and screenshots are produced by the scripts described in
this repository's history; the committed PNGs are what Play expects and only
need redoing if the design changes.
