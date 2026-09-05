# Bio Wallet for Android

A Trusted Web Activity (TWA) around https://wallet.usekoinos.com — the
official way to ship a PWA on Android. The app is the website, opened in
Chrome full-screen without the URL bar, so passkeys, the camera scanner,
the service worker and everything else keep working exactly as on the web.

Build, signing, Digital Asset Links and Play Store notes are in the main
README under **Android app**. In short:

```bash
# CI builds it: push to main (or run "Android app" in Actions) and download
# the APK/AAB from the workflow artifacts.
# Locally, with Android Studio / an Android SDK installed:
cd android && gradle assembleRelease      # → app/build/outputs/apk/release/
```

Icons are generated from `public/assets/icon.svg` with
`node android/tools/gen-icons.js`.
