#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist-release}"
BUCKET="${R2_BUCKET:-terminal-browser-releases}"

MANIFESTS=("$OUT"/manifest-*.json)
[ -f "${MANIFESTS[0]}" ] || { echo "no per-target manifests in $OUT" >&2; exit 1; }

MANIFEST="$OUT/manifest.json"
node - "$MANIFEST" "${MANIFESTS[@]}" <<'EOF'
const fs = require("fs");
const [outPath, ...paths] = process.argv.slice(2);
const platforms = {};
let version, channel, published;
for (const path of paths) {
  const m = JSON.parse(fs.readFileSync(path, "utf8"));
  if (version && (m.version !== version || m.channel !== channel)) {
    console.error(`manifest mismatch: ${path} is ${m.channel}/${m.version}, expected ${channel}/${version}`);
    process.exit(1);
  }
  ({ version, channel } = m);
  published = m.published;
  platforms[m.platform] = { file: m.file, sha256: m.sha256, size: m.size };
}
const manifest = { version, channel, published, platforms };
fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
EOF

field() { node -p "require('$MANIFEST').$1"; }
VERSION="$(field version)"
CHANNEL="$(field channel)"

wr() { (cd "$ROOT/release-worker" && npx --yes wrangler "$@"); }

put() {
  # wrangler uploads in one request, which the API caps at 315 MB.
  local size
  size=$(($(wc -c < "$2")))
  if [ "$size" -gt 330000000 ]; then
    echo "$2 is $size bytes — past the single-request R2 limit, needs multipart" >&2
    exit 1
  fi
  wr r2 object put "$BUCKET/$1" --file "$2" --remote --content-type "$3" ${4:+--cache-control "$4"}
}

for target_manifest in "${MANIFESTS[@]}"; do
  file="$(node -p "require('$target_manifest').file")"
  echo "uploading $file"
  put "$CHANNEL/$VERSION/$file" "$OUT/$file" application/gzip
done

PLATFORMS="$(node -p "Object.keys(require('$MANIFEST').platforms).join(', ')")"
echo "publishing aggregate manifest for $CHANNEL/$VERSION ($PLATFORMS)"
put "$CHANNEL/$VERSION/install.sh" "$ROOT/scripts/install.sh" text/x-shellscript
put "$CHANNEL/$VERSION/manifest.json" "$MANIFEST" application/json

if [ "${FLIP_LATEST:-true}" = "true" ]; then
  # Flipped last so a failed upload never leaves the installer pointing at a
  # version whose tarballs are not all there yet.
  put "$CHANNEL/latest.json" "$MANIFEST" application/json no-store
  echo "published $VERSION to $CHANNEL"
else
  echo "published pinned $VERSION (latest.json untouched)"
fi

if [ -n "${RELEASE_ORIGIN:-}" ]; then
  echo "pinned=$RELEASE_ORIGIN/v/$VERSION"
  if [ "${FLIP_LATEST:-true}" = "true" ]; then
    if [ "$CHANNEL" = "stable" ]; then echo "latest=$RELEASE_ORIGIN"; else echo "latest=$RELEASE_ORIGIN/dev"; fi
  fi
fi
