# pixel: documentation for agents

Paths are relative to this directory (`pixel/`). Source: `packages/pixel/src/`. Public exports: `packages/pixel/src/index.ts`.

## Where things are

| path | contents |
| --- | --- |
| `packages/pixel/src/index.ts` | everything exported from `@zenbu-labs/pixel` |
| `packages/pixel/src/root.tsx` | `createRoot`, `RootOptions`, `Root` |
| `packages/pixel/src/react/index.ts` | engine root, render settings, key events, clipboard functions |
| `packages/pixel/src/react/reconciler-config.ts` | props and event types for `Box`, `Text`, `Input`, `Image`, `Path`, `MarkedText` |
| `packages/pixel/src/react/components.ts` | component definitions, `NodeHandle` |
| `packages/pixel/src/react/styles.ts` | `Style`, `Color`, borders, gradients |
| `packages/pixel/src/react/surface.ts` | `Surface`, `SurfaceCapture` |
| `packages/pixel/src/react/native.ts` | `EngineInfo`, `TerminalColors`, `highlight`, `diff`, `parseMarkdown`, recording encoders |
| `packages/pixel/src/react/markdown.tsx` | `Markdown` |
| `packages/pixel/src/webview.tsx` | `WebView`, `WebViewProps`, `WebViewHandle`, `WebViewRecording` |
| `packages/pixel/src/web/` | offscreen rendering, input forwarding, popups, devtools, open-window policy |
| `packages/pixel/src/devtools.tsx` | `DevTools` component |
| `packages/pixel/src/theme.ts` | `makeTheme`, `Theme` |
| `packages/pixel/src/layout.ts` | `useRect` |
| `packages/pixel/src/instances.ts` | instance records, `listInstances`, `findOwner` |
| `packages/pixel/src/host/` | same-pane tabs and TUI embedding |
| `packages/pixel/src/ssh/index.ts` | `@zenbu-labs/pixel/ssh` |
| `packages/pixel/src/terminal/` | `@zenbu-labs/pixel/terminal`, one file per terminal in `terminals/` |
| `packages/pixel/src/preload/index.ts` | `@zenbu-labs/pixel/preload` types for `window.pixel` |
| `packages/pixel/src/electron/index.ts` | `@zenbu-labs/pixel/electron`, re-exports `electron` |
| `packages/pixel/src/bin.ts` | the `pixel` CLI |
| `engine/crates/pixel-core/` | Rust engine: layout, painting, terminal output |
| `engine/crates/pixel-node/` | Node binding for the engine |

## Examples

| path | shows |
| --- | --- |
| `packages/create-pixel/template` | the `npm create @zenbu-labs/pixel@latest` starter; run it from the repo root with `pnpm starter` |
| `examples/hello` | `createRoot` + `root.loadURL`, one full screen page |
| `examples/composed` | React layout, two `WebView`s, `DevTools`, `Input`, preload script, guest tabs |
| `examples/transparent` | transparent root and transparent `WebView` |
| `examples/ssh` | `connectSsh` with a remote bundle, proxied `WebView` |
| `examples/daemon` | one Electron process serving many terminals via `createRoot({ tty, sessionEnv })` |
| `examples/tui-host-ts` | TypeScript TUI that embeds a pixel app with `PIXEL_EMBED` |
| `examples/tui-host` | the same host in Python |
| `examples/geometry-debug` | WebView with custom chrome and a live panel of engine geometry, resize events and transmits |
| `../browser` | terminal-browser, the largest pixel app |
| `../claude-code-plugin` | pixel frames rendered inside a Claude Code pane |

## Install and run

```
npm install @zenbu-labs/pixel react@18
```

- postinstall downloads the patched Electron runtime. pnpm needs `pnpm approve-builds`; bun needs `"trustedDependencies": ["@zenbu-labs/pixel"]`.
- If the runtime is missing: `node node_modules/@zenbu-labs/pixel/scripts/postinstall.mjs`.
- `pixel <entry|dir> [-- args]` runs a built JS entry inside the runtime in the current pane. A directory resolves to its `package.json` `main`.
- Args after `--` are `process.argv[2...]`.
- stderr goes to `$XDG_STATE_HOME/pixel/logs/<app>.stderr.log`.
- `PIXEL_SKIP_GRAPHICS_CHECK=1` skips the startup graphics probe.
- `createRoot()` throws outside the runtime.

Minimal app (`examples/hello/src/main.ts`):

```ts
import { createRoot } from "@zenbu-labs/pixel";

const root = createRoot({
  onKey(event) {
    if (event.kind === "press" && event.mods.ctrl && event.key === "c") {
      root.stop();
      return true;
    }
  },
});

const page = root.loadURL("https://github.com/zenbu-labs");
page.onChange((state) => root.setTitle(state.title || state.url));
```

## createRoot

`packages/pixel/src/root.tsx:106`

```ts
function createRoot(options?: RootOptions): Root
```

### RootOptions

`packages/pixel/src/root.tsx:42`, engine fields at `packages/pixel/src/react/index.ts:170`

| field | what it does |
| --- | --- |
| `name?: string` | name stored in the instance record and shown in tab strips |
| `fonts?: FontFace[]` | font files added before the first frame, see Fonts |
| `onKey?(event: EngineKeyEvent): boolean \| void` | called for every key; return `true` to stop it reaching the focused WebView or Input |
| `onQuit?(view: WebViewHandle \| null)` | called when a page navigates to `pixel://quit` or calls `pixel.quit()`; default stops the root |
| `onExit?(code: number)` | called after the root stops; default `app.exit(code)` |
| `onUnsupportedTerminal?(terminal: Terminal \| null): string` | text written to the terminal when `pixel` found no graphics support; the process then exits 1 |
| `onRightClick?({ x, y })` | right click outside a WebView |
| `onPaste?(text)` | text paste |
| `onPasteImage?(image: PastedImage)` | image paste |
| `onFocus?(focused: boolean)` | terminal focus change |
| `onVisible?(visible: boolean)` | pane visibility change |
| `onResize?({ width, height, basePx })` | pane resize, pixel size and base font size |
| `onColors?(colors: TerminalColors)` | terminal color change |
| `devtools?: boolean` | enables built in devtools; default `NODE_ENV !== "production"` |
| `cwd?: string` | base directory for exported devtools profiles |
| `tty?: string` | tty to render to instead of the process's own |
| `wrapper?: "tmux"` | wrap graphics in tmux passthrough |
| `sessionEnv?: NodeJS.ProcessEnv` | environment used for terminal detection |

### Root

`packages/pixel/src/root.tsx:61`, engine methods at `packages/pixel/src/react/index.ts:199`

| member | what it does |
| --- | --- |
| `render(element)` | mounts a React tree |
| `loadURL(url, options?: LoadOptions): WebViewHandle` | renders a full size WebView, or navigates the mounted one |
| `loadFile(path, options?: LoadOptions): WebViewHandle` | same for a local file |
| `stop(code?)` | unmounts, restores the terminal, calls `onExit` |
| `info: EngineInfo` | `{ width, height, cellWidth, cellHeight, basePx, kittyKeyboard, hosted, colors }` |
| `displayScale: number` | device pixel ratio |
| `hosted: boolean` | true when running as a guest tab or embedded |
| `setTitle(text)` | sets the terminal title |
| `setClipboard(text)` | copies via OSC 52 |
| `requestClipboardImage()` | requests a clipboard image, delivered to `onPasteImage` |
| `setClearColor(rgba)` | background color behind all content; alpha 0 shows the terminal |
| `setKeyCapture(keys: string[])` | listed unmodified keys (`"enter"`, `"escape"`, `"a"`) go to `onKey` even while an `Input` is focused; keys with ctrl/alt/shift/super never match |
| `registerFont(face: FontFace): Promise<void>` | adds a font file to a family after startup; text laid out afterwards can use it |
| `createSurface(): Surface` | creates a pixel surface for `<Box surface>` |
| `setRender({ maxFps?, highlightTransmits?, frameEvents? })` | frame rate cap and render debug options |
| `openDevtools(tab?)` / `closeDevtools()` | built in devtools for the React UI |
| `startProfile()` / `stopProfile(): Promise<string \| null>` | records a profile, returns its path |
| `setLogFile(path \| null)` | writes engine logs to a file |
| `nudgeResize()` | re-reads the pane size |
| `queryLayout()` | returns the current layout tree |
| `surfaceStats()` | surface transmit statistics |

### Fonts

Text names fonts by family, as in CSS. `FontFace` is `{ family, src, weight?, style?: "normal" | "italic" }`; several faces can share a family, e.g. Regular, Bold and Italic files of one typeface. `"monospace"` (the bundled JetBrains Mono, the default for all text) and `"sans-serif"` (the system UI font, else the bundled Inter) always exist; `"ui-monospace"` and `"system-ui"` are aliases.

- `style.fontFamily` is a family or a list in order of preference. `fontWeight` and `fontStyle` pick the closest face in each family, as CSS font matching does. All three inherit separately, so a child that sets only `fontWeight` keeps its parent's family.
- Bold and italic spans use the family's bold or italic face. A family without one is emboldened with a second offset pass or slanted with a shear.
- A character the first family lacks comes from the next family in the list, then from the system fonts (CoreText on macOS, fontconfig on Linux), including color emoji. With a monospace first family, borrowed glyphs keep its cell grid: wide characters such as CJK and emoji take two cells and combining marks take none.

`LoadOptions` = `WebViewProps` without `src`, `style`, `hidden`, `autoFocus`.

## Style

`packages/pixel/src/react/styles.ts:48`. Flexbox, row by default. Numbers are pixels. Scale off `root.info.basePx`.

| property | type |
| --- | --- |
| `flexDirection` | `"row" \| "column"` |
| `flexGrow`, `flexShrink` | `number` |
| `flexBasis`, `width`, `height`, `minWidth`, `maxWidth`, `maxHeight` | `number \| "${n}%" \| "auto"` |
| `padding`, `margin` | `number \| { top, right, bottom, left }` |
| `gap` | `number` |
| `position` | `"flow" \| "absolute"` |
| `inset` | `{ top, right, bottom, left }`, numbers or percents |
| `overflow` | `"visible" \| "hidden" \| "scroll"` |
| `justifyContent` | `"start" \| "center" \| "end" \| "space-between"` |
| `alignItems` | `"start" \| "center" \| "end" \| "stretch"` |
| `background` | `Color \| { from: [x, y], to: [x, y], stops: [{ at, color }] }` |
| `cornerRadius` | `number \| { topLeft, topRight, bottomRight, bottomLeft }` |
| `border` | `{ width, color } \| { top?, right?, bottom?, left?: [width, color] }` |
| `color`, `hoverBackground`, `hoverColor`, `selectionColor` | `Color` |
| `fontSize` | `number` |
| `fontFamily` | `string \| string[]`, see Fonts |
| `fontWeight` | `number \| "normal" \| "bold"` |
| `fontStyle` | `"normal" \| "italic"` |
| `opaque`, `wrap`, `ellipsis`, `selectable` | `boolean` |
| `scrollbar` | `ScrollbarStyle` |
| `selectionMode` | `"text" \| "unified"` |
| `pointerShape` | `PointerShape`, CSS cursor names (`"pointer"`, `"text"`, `"grab"`, `"ns-resize"`, ...) |

`Color` = `[r, g, b, a] \| [r, g, b] \| "#rgb" \| "#rgba" \| "#rrggbb" \| "#rrggbbaa"`. There is no `minHeight`.

The engine sets the mouse cursor from whatever is under it. The nearest `pointerShape` on the node or an ancestor wins. Without one, an `Input` or selectable text shows `"text"` (text inside a clickable does not), and everything else shows `"default"`. Anything drawn on top decides, so an overlay above an `Input` needs `pointerShape: "text"`.

## Components

Props: `packages/pixel/src/react/reconciler-config.ts`. Definitions: `packages/pixel/src/react/components.ts`. Every component takes `ref` → `NodeHandle` (`components.ts:23`): `focus()`, `blur()`, `scrollTo(offset, smooth?)`, `scrollIntoView(smooth?)`, `splice(start, end, text)`, `selectAll()`, `addMark(mark, offset?)`, `removeMark(mark)`.

| component | props (file:line) |
| --- | --- |
| `Box` | `BoxProps` `:78`. `style`, `id`, `hidden`, `onClick(ClickEvent)`, `onClickOutside`, `onPointer(PointerEvent)`, `onMouseEnter`, `onMouseLeave`, `onMouseMove({ x, y })`, `onDrag(DragEvent)`, `onScroll(ScrollEvent)`, `onWheel(WheelEvent)`, `onSelection(ContainerSelection)`, `contentHeight`, `surface: Surface` |
| `Text` | `TextProps` `:128`. children must be strings or numbers. `spans: { start, end, color, background?, bold?, italic?, underline?, strikethrough? }[]`, `onClick`, `onMouseEnter`, `onMouseLeave` |
| `Input` | `InputProps` `:177`. multi-line editor; with `style.wrap: false` it is single-line and its text is vertically centered when the box is taller than one line. `value`, `defaultValue`, `autoFocus`, `onChange(text, ChangeInfo)`, `onSubmit(text, marks)`, `onCaret(CaretInfo)`, `onPasteImage`, `caretColor`, `selectionColor`, `spans`, `gutter: { color, activeColor }`, `activeLine`, `defaultMarks`, `renderMark(id)`, `serializeMark(id)` |
| `Image` | `ImageProps` `:211`. `src` path or url, `placeholder`, `error`, `onClick` |
| `Path` | `PathProps` `:104`. SVG path data. `d`, `viewBox`, `stroke: { width, color, cap?, join? }`, `onClick`, `onDrag` |
| `MarkedText` | `MarkedTextProps` `:197`. `text`, `marks`, `renderMark`, `serializeMark` |
| `Link` | `packages/pixel/src/react/link.tsx`. `href`, `children`, `style`, `onClick(ClickEvent)`. Opens `href` in the default browser on click (`onClick` replaces that), shows the pointer cursor on hover. String children render as `Text` with `style`; use `style.hoverColor` for a hover state |
| `Markdown` | `packages/pixel/src/react/markdown.tsx:25`. `text`, `theme: MarkdownTheme`, `rem`, `streaming`, `codeFamily` (code blocks, default `"monospace"`), `onLinkClick(href)`, `highlight`, `highlightBg` |
| `WebView` | see WebView |
| `DevTools` | `packages/pixel/src/devtools.tsx:100`. `target: RefObject<WebViewHandle> \| WebViewHandle`, `dock: "bottom" \| "right"`, `panel`, `onAction("close" \| "dock-bottom" \| "dock-right")`, `style`, `keepFrame` |

### Events

`packages/pixel/src/react/reconciler-config.ts`

```ts
ClickEvent   { x, y, offset? }                                           // :11
ScrollEvent  { offset, max }                                             // :17
WheelEvent   { x, y, deltaX, deltaY, precise, mods }                     // :29
PointerEvent { kind: "down" | "up" | "move", button: "left" | "middle" | "right" | "none", mods, x, y } // :38
DragEvent    { phase: "start" | "move" | "end", x, y, mods }             // :51
PastedImage  { path, width, height, source: "clipboard" | "osc" | "file" } // :150
```

Coordinates are pixels relative to the element.

### Keys

`packages/pixel/src/react/index.ts:156`

```ts
EngineKeyEvent { key: string; kind: "press" | "repeat" | "release"; text?: string; mods: KeyMods }
KeyMods        { shift: boolean; alt: boolean; ctrl: boolean; super: boolean }
```

- Key names are lowercase: `"c"`, `"enter"`, `"escape"`, `"backspace"`, `"tab"`, `"up"`, `"f12"`.
- Keys go to `RootOptions.onKey` first, then the focused `Input` or `WebView`.
- There is no per-component key handler.

### Surface

`packages/pixel/src/react/surface.ts:15`

| member | what it does |
| --- | --- |
| `present({ bgra, width, height, damage? })` | shows a BGRA frame; `damage` rects limit what is sent |
| `present({ ioSurface } \| { shm }, ...)` | shows a shared texture frame |
| `clear()` | clears the surface |
| `startCapture(dir): SurfaceCapture` | records frames to `dir` |
| `close()` | releases the surface |

## WebView

`packages/pixel/src/webview.tsx`

### WebViewProps (`:48`)

| prop | what it does |
| --- | --- |
| `src: string` | url to load |
| `style` | layout style |
| `preload` | preload script path |
| `partition` | session name, made persistent |
| `proxy` | proxy rules, e.g. `socks5://127.0.0.1:1080` |
| `clipboardRead` | allows the page to read the clipboard |
| `browserWindowOptions` | Electron `BrowserWindow` options except size and offscreen flags |
| `autoFocus` | focuses on mount |
| `devtools: boolean \| "bottom" \| "right"` | opens Chrome DevTools |
| `hidden` | hides without unloading |
| `keepFrame` | keeps the last frame while hidden |
| `onChange(state: WebViewState)` | navigation and page state changes |
| `onPointer(event)` | pointer events over the page |
| `onContextMenu(params)` | right click in the page, Electron `ContextMenuParams` |
| `onOpenWindow: OpenWindowPolicy` | `"popup" \| "deny" \| "navigate"` or a function returning one |
| `onDownload(progress: DownloadProgress)` | `{ name, savePath, received, total, state }` |

Defaults: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`. `defaultOpenWindow` (`web/host.ts:25`) returns `"popup"` for new windows, else `"navigate"`.

### WebViewState (`packages/pixel/src/web/types.ts:5`)

`{ url, title, loading, canGoBack, canGoForward, findMatches: { active, total } | null, zoom, favicon: string | null }`

### WebViewHandle (`:67`)

| member | what it does |
| --- | --- |
| `webContents` | Electron `WebContents` |
| `state` | current `WebViewState` |
| `onChange(listener): () => void` | subscribes to state changes |
| `loadURL(url)` | navigates |
| `back()`, `forward()`, `reload()` | history navigation |
| `focus()`, `blur()` | keyboard focus |
| `zoom(1 \| -1 \| 0): number` | zoom in, out, reset; returns zoom level |
| `find(text)`, `findNext(forward)`, `stopFind()` | find in page |
| `cdp(method, params?)` | sends a Chrome DevTools Protocol command |
| `openDevtools()`, `closeDevtools()` | Chrome DevTools |
| `closePopup()` | closes the open popup |
| `recording: WebViewRecording` | `start(dir)`, `onFrame(listener)`, `frameSize()`, `pinFrameRate(pinned)`, `invalidate()` (`:88`) |

### Page API

`packages/pixel/src/preload/index.ts`. Injected into every page as `window.pixel`:

```ts
pixel.theme(): TerminalTheme           // { background, foreground, ansi }
pixel.onTheme(cb): () => void          // subscribe to theme changes
pixel.quit(): void                     // same as navigating to pixel://quit
```

## Hooks and helpers

| export | file:line | what it does |
| --- | --- | --- |
| `useTerminalColors(): TerminalColors` | `react/colors.ts:27` | `{ foreground, background, palette }`, updates live |
| `makeTheme(colors): Theme` | `theme.ts:36` | UI palette from terminal colors: `bg fg muted disabled accent field fieldBorder hover hoverStrong hairline selection red green yellow magenta cyan` |
| `useRect(ref): Rect \| null` | `layout.ts:11` | laid out `{ x, y, width, height }` of a node |
| `useStore(store)` | `react/devtools/store.ts:30` | subscribes to a `{ get, set, update, subscribe }` store |
| `setClipboard(text)` | `react/index.ts:150` | copies via OSC 52 |
| `requestClipboardImage()` | `react/index.ts:144` | requests a clipboard image |
| `highlight(source, language): HighlightSpan[]` | `react/native.ts:205` | tree-sitter spans `{ start, end, capture }`; capture indexes `HIGHLIGHT_CAPTURES` |
| `diff(old, new, contextLines?): DiffRow[]` | `react/native.ts:211` | line diff with word emphasis |
| `parseMarkdown(source, streaming?): MarkdownBlock[]` | `react/native.ts:238` | markdown blocks |
| `captureFilmstrip(dir, frames, tileWidth, width, height)` | `react/native.ts:228` | image strip from recorded frames |
| `encodeRecording(jobJson, onProgress?)` | `react/native.ts:215` | encodes recorded frames to video |
| `appLog(level, target, text)` | `react/index.ts:52` | writes to the devtools log panel |
| `engineLogs` | `react/devtools/stores.ts:6` | engine log store |
| `listInstances(env?): Instance[]` | `instances.ts:66` | running pixel apps |
| `findOwner(tty, env?): Instance \| null` | `instances.ts:88` | the app that owns a tty |
| `QUIT_URL` | `web/host.ts:20` | `"pixel://quit"` |

## @zenbu-labs/pixel/ssh

`packages/pixel/src/ssh/index.ts`

| export | line | what it does |
| --- | --- | --- |
| `connectSsh({ target, bundle?, remoteBase?, status? }): Promise<SshSession>` | `:209` | opens a SOCKS tunnel, optionally uploads and starts a bundle |
| `SshSession` | `:201` | `{ destination, socksPort, url, view: { proxy, partition }, stop() }` |
| `openSshTunnel(target, status, options?)` | `:137` | `ssh -f -N -M -D` tunnel, returns `SshTunnel` |
| `startBundle(tunnel, dir, options)` | `:279` | uploads `dir` once per content hash, runs its `start` script, waits for `READY <url>` |
| `socksProxyRules(tunnel)` | `:247` | `socks5://127.0.0.1:<port>` |
| `parseSshTarget`, `resolveSshTarget`, `validateSshTarget` | `:27`, `:43`, `:60` | parse and validate `user@host[:port]` |
| `validateBundleDir(dir)` | `:251` | checks for an executable `start` script |
| `REMOTE_BUNDLES_DIR` | `:272` | remote bundle location |

Usage: `<WebView src={session.url} {...session.view} />`. Example: `examples/ssh`.

## @zenbu-labs/pixel/terminal

`packages/pixel/src/terminal/index.ts`

| export | what it does |
| --- | --- |
| `detect(env?, run?): Terminal \| null` | detects herdr, tmux, tty7, wezterm, kitty, cmux, supacode, ghostty, vscode, in that order |
| `checkTerminal(terminal, env?): Promise<{ terminal, graphics }>` | detection plus kitty graphics probe |
| `probeGraphics(terminal)` | kitty graphics query with a 500ms timeout |
| `canSplit(terminal)` | whether the terminal implements `split` |
| `cannotOpenPanes(terminal)` | user facing message when it cannot |
| `GRAPHICS_SKIP_ENV` | `"PIXEL_SKIP_GRAPHICS_CHECK"` |
| `shellIn(env): Run` | runs a command in a login shell |
| `bracketedPaste(text)`, `shellLiteral(text)`, `PASTE_KEY` | text helpers for `sendText` |
| `callerTty()` | `{ path, denied }` for the calling process |
| `listInstances`, `findOwner`, `EMBED_PROTOCOL` | instance records |

`Terminal` interface (`packages/pixel/src/terminal/terminal.ts:34`). Every method is optional:

```ts
name; wrapper?: "tmux"; reportsCssPixels?;
prepare?(); getCurrentPane?(ctx): Promise<Pane | null>; split?(req: SplitRequest);
listPanes?(opts?): Promise<PaneDetails[]>; neighbor?(from, direction): Promise<Pane | null>;
sendText?(pane, text); pasteKey?(pane); focusPane?(pane);
SplitRequest { from: Pane; direction: "right" | "left" | "down" | "up"; command: string[]; size: number | null; tty: string | null } // :25
```

Implementations: `packages/pixel/src/terminal/terminals/*.ts`, registered in `terminals/index.ts`. Terminals can also implement the same methods over a unix socket: `../README.md#implementing-the-api-in-your-terminal`, client in `../shared/src/terminal-socket.ts`.

## Same-pane tabs

`packages/pixel/src/host/`

- The first pixel app on a tty owns it. It writes an instance record and listens on a unix socket.
- A later `pixel` launch on the same tty joins the owner as a guest tab.
- alt+1..9 selects a tab. alt+[ and alt+] cycle tabs.
- When the owner exits, a guest takes over the tty.
- `root.hosted` is true for guests.

## Embedding in a TUI

`packages/pixel/src/host/server.ts` (`GuestMessage` at `:24`), env handling in `packages/pixel/src/root.tsx:117`. Reference hosts: `examples/tui-host-ts/src/host.ts`, `examples/tui-host/host.py`.

The host starts the app with:
- `PIXEL_EMBED=<socket path>`
- `PIXEL_TTY=<host tty>`
- `PIXEL_PANE` unset

Messages are newline delimited JSON over that socket.

```
app  → { type: "join" }
host → { type: "init", cols, rows, width, height, cell: [w, h], imageId, transport: "file" | "inline", focused, colors? }
app  → { type: "placed", imageId, cols, rows }        // host prints U+10EEEE placeholder cells for imageId
app  → { type: "title" | "pointer" | "clipboard", ... }
host → { type: "key", key, kind: "press", mods, text? }
host → { type: "mouse", kind: "down" | "up" | "move" | "scrollup" | "scrolldown", button, mods, x, y }
host → { type: "size" | "paste" | "wheel" | "focus" | "colors" | "devtools", ... }
```

`../claude-code-plugin` uses this path to show pixel frames in a Claude Code pane.

## Rendering

Rust: `engine/crates/pixel-core/src/terminal/present/`. JS side: `packages/pixel/src/web/offscreen.ts`, `packages/pixel/src/web/paint.ts`.

- **Frame capture:** WebView frames arrive as an IOSurface on macOS, or as shared memory on Linux, with Chromium's damage rect.
- **Row diff:** each damaged row is compared with the last shown frame. Only changed spans are kept (`surfaces/mod.rs`, `surfaces/convert.rs`).
- **Merging:** spans merge while the added area is under 30,000 px, up to 32 patches per frame (`present/merge.rs`).
- **Patches:**
  - Placed as kitty images above a base image, from an id pool of 96 (`present/transmit_strategy.rs`).
  - Folded or flattened when idle, on resize, or when out of ids.
- **Transport:** shared memory (`t=s`), then temp files, then inline zlib (`t=d`, `o=z`). Over ssh it is inline.
- **Atomic frames:** each frame is wrapped in synchronized output (`CSI ?2026h/l`).
- **Patched mode:** used on Ghostty 1.2+ and kitty. Other terminals and tmux get full frames.
- **tmux:** DCS passthrough plus unicode placeholders.
- **herdr:** full frames over the herdr graphics socket (`engine/crates/pixel-core/src/herdr.rs`).
