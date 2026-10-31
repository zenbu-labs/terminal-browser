import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { Box, Text, WebView, useRect } from "@zenbu-labs/pixel";
import type { DragEvent, NodeHandle, Rgba, WebViewHandle } from "@zenbu-labs/pixel";
import { Icon } from "./icons";
import { mix } from "./theme";
import type { Theme } from "./theme";
import type { ExtensionActions, ExtensionPopupView, ExtensionPopupWindowView } from "./extension-types";
import type { ChromeLayout } from "./types";

// Chrome's bounds for an action popup, in CSS pixels.
const POPUP_MIN = { width: 25, height: 25 };
const POPUP_MAX = { width: 800, height: 600 };
const FIRST_SIZE_TIMEOUT_MS = 1500;
const FIRST_FRAME_TIMEOUT_MS = 400;
const CONTENT_POLL_MS = 50;
const CONTENT_TIMEOUT_MS = 1500;
// Loaded, laid out, and visibly showing text, an image, a control or a frame.
const HAS_CONTENT = `(() => {
  const body = document.body;
  if (document.readyState === "loading" || !body) return false;
  const box = body.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return false;
  const shown = (element) => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const media = [...body.querySelectorAll("img, svg, canvas, video, input, button, select, textarea, iframe")];
  const text = [...body.querySelectorAll("*")].filter((element) =>
    [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim()),
  );
  if (!media.some(shown) && !text.some(shown)) return false;
  // Let a one-off entrance animation (a fade-in) finish; endless spinners don't count.
  return !document.getAnimations().some(
    (animation) => animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity,
  );
})()`;
const OVERFLOW_POLL_MS = 250;
// A private script world, so the page can't see or tamper with the measurement.
const MEASURE_WORLD = 1999;
const MEASURE =
  "[innerWidth, innerHeight, document.documentElement.clientWidth, document.documentElement.clientHeight, document.documentElement.scrollWidth, document.documentElement.scrollHeight]";

// Marked transparent so nothing is painted under the page and its clipped corners
// blend straight into what's behind the card; the page itself still starts white.
const CLIPPED_PAGE = { transparent: true, backgroundColor: "#ffffff" };
const POPUP_WINDOW = { ...CLIPPED_PAGE, webPreferences: { enablePreferredSizeMode: true } };

export function hairline(theme: Theme): Rgba {
  const [r, g, b] = theme.overlay;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? [255, 255, 255, 20] : [0, 0, 0, 31];
}

export const ignoreContextMenu = () => {};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

type Size = { width: number; height: number };

function usePreferredSize(view: RefObject<WebViewHandle | null>, mounted: (contents: Electron.WebContents) => void): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  useEffect(() => {
    const contents = view.current?.webContents;
    if (!contents) return;
    mounted(contents);
    const apply = (width: number, height: number) =>
      setSize((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
    const measure = async () => {
      if (contents.isDestroyed()) return null;
      const measured = (await contents
        .executeJavaScriptInIsolatedWorld(MEASURE_WORLD, [{ code: MEASURE }])
        .catch(() => null)) as number[] | null;
      if (!measured) return null;
      const [innerWidth, innerHeight, clientWidth, clientHeight, scrollWidth, scrollHeight] = measured;
      return { innerWidth, innerHeight, clientWidth, clientHeight, scrollWidth, scrollHeight };
    };
    // A size reported while the page scrolls vertically counts the scrollbar,
    // which goes away once the popup is tall enough, so it's left out.
    const changed = async (_event: unknown, next: Size) => {
      const now = await measure();
      if (now && now.scrollHeight > now.innerHeight) {
        apply(next.width - (now.innerWidth - now.clientWidth), Math.max(next.height, now.scrollHeight));
      } else {
        apply(next.width, next.height);
      }
    };
    // Chromium doesn't always report growth that happens after the first layout
    // (e.g. the popup's script adding UI), so overflow is checked directly too.
    const overflow = async () => {
      const now = await measure();
      if (!now || (now.scrollWidth <= now.clientWidth && now.scrollHeight <= now.clientHeight)) return;
      // Content that exactly fills the popup can keep both scrollbars alive
      // (each one causes the other's overflow); one spare pixel breaks that.
      const needed = (content: number, viewport: number) => (content >= viewport ? content + (content === viewport ? 1 : 0) : 0);
      setSize((prev) => {
        const width = Math.max(prev?.width ?? 0, needed(now.scrollWidth, now.innerWidth));
        const height = Math.max(prev?.height ?? 0, needed(now.scrollHeight, now.innerHeight));
        return prev && prev.width === width && prev.height === height ? prev : { width, height };
      });
    };
    const onPreferred = (event: unknown, next: Size) => void changed(event, next);
    contents.on("preferred-size-changed", onPreferred);
    const poll = setInterval(() => void overflow(), OVERFLOW_POLL_MS);
    const fallback = setTimeout(() => setSize((prev) => prev ?? POPUP_MIN), FIRST_SIZE_TIMEOUT_MS);
    return () => {
      clearTimeout(fallback);
      clearInterval(poll);
      if (!contents.isDestroyed()) contents.off("preferred-size-changed", onPreferred);
    };
  }, []);
  return size;
}

// True once the page has drawn real content at its popup size, so the card never
// flashes an empty box while a script-built popup is still starting up.
function useContentShown(view: RefObject<WebViewHandle | null>, ready: boolean, size: Size): boolean {
  const [hasContent, setHasContent] = useState(false);
  const [painted, setPainted] = useState(false);
  useEffect(() => {
    const contents = view.current?.webContents;
    if (!ready || hasContent || !contents) return;
    const check = async () => {
      if (contents.isDestroyed()) return;
      const found = await contents.executeJavaScriptInIsolatedWorld(MEASURE_WORLD, [{ code: HAS_CONTENT }]).catch(() => false);
      if (found) setHasContent(true);
    };
    void check();
    const poll = setInterval(() => void check(), CONTENT_POLL_MS);
    const fallback = setTimeout(() => setHasContent(true), CONTENT_TIMEOUT_MS);
    return () => {
      clearInterval(poll);
      clearTimeout(fallback);
    };
  }, [ready, hasContent]);
  useEffect(() => {
    const handle = view.current;
    if (!hasContent || painted || !handle) return;
    // A frame left over from before the popup was sized would show shrunken.
    const sized = () => {
      const frame = handle.recording.frameSize();
      return !!frame && Math.abs(frame.width - size.width) <= 1 && Math.abs(frame.height - size.height) <= 1;
    };
    if (sized()) {
      setPainted(true);
      return;
    }
    const stop = handle.recording.onFrame(() => {
      if (sized()) setPainted(true);
    });
    handle.recording.invalidate();
    const fallback = setTimeout(() => setPainted(true), FIRST_FRAME_TIMEOUT_MS);
    return () => {
      stop();
      clearTimeout(fallback);
    };
  }, [hasContent, painted, size.width, size.height]);
  return painted;
}

export function Shadow({
  x,
  y,
  width,
  height,
  radius,
  rem,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  rem: number;
}) {
  const layers = [0.8, 0.62, 0.47, 0.34, 0.23, 0.14, 0.07].map((step) => ({
    spread: rem * step,
    drop: rem * (0.12 + step * 0.35),
    alpha: 7,
  }));
  return (
    <>
      {layers.map((layer) => (
        <Box
          key={layer.spread}
          style={{
            position: "absolute",
            inset: { top: Math.round(y - layer.spread + layer.drop), left: Math.round(x - layer.spread) },
            width: Math.round(width + layer.spread * 2),
            height: Math.round(height + layer.spread * 2),
            cornerRadius: radius + layer.spread,
            background: [0, 0, 0, layer.alpha],
          }}
        />
      ))}
    </>
  );
}

export function ActionPopup({
  popup,
  anchor,
  scale,
  layout,
  theme,
  actions,
}: {
  popup: ExtensionPopupView;
  anchor: RefObject<NodeHandle | null>;
  scale: number;
  layout: ChromeLayout;
  theme: Theme;
  actions: ExtensionActions;
}) {
  const rem = layout.rem;
  const view = useRef<WebViewHandle>(null);
  const anchorRect = useRect(anchor);
  const size = usePreferredSize(view, actions.popupMounted);
  const ready = size !== null && anchorRect !== null;
  useEffect(() => {
    if (ready) view.current?.focus();
  }, [ready]);
  const margin = Math.round(rem * 0.4);
  const top = Math.round((anchorRect ? anchorRect.y + anchorRect.height : layout.toolbarHeight) + rem * 0.2);
  const css = size ?? POPUP_MIN;
  // Sized in whole CSS pixels so the page's viewport is exactly what it asked for.
  const cssWidth = Math.min(clamp(css.width, POPUP_MIN.width, POPUP_MAX.width), Math.floor((layout.width - margin * 2) / scale));
  const cssHeight = Math.min(clamp(css.height, POPUP_MIN.height, POPUP_MAX.height), Math.floor((layout.height - top - margin) / scale));
  const width = Math.ceil(cssWidth * scale);
  const height = Math.ceil(cssHeight * scale);
  const painted = useContentShown(view, ready, { width, height });
  const anchorRight = anchorRect ? anchorRect.x + anchorRect.width : layout.width - margin;
  const left = Math.round(clamp(anchorRight - width, margin, layout.width - width - margin));
  const radius = Math.round(rem * 0.6);
  return (
    <>
      {painted && <Shadow x={left} y={top} width={width} height={height} radius={radius} rem={rem} />}
      <Box
        style={{
          position: "absolute",
          inset: { top, left },
          // Zero-sized (but still laid out inside) until there's something to show.
          width: painted ? width : 0,
          height: painted ? height : 0,
          cornerRadius: radius,
          overflow: "hidden",
        }}
        onClickOutside={actions.popupClose}
      >
        <WebView
          key={popup.key}
          ref={view}
          src={popup.url}
          hidden={!ready}
          autoFocus={false}
          devtools={false}
          browserWindowOptions={POPUP_WINDOW}
          onOpenWindow={actions.openWindow}
          onContextMenu={ignoreContextMenu}
          style={{
            position: "absolute",
            inset: { top: 0, left: 0 },
            width,
            height,
            cornerRadius: radius,
          }}
        />
      </Box>
      {painted && <Outline x={left} y={top} width={width} height={height} radius={radius} theme={theme} />}
    </>
  );
}

// Drawn over the page so the hairline sits on top of the page's rounded corners.
function Outline({
  x,
  y,
  width,
  height,
  radius,
  theme,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  theme: Theme;
}) {
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: y, left: x },
        width,
        height,
        cornerRadius: radius,
        border: { width: 1, color: hairline(theme) },
      }}
    />
  );
}

const DEFAULT_WINDOW = { width: 420, height: 560 };

export function PopupWindows({
  windows,
  scale,
  layout,
  theme,
  actions,
}: {
  windows: ExtensionPopupWindowView[];
  scale: number;
  layout: ChromeLayout;
  theme: Theme;
  actions: ExtensionActions;
}) {
  return (
    <>
      {windows.map((entry, index) => (
        <PopupWindow
          key={entry.key}
          entry={entry}
          cascade={index}
          scale={scale}
          layout={layout}
          theme={theme}
          actions={actions}
        />
      ))}
    </>
  );
}

function PopupWindow({
  entry,
  cascade,
  scale,
  layout,
  theme,
  actions,
}: {
  entry: ExtensionPopupWindowView;
  cascade: number;
  scale: number;
  layout: ChromeLayout;
  theme: Theme;
  actions: ExtensionActions;
}) {
  const rem = layout.rem;
  const view = useRef<WebViewHandle>(null);
  const [title, setTitle] = useState("");
  const [moved, setMoved] = useState<{ x: number; y: number } | null>(null);
  const grab = useRef({ dx: 0, dy: 0 });
  useEffect(() => {
    const contents = view.current?.webContents;
    if (contents) actions.popupWindowMounted(entry.windowId, contents);
  }, []);
  const page = layout.page;
  const headerH = Math.round(rem * 1.7);
  const width = Math.min(Math.round((entry.width ?? DEFAULT_WINDOW.width) * scale), Math.round(page.width * 0.94));
  const bodyH = Math.min(Math.round((entry.height ?? DEFAULT_WINDOW.height) * scale), Math.round(page.height * 0.94) - headerH);
  const cardH = headerH + bodyH;
  const offset = Math.round(cascade * rem * 1.5);
  const centered = {
    x: page.x + Math.round((page.width - width) / 2) + offset,
    y: page.y + Math.max(Math.round(rem * 0.5), Math.round((page.height - cardH) / 2)) + offset,
  };
  const at = moved ?? centered;
  const left = clamp(at.x, 0, layout.width - width);
  const top = clamp(at.y, layout.toolbarHeight, Math.max(layout.toolbarHeight, layout.height - cardH));
  const radius = Math.round(rem * 0.5);
  const bottomCorners = { topLeft: 0, topRight: 0, bottomLeft: radius, bottomRight: radius };
  const drag =(event: DragEvent) => {
    if (event.phase === "start") grab.current = { dx: event.x - left, dy: event.y - top };
    else setMoved({ x: event.x - grab.current.dx, y: event.y - grab.current.dy });
  };
  return (
    <>
      <Shadow x={left} y={top} width={width} height={cardH} radius={radius} rem={rem} />
      <Box
        style={{
          position: "absolute",
          inset: { top, left },
          width,
          height: cardH,
          flexDirection: "column",
          cornerRadius: radius,
          overflow: "hidden",
        }}
      >
        <Box
          style={{
            height: headerH,
            flexShrink: 0,
            alignItems: "center",
            gap: rem * 0.5,
            padding: { left: rem * 0.65, right: rem * 0.35 },
            cornerRadius: { topLeft: radius, topRight: radius, bottomLeft: 0, bottomRight: 0 },
            background: mix(theme.overlay, theme.fg, 0.06),
            border: { bottom: [1, theme.hairline] },
          }}
          onDrag={drag}
        >
          <Text style={{ flexGrow: 1, flexBasis: 0, fontSize: rem * 0.78, wrap: false, ellipsis: true, selectable: false }}>
            {title}
          </Text>
          <Box
            style={{
              width: rem * 1.15,
              height: rem * 1.15,
              alignItems: "center",
              justifyContent: "center",
              cornerRadius: rem * 0.3,
              hoverBackground: theme.hover,
              flexShrink: 0,
            }}
            onClick={() => actions.popupWindowClose(entry.windowId)}
          >
            <Icon icon="close" size={rem * 0.8} color={theme.muted} />
          </Box>
        </Box>
        <WebView
          ref={view}
          src={entry.url}
          autoFocus
          devtools={false}
          browserWindowOptions={CLIPPED_PAGE}
          style={{ width, height: bodyH, cornerRadius: bottomCorners }}
          onOpenWindow={actions.openWindow}
          onContextMenu={ignoreContextMenu}
          onChange={(state) => setTitle(state.title)}
          onPointer={(event) => {
            if (event.kind === "down") actions.popupWindowFocus(entry.windowId);
          }}
        />
      </Box>
      <Outline x={left} y={top} width={width} height={cardH} radius={radius} theme={theme} />
    </>
  );
}
