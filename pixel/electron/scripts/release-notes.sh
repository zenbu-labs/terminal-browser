#!/usr/bin/env bash
# fixme: placeholder copy
# Prints the notes of the production electron-v<version> release.
# Usage: release-notes.sh <electron version>
set -euo pipefail

# fixme: placeholder copy
version="${1:?usage: release-notes.sh <electron version>}"
repo_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"

# fixme: placeholder copy
cat <<NOTES
Patched Electron v$version for pixel.

Patches (source of truth: $repo_url/tree/main/pixel/electron/patches):
- macOS: offscreen-rendering compositors ride a real display link, so page frame rates follow \`webContents.setFrameRate\` instead of being clamped to 60fps on input.
- Linux: offscreen frames can be delivered through shared memory, and offscreen views keep their requested \`deviceScaleFactor\` on native Wayland instead of having it clobbered to 1.0.
- Offscreen wheel events keep their scroll phase, so trackpad scrolling and momentum work.
- Resizing an offscreen view no longer makes the renderer submit frames that are dropped, so the page keeps painting while it resizes.
- \`webContents\` emits \`media-capture-changed\` and exposes \`getMediaCapture()\`, reporting whether the page is using the camera, microphone or screen capture.
- Offscreen input reaches cross-origin iframes: mouse and wheel events are routed to the frame under the pointer, and \`sendInputEvent\` keys go to the focused frame.
- A permission check handler can return \`'prompt'\`, so pages see a permission as not yet decided instead of denied and go on to request it.
- \`electron.d.ts\` is generated from the patched API docs, so it types these additions.

Build: cookies on disk are encrypted with an OS keychain key (the \`EnableCookieEncryption\` fuse), the macOS app is marked \`LSUIElement\` so it never shows in the Dock, and it is signed with our Developer ID and notarized.

Upstream release: https://github.com/electron/electron/releases/tag/v$version
NOTES
