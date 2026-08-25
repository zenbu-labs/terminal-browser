#!/bin/bash
set -euo pipefail

# Signs everything in a staged darwin release. Without MACOS_SIGN_P12 it signs
# ad-hoc, which is enough to run locally but fails Gatekeeper on other machines.
# With it, everything gets a Developer ID signature with the hardened runtime,
# and stable builds are additionally notarized by Apple and stapled.
#
# Environment:
#   MACOS_SIGN_P12           base64 of a .p12 holding a Developer ID Application key
#   MACOS_SIGN_P12_PASSWORD  password of that .p12
#   APPLE_API_KEY_P8         App Store Connect API key, PEM text (stable builds)
#   APPLE_API_KEY_ID         id of that key                     (stable builds)
#   APPLE_API_ISSUER_ID      issuer id of that key              (stable builds)

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="${1:?usage: macos-sign.sh <stage-dir> <channel>}"
CHANNEL="${2:-dev}"

APP="$STAGE/electron/terminal-browser.app"
LOOSE_BINARIES=(
  "$STAGE/bin/native-scroll-helper"
  "$STAGE/agent-browser/bin/agent-browser"
  "$STAGE/browser/native/pixel.node"
)

if [ -z "${MACOS_SIGN_P12:-}" ]; then
  for binary in "${LOOSE_BINARIES[@]}"; do
    codesign --force --sign - --timestamp=none "$binary"
  done
  codesign --force --sign - --timestamp=none "$APP"
  echo "signed ad-hoc (MACOS_SIGN_P12 not set)"
  exit 0
fi

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

for binary in "${LOOSE_BINARIES[@]}"; do
  xattr -c "$binary" 2>/dev/null || true
  codesign --force --sign "$IDENTITY" --keychain "$KEYCHAIN" --options runtime --timestamp "$binary"
done

xattr -cr "$APP" 2>/dev/null || true
node "$ROOT/scripts/sign-app.mjs" "$APP" "$IDENTITY" "$KEYCHAIN" "$ROOT/scripts/entitlements.plist"
codesign --verify --deep --strict "$APP"

if [ "$CHANNEL" != stable ]; then
  echo "signed with Developer ID ($CHANNEL build, notarization skipped)"
  exit 0
fi

: "${APPLE_API_KEY_P8:?stable release with MACOS_SIGN_P12 also needs APPLE_API_KEY_P8}"
: "${APPLE_API_KEY_ID:?stable release with MACOS_SIGN_P12 also needs APPLE_API_KEY_ID}"
: "${APPLE_API_ISSUER_ID:?stable release with MACOS_SIGN_P12 also needs APPLE_API_ISSUER_ID}"

printf %s "$APPLE_API_KEY_P8" > "$WORK/api-key.p8"
ditto -c -k --keepParent "$STAGE" "$WORK/notarize.zip"

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
