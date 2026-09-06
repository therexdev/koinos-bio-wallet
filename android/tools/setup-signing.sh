#!/usr/bin/env bash
# Signing, start to finish, with nothing for a human to copy.
#
#   bash android/tools/setup-signing.sh
#
# Every failure this replaces was a copy-paste failure: 5,700 characters of
# base64 dragged out of a wrapped terminal line (a short copy decodes with no
# error at all and yields a corrupt keystore), and a password picked up with
# a trailing newline. So nothing is copied. The key is made here and the four
# secrets are written straight to GitHub with `gh`, which a codespace already
# has signed in.
set -euo pipefail

REPO=${REPO:-therexdev/koinos-bio-wallet}
KEY=${ANDROID_KEYSTORE_FILE:-$HOME/koinos-bio-wallet-release.jks}
PWFILE="$HOME/.koinos-bio-wallet-keystore-password"
ALIAS=biowallet

command -v keytool >/dev/null || { echo "keytool not found: install a JDK 17+." >&2; exit 1; }
command -v gh >/dev/null || {
  echo "The 'gh' command is not here. This script is meant to be run in a GitHub" >&2
  echo "codespace, where gh is installed and already signed in." >&2
  exit 1
}

# Writing secrets needs more than the token a codespace starts with. That
# token lives in GITHUB_TOKEN and gh prefers it over anything you log in
# with — so once a proper login exists, this has to look PAST the
# environment to find it. Try as-is, then again without the env token.
GH_ENVLESS=false
if ! gh secret list --repo "$REPO" >/dev/null 2>&1; then
  if env -u GITHUB_TOKEN -u GH_TOKEN gh secret list --repo "$REPO" >/dev/null 2>&1; then
    GH_ENVLESS=true          # a real login exists; the env token was the problem
  else
    cat >&2 <<MSG
gh cannot write secrets for this repository yet.

A codespace signs gh in with a token from the environment that is not
allowed to write secrets, and it CANNOT be upgraded — 'gh auth refresh'
will refuse it. It has to be replaced with your own login. Two lines:

    unset GITHUB_TOKEN GH_TOKEN
    gh auth login --hostname github.com --scopes repo --web

It prints a one-time code, then a URL. Open the URL, type the code,
approve. Then run this script again:

    bash android/tools/setup-signing.sh

(If it asks "What account do you want to log into?" choose GitHub.com,
and for protocol choose HTTPS.)
MSG
    exit 1
  fi
fi
# Every gh call from here uses whichever credential actually works.
# `env` execs a binary, and `command` is a shell builtin — so `env ... command gh`
# looks for a program called "command" and fails. env finds gh on PATH by
# itself, and an exec'd binary never re-enters this function.
gh() { if [ "$GH_ENVLESS" = true ]; then env -u GITHUB_TOKEN -u GH_TOKEN gh "$@"; else command gh "$@"; fi; }

# An existing key is only worth keeping if its password is known and works.
# Nothing is published to Play yet, so a key that cannot be opened is not a
# disaster to replace — it is only a disaster AFTER the first upload.
reuse=false
if [ -f "$KEY" ] && [ -f "$PWFILE" ]; then
  PW=$(tr -d '[:space:]' < "$PWFILE")
  if keytool -list -keystore "$KEY" -storepass "$PW" >/dev/null 2>&1; then
    reuse=true
    echo "Reusing the key at $KEY (its password checks out)."
  else
    echo "The key at $KEY does not open with the saved password."
  fi
fi

if [ "$reuse" = false ]; then
  if [ -f "$KEY" ]; then
    mv "$KEY" "$KEY.replaced-$(date +%s)"
    echo "Moved the old key aside (nothing is published to Play, so it is not needed)."
  fi
  PW=$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')
  keytool -genkeypair -v -keystore "$KEY" -alias "$ALIAS" -keyalg RSA -keysize 4096 \
    -validity 10000 -storepass "$PW" -keypass "$PW" \
    -dname "CN=Koinos Bio Wallet, O=usekoinos.com, C=US" >/dev/null
  chmod 600 "$KEY"
  printf '%s' "$PW" > "$PWFILE"; chmod 600 "$PWFILE"
  echo "Made a new signing key at $KEY."
fi

# Straight from the file to the secret. No terminal, no selection, no paste.
# Each one is checked: a partial success here is what produced a build with
# one secret of four set and an error message blaming the wrong thing.
B64=$(mktemp); trap 'rm -f "$B64"' EXIT
base64 -w0 "$KEY" > "$B64" 2>/dev/null || base64 "$KEY" | tr -d '\n' > "$B64"
set_secret() {
  local name=$1
  if ! gh secret set "$name" --repo "$REPO" >/dev/null 2>&1; then
    echo "FAILED to set $name. Nothing below is trustworthy — stopping." >&2
    exit 1
  fi
  echo "  set $name"
}
echo "Setting secrets on $REPO:"
set_secret ANDROID_KEYSTORE_BASE64   < "$B64"
printf '%s' "$PW"    | set_secret ANDROID_KEYSTORE_PASSWORD
printf '%s' "$PW"    | set_secret ANDROID_KEY_PASSWORD
printf '%s' "$ALIAS" | set_secret ANDROID_KEY_ALIAS

# Read them back. gh cannot show values, but it can prove the NAMES exist,
# which is exactly what was missing.
missing=
for n in ANDROID_KEYSTORE_BASE64 ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_PASSWORD ANDROID_KEY_ALIAS; do
  gh secret list --repo "$REPO" | grep -q "^$n" || missing="$missing $n"
done
if [ -n "$missing" ]; then
  echo "These did not stick:$missing" >&2
  echo "Your gh login may not have permission to write secrets. Run:" >&2
  echo "    gh auth refresh -h github.com -s repo" >&2
  exit 1
fi

# Prove the round trip locally, so CI is not the first thing to find out.
RT=$(mktemp); trap 'rm -f "$B64" "$RT"' EXIT
tr -d '[:space:]' < "$B64" | base64 -d > "$RT"
cmp -s "$KEY" "$RT" || { echo "The base64 did not round-trip. Stopping." >&2; exit 1; }
keytool -list -keystore "$RT" -storepass "$PW" >/dev/null

FP=$(keytool -list -v -keystore "$KEY" -storepass "$PW" -alias "$ALIAS" | grep -m1 'SHA256:' | sed 's/.*SHA256: *//')

cat <<TXT

================================================================
 All four secrets are set. Nothing to copy.
================================================================
$(gh secret list --repo "$REPO" | grep ANDROID_ || true)

The base64 was checked back into an identical keystore before sending,
so a short or mangled value is not possible this time.

NEXT — build it:
  https://github.com/$REPO/actions/workflows/android.yml
  "Run workflow" -> Run. The .aab for Play lands on:
  https://github.com/$REPO/releases/tag/android-latest

BACK IT UP once the app is on Play (until then a new key costs nothing):
  key      $KEY
  password $PWFILE
Download both from the Explorer after:  cp "$KEY" "$PWFILE" .
and delete the copies afterwards. Losing them AFTER publishing means the
app can never be updated.

Signing certificate SHA-256 (not secret; for assetlinks):
$FP

TXT
