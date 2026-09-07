# Bio Wallet for Android

The APK opens `https://wallet.usekoinos.com/android/` as a Trusted Web Activity.
It has Home, Send, Receive and Security. Buying and conversions are absent.
The website and installed PWA at `/` retain Buy and their existing API routes.
Same-origin passkeys and accounts work across both versions.

`WalletLauncherActivity` fixes the launch destination and accepts only Send,
Receive and Security intents. App Links claim `/android/` only. An activity
alias handles previously pinned shortcuts; an old Buy pin opens Home.
`/android/api/*` supplies wallet APIs and rejects funding endpoints, including
funding transactions submitted through the generic submit route. These are
product capability checks, not client attestation or a replacement for signing.

## Build and release

Deploy the server before distributing this build. Pushes to main touching
`android/` or the Android workflow build and publish the APK and AAB to the
`android-latest` GitHub release. Pull requests run the Android build and unit
tests without publishing. Existing signing secrets and the package identifier
remain unchanged; do not generate a new signing key for this update.

```bash
npm test
cd android
gradle testReleaseUnitTest assembleRelease bundleRelease
```

## Release checks on a phone

1. Upgrade the existing app; sign in with an existing passkey. Verify Home,
   Send, Receive, QR scanning and Security. No Buy tab, deposit wallet, conversion
   panel, external purchase link or Buy launcher shortcut should exist.
2. Launch Send and Receive shortcuts. An old pinned Buy shortcut must open Home.
   An explicit Buy URL sent to the launcher must also open Home.
3. After one online launch, reopen offline. Android must show the wallet-only
   shell. Balances and transactions still require a connection.
4. Open the normal website and install/open its PWA in the same browser profile.
   Both retain Buy, including after the APK has been opened. Website links must
   stay in the browser rather than being claimed by the Android app.
5. Verify `/.well-known/assetlinks.json` includes the installed signing
   certificate. Play uses its app-signing certificate, not the upload key.

The automated Node suites cover real HTTP route separation, HTML removal,
shared accounts, manifest shortcuts, pending funding submission rejection,
and offline cache isolation. JUnit covers launcher URL sanitization. Device
passkey/QR ceremonies and Play review require a supported Android device.

Icons come from `public/assets/icon.svg` via `node android/tools/gen-icons.js`.
