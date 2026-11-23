#!/usr/bin/env bash
# Verify every patch in patches/ applies cleanly to a given electron version.
# Usage: check-patches.sh <version, e.g. 43.1.1>
# Exits non-zero with a loud message on any conflict.
set -euo pipefail

VERSION="${1:?usage: check-patches.sh <electron version>}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Cloning electron v$VERSION (shallow)..."
git clone --quiet --depth 1 --branch "v$VERSION" https://github.com/electron/electron "$WORK/electron" || { echo "could not clone electron v$VERSION"; exit 2; }

# patches form an ordered series, so each one is applied before checking the next
failed=0
for patch in "$REPO_DIR"/patches/*.patch; do
  name="$(basename "$patch")"
  if git -C "$WORK/electron" apply "$patch" 2>"$WORK/err.txt"; then
    echo "OK       $name"
  else
    failed=1
    echo "CONFLICT $name"
    sed 's/^/         /' "$WORK/err.txt"
  fi
done

added="$(git -C "$WORK/electron" ls-files --others --exclude-standard -- patches/chromium | grep '\.patch$' || true)"
if [ "$failed" -eq 0 ] && [ -n "$added" ]; then
  chromium_version="$(grep -A1 "'chromium_version':" "$WORK/electron/DEPS" | tr -d ' \n' | sed -E "s/.*'chromium_version':'([^']+)'.*/\1/")"
  echo "Fetching the chromium $chromium_version files those patches touch..."
  CHROMIUM="$WORK/chromium"
  git init --quiet "$CHROMIUM"
  files="$(for p in $added; do grep '^diff --git ' "$WORK/electron/$p" | awk '{print substr($3, 3)}'; done | sort -u)"
  includes=()
  for f in $files; do
    includes+=("--include=$f")
    mkdir -p "$CHROMIUM/$(dirname "$f")"
    code="$(curl -sS -o "$WORK/fetched.txt" -w '%{http_code}' "https://chromium.googlesource.com/chromium/src/+/refs/tags/$chromium_version/$f?format=TEXT")" || code=000
    case "$code" in
      200) base64 --decode < "$WORK/fetched.txt" > "$CHROMIUM/$f" ;;
      404) ;;
      *) echo "could not fetch $f from chromium $chromium_version (HTTP $code)"; exit 2 ;;
    esac
  done
  while read -r name; do
    case "$name" in ''|'#'*) continue ;; esac
    if git -C "$CHROMIUM" apply --allow-empty "${includes[@]}" "$WORK/electron/patches/chromium/$name" 2>"$WORK/err.txt"; then
      case " $(echo $added) " in *" patches/chromium/$name "*) echo "OK       chromium/$name" ;; esac
    else
      failed=1
      echo "CONFLICT chromium/$name"
      sed 's/^/         /' "$WORK/err.txt"
    fi
  done < "$WORK/electron/patches/chromium/.patches"
fi

if [ "$failed" -ne 0 ]; then
  echo ""
  echo "PATCH CONFLICT against electron v$VERSION — the patch needs a manual rebase."
  exit 1
fi
echo "All patches apply cleanly to electron v$VERSION."
