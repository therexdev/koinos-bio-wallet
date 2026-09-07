# Google Play listing — wallet-only Android build

App: **Koinos Bio Wallet** · package `wallet.koinos.app`

The current Android build opens `/android/` and offers wallet functions only.
Buy, swaps, conversion deposit addresses and conversion signing are absent for
all Android users. The browser and installed PWA retain those features at `/`.
Use the new AAB; updating listing text alone does not change an older APK.

## Store listing copy

**App name**

```
Koinos Bio Wallet
```

**Short description**

```
Your Koinos wallet, secured by a passkey. Send and receive KOIN without gas fees.
```

**Full description**

```
Koinos Bio Wallet is a smart-account wallet for the Koinos blockchain.
Create or open your account with a device passkey using your fingerprint,
face or device PIN. No wallet password or seed phrase is required.

WHAT YOU CAN DO
• Create a Koinos smart account secured by your passkey.
• View your KOIN and VHP balances and track other Koinos tokens.
• Send KOIN to a Koinos address.
• Receive Koinos tokens using your address or QR code.
• Scan a Koinos payment QR code.
• Register a backup passkey and create an offline recovery kit.

KOINOS WITHOUT GAS FEES
Koinos uses regenerating mana instead of gas fees. This wallet sponsors mana
for supported transactions, subject to available capacity and usage limits.

YOU AUTHORIZE YOUR TRANSACTIONS
Your account is an on-chain smart contract. Your registered credentials
approve transactions, and the blockchain verifies them. Keep a backup passkey
or recovery kit so you can regain access if you lose your device.

The Android app provides wallet functionality. It does not offer cryptocurrency
purchases, exchanges or swaps.

Built on the Veive smart-account protocol.
```

## Assets

- `app-icon-512.png`: app icon, 512×512.
- `feature-graphic-1024x500.png`: feature graphic, 1024×500.
- `screenshots/1-welcome.png`: existing welcome screenshot.

The old Home, Buy and Security screenshots were removed because they showed
the Buy navigation. **Capture at least two current phone screenshots from the
new APK before submitting the listing**: Home, Receive and Security are useful
choices. Do not reuse screenshots from the browser/PWA.

For local visual QA with sample data only, run
`node play/preview.js /absolute/output/directory` and open `android-frame.html`
in a local browser. This fixture uses the real template, styles and UI module;
it does not test sign-in, signing, device integration or live balances. Store
screenshots should come from the installed Android app.

## Store settings and public pages

| Field | Value |
|---|---|
| Category | Finance |
| Contact email | support@usekoinos.com |
| Website | https://wallet.usekoinos.com/android/ |
| Privacy policy | https://wallet.usekoinos.com/android/privacy |
| Account/data deletion URL | https://wallet.usekoinos.com/android/delete-account |

These public legal pages need no sign-in and link back to the Android surface.
They explain that any conversion data comes from browser/PWA use. The same
account may have historical browser conversion records.

## App access instructions

There is no shared reviewer username or password. Reviewers need a device with
Chrome and a screen lock enrolled. Supply this in the app-access instructions:

```
Sign-in uses a device passkey, not a username or password. Use an Android device
with Chrome and a screen lock enrolled (Settings > Security > Screen lock).
Tap "Create Account or Sign In" and approve the passkey prompt; a device PIN is
supported. Home, Send, Receive and Security are available after account setup.
There are no purchases or swaps in the Android app.
```

## Financial features and data declarations

Describe the shipped Android product accurately as a non-custodial wallet with
no exchange functionality. Google's [Cryptocurrency Exchanges and Software
Wallets policy](https://support.google.com/googleplay/android-developer/answer/16329703?hl=en)
states that non-custodial wallets are outside that policy's scope. This does
not guarantee Play approval or replace the other Play Console declarations.
Complete the current Console forms based on this build and actual operations.

Account addresses, public credential IDs/keys, credential labels, setup records
and transaction-related records are stored on the server. Balances and public
transactions are read from blockchain providers. Transport uses HTTPS. The
privacy and deletion pages describe retention and deletion requests; public
blockchain records cannot be deleted. Review Data safety answers against those
pages and your hosting/provider practices rather than copying the previous
listing's claim that only one data type was collected.

## Release

1. Deploy the server changes, then use the new APK for the device checks in
   `android/README.md`.
2. Download the matching `bio-wallet-<version>.aab` from the
   [Android release](https://github.com/therexdev/koinos-bio-wallet/releases/tag/android-latest).
   The `.apk` is for direct phone installation; the `.aab` is for Play Console.
3. Update the listing and phone screenshots. Upload the AAB to the intended
   internal/closed testing track and review the release in Play Console.

Suggested release notes:

```
<en-US>
Android now provides wallet functions only: Home, Send, Receive and Security.
Buying and conversions have been removed from the Android app and its shortcuts.
Existing wallet accounts and passkeys continue to work.
</en-US>
```

Keep the existing signing key and package name for upgrades. Play re-signs the
AAB with its app-signing certificate; add that certificate's SHA-256 to
`ANDROID_SHA256_FINGERPRINTS` alongside the existing upload certificate if it
is not already configured. Check `/.well-known/assetlinks.json` before testing
the Play-installed version. Main README contains the signing setup details.
