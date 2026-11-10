#!/usr/bin/env bash
#
# Signs and notarizes a built Electron.app so every install runs the same
# Developer ID signed binary. Keychain items Chromium creates for cookie
# encryption are granted to a code signature; a stable one means no prompts.
#
# Environment:
#   MACOS_SIGN_P12           base64 of a .p12 holding a Developer ID Application key
#   MACOS_SIGN_P12_PASSWORD  password of that .p12
#   APPLE_API_KEY_P8         App Store Connect API key, PEM text
#   APPLE_API_KEY_ID         id of that key
#   APPLE_API_ISSUER_ID      issuer id of that key
#   ELECTRON_UNSIGNED=1      local builds only: sign ad-hoc and skip notarization
set -euo pipefail

APP="${1:?usage: macos-sign.sh <Electron.app> <tools dir>}"
TOOLS="${2:?usage: macos-sign.sh <Electron.app> <tools dir>}"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"

if [ "${ELECTRON_UNSIGNED:-0}" = "1" ]; then
  codesign --force --deep --sign - --timestamp=none "$APP"
  echo "signed ad-hoc (ELECTRON_UNSIGNED=1)"
  exit 0
fi
: "${MACOS_SIGN_P12:?set MACOS_SIGN_P12, or ELECTRON_UNSIGNED=1 for a local build}"
: "${APPLE_API_KEY_P8:?notarization needs APPLE_API_KEY_P8}"
: "${APPLE_API_KEY_ID:?notarization needs APPLE_API_KEY_ID}"
: "${APPLE_API_ISSUER_ID:?notarization needs APPLE_API_ISSUER_ID}"

WORK="$(mktemp -d)"
KEYCHAIN="$WORK/sign.keychain-db"
KEYCHAIN_PASSWORD="$(uuidgen)"
ORIGINAL_KEYCHAINS="$(security list-keychains -d user | sed 's/[" ]//g')"

cleanup() {
  security list-keychains -d user -s $ORIGINAL_KEYCHAINS 2>/dev/null || true
  security delete-keychain "$KEYCHAIN" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings "$KEYCHAIN"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
printf %s "$MACOS_SIGN_P12" | base64 -d > "$WORK/sign.p12"
security import "$WORK/sign.p12" -k "$KEYCHAIN" -P "${MACOS_SIGN_P12_PASSWORD:-}" -T /usr/bin/codesign
rm -f "$WORK/sign.p12"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null
security list-keychains -d user -s "$KEYCHAIN" $ORIGINAL_KEYCHAINS

IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN" | awk -F'"' '/Developer ID Application/ {print $2; exit}')"
if [ -z "$IDENTITY" ]; then
  echo "MACOS_SIGN_P12 holds no Developer ID Application identity" >&2
  exit 1
fi
echo "signing as $IDENTITY"

xattr -cr "$APP" 2>/dev/null || true
cp "$SCRIPTS/sign-app.mjs" "$TOOLS/sign-app.mjs"
node "$TOOLS/sign-app.mjs" "$APP" "$IDENTITY" "$KEYCHAIN" "$SCRIPTS/entitlements.plist"
codesign --verify --deep --strict "$APP"

printf %s "$APPLE_API_KEY_P8" > "$WORK/api-key.p8"
ditto -c -k --keepParent "$APP" "$WORK/notarize.zip"

set +e
SUBMIT_OUTPUT="$(xcrun notarytool submit "$WORK/notarize.zip" \
  --key "$WORK/api-key.p8" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID" \
  --wait 2>&1)"
SUBMIT_STATUS=$?
set -e
echo "$SUBMIT_OUTPUT"

if [ $SUBMIT_STATUS -ne 0 ] || ! echo "$SUBMIT_OUTPUT" | grep -q "status: Accepted"; then
  SUBMISSION_ID="$(echo "$SUBMIT_OUTPUT" | awk '/^[[:space:]]*id: / {print $2; exit}')"
  if [ -n "$SUBMISSION_ID" ]; then
    xcrun notarytool log "$SUBMISSION_ID" \
      --key "$WORK/api-key.p8" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID" || true
  fi
  echo "notarization failed" >&2
  exit 1
fi

xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
echo "signed, notarized and stapled"
