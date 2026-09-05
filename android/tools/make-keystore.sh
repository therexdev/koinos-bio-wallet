#!/usr/bin/env bash
# Create the app's signing keystore ONCE and print what CI needs.
#
#   android/tools/make-keystore.sh [release.jks] [alias]
#
# The key is the app's identity on every phone: a build signed with a
# different key cannot be installed over one that is already there (Android
# says "App not installed"), and Play ties the listing to it. Make it once,
# back the file up offline, never commit it (android/.gitignore refuses
# *.jks and *.keystore).
set -euo pipefail
out=${1:-release.jks}
alias=${2:-biowallet}
if [ -e "$out" ]; then
  echo "$out already exists — keep the key you have; a new one is a new app identity." >&2
  exit 1
fi
command -v keytool >/dev/null || { echo "keytool not found: install a JDK (17+)" >&2; exit 1; }
read -rsp "Keystore password (8+ characters): " pw; echo
[ ${#pw} -ge 8 ] || { echo "too short" >&2; exit 1; }
keytool -genkeypair -v -keystore "$out" -alias "$alias" -keyalg RSA -keysize 4096 -validity 10000 \
  -storepass "$pw" -keypass "$pw" -dname "CN=Koinos Bio Wallet, O=usekoinos.com, C=US" >/dev/null
fp=$(keytool -list -v -keystore "$out" -storepass "$pw" -alias "$alias" | grep -m1 'SHA256:' | sed 's/.*SHA256: *//')
b64=$(base64 -w0 "$out" 2>/dev/null || base64 "$out" | tr -d '\n')
cat <<TXT

Created $out (alias $alias). Back it up offline now.

GitHub → repository Settings → Secrets and variables → Actions:
  ANDROID_KEYSTORE_BASE64   $b64
  ANDROID_KEYSTORE_PASSWORD (the password you typed)
  ANDROID_KEY_ALIAS         $alias
  ANDROID_KEY_PASSWORD      (the same password)

Wallet server environment (makes Chrome hide the URL bar in the app):
  ANDROID_SHA256_FINGERPRINTS=$fp

After the next CI run every build is signed with this key, so new builds
install over old ones. Phones that already have a debug-signed build must
uninstall it once.
TXT
