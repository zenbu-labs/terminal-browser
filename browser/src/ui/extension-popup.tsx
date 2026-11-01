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
const OVERFLOW_POLL_MS = 100;
const RESIZE_FRAME_TIMEOUT_MS = 300;
// A private script world, so the page can't see or tamper with the measurement.
const MEASURE_WORLD = 1999;
// Viewport, scroll extents, and the content's own extent (the body's right edge
// with its margin, and the root's height) for noticing when the page shrank.
const MEASURE = `(() => {
  const root = document.documentElement;
  const body = document.body;
  const right = body ? body.getBoundingClientRect().right + parseFloat(getComputedStyle(body).marginRight) : innerWidth;
  return [innerWidth, innerHeight, root.clientWidth, root.clientHeight, root.scrollWidth, root.scrollHeight, right, root.getBoundingClientRect().height];
})()`;
// Shrinking by less than this is ignored, so the spare pixel below can't flip-flop.
const SHRINK_SLACK = 2;

// Marked transparent so nothing is painted under the page; the page itself still
// starts white like Chrome's.
const WHITE_PAGE = { transparent: true, backgroundColor: "#ffffff" };
const POPUP_WINDOW = { ...WHITE_PAGE, webPreferences: { enablePreferredSizeMode: true } };

// Pages keep square corners, like Chrome's popup windows, so they're inset far
// enough that the card's rounded corner (and its anti-aliasing) never cuts them.
function pageInset(radius: number, scale: number): number {
  const cornerCss = Math.ceil((radius / scale) * (1 - Math.SQRT1_2)) + 1;
  return Math.ceil(cornerCss * scale);
}

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
      const [innerWidth, innerHeight, clientWidth, clientHeight, scrollWidth, scrollHeight, contentWidth, contentHeight] = measured;
      return { innerWidth, innerHeight, clientWidth, clientHeight, scrollWidth, scrollHeight, contentWidth, contentHeight };
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
    // Chromium doesn't always report size changes after the first layout (e.g.
    // the popup's script adding or removing UI), so the page is checked directly.
    const overflow = async () => {
      const now = await measure();
      if (!now) return;
      if (now.scrollWidth <= now.clientWidth && now.scrollHeight <= now.clientHeight) {
        const width = Math.ceil(now.contentWidth);
        const height = Math.ceil(now.contentHeight);
        const narrower = now.innerWidth - width > SHRINK_SLACK;
        const shorter = now.innerHeight - height > SHRINK_SLACK;
        if (narrower || shorter) {
          setSize((prev) =>
            prev ? { width: narrower ? width : prev.width, height: shorter ? height : prev.height } : prev,
          );
        }
        return;
      }
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

// The size the card shows. When the page grows, its view is relaid out and
// repainted a moment later; until a frame at the new size is presented the card
// keeps the old size, so it never shows empty space beside the page.
function useShownSize(view: RefObject<WebViewHandle | null>, painted: boolean, size: Size): Size {
  const [shown, setShown] = useState<Size | null>(null);
  const settled = shown !== null && shown.width === size.width && shown.height === size.height;
  useEffect(() => {
    const handle = view.current;
    if (!painted || settled || !handle) return;
    const sized = () => {
      const frame = handle.recording.frameSize();
      return !!frame && Math.abs(frame.width - size.width) <= 1 && Math.abs(frame.height - size.height) <= 1;
    };
    if (sized() || shown === null) {
      setShown(size);
      return;
    }
    const stop = handle.recording.onFrame(() => {
      if (sized()) setShown(size);
    });
    const fallback = setTimeout(() => setShown(size), RESIZE_FRAME_TIMEOUT_MS);
    return () => {
      stop();
      clearTimeout(fallback);
    };
  }, [painted, settled, size.width, size.height]);
  // Shrinking right away is safe: the page's top-left is what stays visible.
  return shown ? { width: Math.min(shown.width, size.width), height: Math.min(shown.height, size.height) } : size;
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

const CLOSE_LINGER_MS = 80;

type PopupProps = {
  anchor: RefObject<NodeHandle | null>;
  scale: number;
  layout: ChromeLayout;
  theme: Theme;
  actions: ExtensionActions;
};

// A closed popup's card is hidden first and its page torn down a moment later;
// tearing the page down removes its picture before the card, which would
// otherwise flash an empty card for a frame.
export function ActionPopups({ popup, ...props }: PopupProps & { popup: ExtensionPopupView | null }) {
  const [leaving, setLeaving] = useState<ExtensionPopupView | null>(null);
  const previous = useRef(popup);
  if (previous.current && previous.current.key !== popup?.key && leaving?.key !== previous.current.key) {
    setLeaving(previous.current);
  }
  previous.current = popup;
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(null), CLOSE_LINGER_MS);
    return () => clearTimeout(timer);
  }, [leaving]);
  return (
    <>
      {leaving && <ActionPopup key={leaving.key} popup={leaving} closing {...props} />}
      {popup && <ActionPopup key={popup.key} popup={popup} closing={false} {...props} />}
    </>
  );
}

function ActionPopup({
  popup,
  closing,
  anchor,
  scale,
  layout,
  theme,
  actions,
}: PopupProps & { popup: ExtensionPopupView; closing: boolean }) {
  const rem = layout.rem;
  const view = useRef<WebViewHandle>(null);
  const anchorRect = useRect(anchor);
  const size = usePreferredSize(view, actions.popupMounted);
  const ready = size !== null && anchorRect !== null;
  useEffect(() => {
    if (ready) view.current?.focus();
  }, [ready]);
  const margin = Math.round(rem * 0.4);
  const radius = Math.round(rem * 0.6);
  const inset = pageInset(radius, scale);
  const top = Math.round((anchorRect ? anchorRect.y + anchorRect.height : layout.toolbarHeight) + rem * 0.2);
  const css = size ?? POPUP_MIN;
  // Sized in whole CSS pixels so the page's viewport is exactly what it asked for.
  const cssWidth = Math.min(clamp(css.width, POPUP_MIN.width, POPUP_MAX.width), Math.floor((layout.width - margin * 2 - inset * 2) / scale));
  const cssHeight = Math.min(clamp(css.height, POPUP_MIN.height, POPUP_MAX.height), Math.floor((layout.height - top - margin - inset * 2) / scale));
  const width = Math.ceil(cssWidth * scale);
  const height = Math.ceil(cssHeight * scale);
  const painted = useContentShown(view, ready, { width, height });
  const shown = useShownSize(view, painted, { width, height });
  const visible = painted && !closing;
  const cardWidth = shown.width + inset * 2;
  const cardHeight = shown.height + inset * 2;
  const anchorRight = anchorRect ? anchorRect.x + anchorRect.width : layout.width - margin;
  const left = Math.round(clamp(anchorRight - cardWidth, margin, layout.width - cardWidth - margin));
  return (
    <>
      {visible && <Shadow x={left} y={top} width={cardWidth} height={cardHeight} radius={radius} rem={rem} />}
      <Box
        style={{
          position: "absolute",
          inset: { top, left },
          // Zero-sized (but still laid out inside) until there's something to show.
          width: visible ? cardWidth : 0,
          height: visible ? cardHeight : 0,
          cornerRadius: radius,
          // Only the band around the page is painted, so nothing shows if the page goes first.
          border: { width: inset, color: theme.overlay },
          overflow: "hidden",
        }}
        onClickOutside={closing ? undefined : actions.popupClose}
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
          style={{ position: "absolute", inset: { top: inset, left: inset }, width, height }}
        />
      </Box>
      {visible && <Outline x={left} y={top} width={cardWidth} height={cardHeight} radius={radius} theme={theme} />}
    </>
  );
}

// The card's faint edge, drawn last so it stays on top.
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
  const radius = Math.round(rem * 0.5);
  const inset = pageInset(radius, scale);
  const pageWidth = Math.min(Math.round((entry.width ?? DEFAULT_WINDOW.width) * scale), Math.round(page.width * 0.94) - inset * 2);
  const bodyH = Math.min(Math.round((entry.height ?? DEFAULT_WINDOW.height) * scale), Math.round(page.height * 0.94) - headerH - inset);
  const width = pageWidth + inset * 2;
  const cardH = headerH + bodyH + inset;
  const offset = Math.round(cascade * rem * 1.5);
  const centered = {
    x: page.x + Math.round((page.width - width) / 2) + offset,
    y: page.y + Math.max(Math.round(rem * 0.5), Math.round((page.height - cardH) / 2)) + offset,
  };
  const at = moved ?? centered;
  const left = clamp(at.x, 0, layout.width - width);
  const top = clamp(at.y, layout.toolbarHeight, Math.max(layout.toolbarHeight, layout.height - cardH));
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
          background: theme.overlay,
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
          browserWindowOptions={WHITE_PAGE}
          style={{ width: pageWidth, height: bodyH, margin: { left: inset }, flexShrink: 0 }}
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
