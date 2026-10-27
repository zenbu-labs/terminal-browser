# Local electron dev loop

Iterate on the electron patches in minutes instead of waiting for the CI build.

Needs macOS with Xcode or Linux with the Chromium build deps, 36 GB RAM, about 70 GB of disk.

```sh
dev/setup.sh                 # once: build-tools, checkout at the pinned version, patches as commits, first build (1 to 2 hours)
dev/build.sh                 # after editing src/electron: incremental build (1 to 3 minutes); pass -j N to override the memory-based job cap
dev/export-patches.sh        # write ../patches from the commits on the branch; add --check to verify against a clean checkout
```

The checkout lives in `~/electron-dev` (override with `PIXEL_ELECTRON_DEV_ROOT`). Set
`PIXEL_ELECTRON_VERSION` to work against a newer electron than the pinned one, for example to
rebase the patches before that version has been built and released. Its electron
source is on branch `pixel/v<version>`, one commit per patch. Make changes there as normal
commits; the commit subject becomes the patch file name.

Run anything that launches pixel against the freshly built app:

```sh
PIXEL_ELECTRON_APP="$HOME/electron-dev/src/out/Testing/Electron.app" nr browser
```

The dev app is a plain `Electron.app`: it shows a Dock icon and macOS tracks its camera and
microphone permissions separately from the released `pixel` app.

The CI workflow `pixel electron build` is still what produces release binaries. Dispatch it once
the exported patches are right.
