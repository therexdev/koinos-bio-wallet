#!/usr/bin/env bash
# Write ANDROID_KEYSTORE_BASE64 to a FILE you can open and select all of.
#
#   bash android/tools/print-keystore-secret.sh [keystore]
#
# Copying 5,000-plus characters by dragging across a wrapped terminal line
# is the step that goes wrong: a paste cut short decodes without any error
# at all and produces a corrupt keystore, which Gradle only reports much
# later as "toDerInputStream rejects tag type -46". A file opens in the
# editor, where Ctrl-A / Cmd-A selects the whole thing exactly.
set -euo pipefail

ks=${1:-$HOME/koinos-bio-wallet-release.jks}
[ -f "$ks" ] || { echo "No keystore at $ks — run android/tools/make-keystore.sh first." >&2; exit 1; }

# Into the repository folder so the Explorer lists it; *.jks is ignored
# there and so is this, and it is deleted the moment it has been copied.
out="KEYSTORE_BASE64.txt"
base64 -w0 "$ks" > "$out" 2>/dev/null || base64 "$ks" | tr -d '\n' > "$out"
n=$(wc -c < "$out" | tr -d ' ')

cat <<TXT

Wrote $out — $n characters, one line, no newline at the end.

  1. Open $out from the Explorer panel on the left.
  2. Ctrl-A then Ctrl-C (Cmd on a Mac). Do NOT drag-select it.
  3. Paste into the ANDROID_KEYSTORE_BASE64 secret:
     https://github.com/therexdev/koinos-bio-wallet/settings/secrets/actions
  4. The secret should be $n characters. GitHub does not show you that,
     so if the build still fails on the keystore, a short paste is why.
  5. Delete it when done:  rm $out

TXT
