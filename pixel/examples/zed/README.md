# zed

```sh
pnpm install
pnpm pixel:build
pnpm pixel:build:native --release
pnpm zed:setup
pnpm zed [folder]
```

```sh
pnpm --filter zed dist   # installs zed-pixel to ~/.local/bin
zed-pixel [folder]
zed-pixel shutdown
```

This example is based on a [fork of zed](https://github.com/purduehackers/zed), built by
[Ray Arayilakath](https://github.com/rayhanadev), that compiles zed's ui to web assembly so that
zed can be rendered using webgpu as a backend. This example pairs the (forked) zed with pixel's
webview component to run zed in the terminal.
