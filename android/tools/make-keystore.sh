#!/usr/bin/env bash
# Create the app's signing key ONCE and print exactly what to paste where.
#
#   bash android/tools/make-keystore.sh
#
# The key is the app's identity on every phone. A build signed with a
# different key cannot install over one already there (Android says "App not
# installed"), and Google Play ties the listing to it forever: lose this file
# and you can never update the app again. So: it is written OUTSIDE the
# repository (this one is public), and you must back it up somewhere safe.
set -euo pipefail

# Outside the working tree by default, because a keystore committed to a
# public repo hands the app's identity to anyone who looks.
default_out="$HOME/koinos-bio-wallet-release.jks"
out=${1:-$default_out}
alias=${2:-biowallet}

if repo_root=$(git -C "$(dirname "$out")" rev-parse --show-toplevel 2>/dev/null); then
  echo "Refusing to write inside the git repository at $repo_root." >&2
  echo "This repository is public. Run it with no arguments and the key goes" >&2
  echo "to $default_out instead." >&2
  exit 1
fi

if [ -e "$out" ]; then
  echo "$out already exists — keep the key you have." >&2
  echo "A new key is a NEW app identity: Play would reject it as an update," >&2
  echo "and phones could not install over the existing app." >&2
  exit 1
fi
command -v keytool >/dev/null || { echo "keytool not found: install a JDK (17+)" >&2; exit 1; }

# Generated, not typed: this password is only ever pasted between this output
# and a GitHub secret, so there is nothing to remember and nothing to guess.
# `tr ... < /dev/urandom | head -c` looks tidier and dies here: head closes
# the pipe, tr takes SIGPIPE, and `set -o pipefail` kills the script before
# it does anything. od reads a fixed count and exits on its own.
pw=$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')

keytool -genkeypair -v -keystore "$out" -alias "$alias" -keyalg RSA -keysize 4096 -validity 10000 \
  -storepass "$pw" -keypass "$pw" -dname "CN=Koinos Bio Wallet, O=usekoinos.com, C=US" >/dev/null
chmod 600 "$out"

fp=$(keytool -list -v -keystore "$out" -storepass "$pw" -alias "$alias" | grep -m1 'SHA256:' | sed 's/.*SHA256: *//')

# The base64 goes to a FILE, not to the terminal. Copying 5,000-plus
# characters by dragging across a wrapped line is the step that goes wrong,
# and a paste cut short decodes with no error at all into a corrupt
# keystore — which only surfaces later as a Gradle failure nobody can read.
# In a file, Ctrl-A selects exactly all of it.
b64file="KEYSTORE_BASE64.txt"
base64 -w0 "$out" > "$b64file" 2>/dev/null || base64 "$out" | tr -d '\n' > "$b64file"
b64len=$(wc -c < "$b64file" | tr -d ' ')

cat <<TXT

================================================================
 DONE. The key is at:  $out
================================================================

STEP 1 — Add four secrets to GitHub.

  Open: https://github.com/therexdev/koinos-bio-wallet/settings/secrets/actions
  Click "New repository secret" four times, once per row below.
  Name and value must match exactly.

  ----------------------------------------------------------------
  Name:  ANDROID_KEY_ALIAS
  Value: $alias
  ----------------------------------------------------------------
  Name:  ANDROID_KEYSTORE_PASSWORD
  Value: $pw
  ----------------------------------------------------------------
  Name:  ANDROID_KEY_PASSWORD
  Value: $pw
         (yes — the same value as the one above)
  ----------------------------------------------------------------
  Name:  ANDROID_KEYSTORE_BASE64
  Value: the contents of $b64file ($b64len characters)

         Open that file from the Explorer panel on the left, then
         Ctrl-A, Ctrl-C. Do NOT drag-select it: a copy that stops
         short decodes without any error and produces a corrupt
         key, and the build then fails on something unreadable.
  ----------------------------------------------------------------

STEP 2 — Back the key up.

  The key is OUTSIDE the repository, which is why the Explorer panel on
  the left does not list it. To download it, bring it in for a moment:

      cp $out .

  It appears in the Explorer. Right-click it -> Download. Then:

      rm $(basename "$out")

  That is safe: *.jks is git-ignored at the repository root, so git will
  not track it either way.

  Keep the downloaded file somewhere you will still have in five years,
  and save this password with it:

      $pw

  Without both, this app can never be updated again.

STEP 3 — Build a signed app.

  https://github.com/therexdev/koinos-bio-wallet/actions/workflows/android.yml
  → "Run workflow" → Run. When it finishes, the .aab for Play is on:
  https://github.com/therexdev/koinos-bio-wallet/releases/tag/android-latest

This key's SHA-256 fingerprint (NOT secret — see the README about
assetlinks and Play App Signing):

$fp

When every secret is in, delete the base64 file:  rm $b64file
(The key itself stays at $out.)
TXT
