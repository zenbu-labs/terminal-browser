import { Box, Input, Path, Text } from "@zenbu-labs/pixel";
import type { Rgba, Surface } from "@zenbu-labs/pixel";
import {
  CROP_SCOPES,
  MARKUP_COLORS,
  TOOLS,
  arrowHead,
  bboxOf,
  handlesFor,
  measureText,
  penPathSegments,
  unionRects,
} from "../record/model";
import type { MarkupObject, Rect, Tool, Vec } from "../record/model";
import type { MarkupCanvasView } from "../record/types";
import { ICONS, Icon } from "./icons";
import type { IconName } from "./icons";
import { PopupMenu, ShadeAround } from "./record-widgets";
import { withAlpha } from "./theme";
import type { Theme } from "./theme";
import type { ChromeActions, ChromeLayout } from "./types";


const TEXT_SCRIM: Rgba = [15, 17, 22, 255];
const TEXT_SCRIM_BORDER: Rgba = [96, 102, 114, 255];
const TEXT_SCRIM_PAD_X = 0.35;
const TEXT_SCRIM_PAD_Y = 0.25;
const TEXT_SCRIM_RADIUS = 0.3;

const TOOL_ICONS: Record<Tool, IconName> = {
  select: "cursor",
  pen: "pen",
  arrow: "arrow",
  oval: "oval",
  text: "text",
  crop: "crop",
};

const TOOL_ITEM_REM = 1.82;
const COLOR_ITEM_REM = 1.22;
const TOOLBAR_CHROME_REM = 2.32;
const SHOT_ITEM_REM = 8.9;

export function toolbarSize(rem: number, withShot: boolean): { width: number; height: number } {
  const width =
    TOOLBAR_CHROME_REM +
    TOOLS.length * TOOL_ITEM_REM +
    MARKUP_COLORS.length * COLOR_ITEM_REM +
    (withShot ? SHOT_ITEM_REM : 0);
  return { width: rem * width, height: rem * 2.1 };
}

export function MarkupCanvas({
  view,
  surface,
  actions,
  layout,
  theme,
}: {
  view: MarkupCanvasView;
  surface: Surface;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const toView = (p: Vec): Vec => ({
    x: view.frame.x + p.x * view.scale,
    y: view.frame.y + p.y * view.scale,
  });
  const frameCrop = view.objects.find(
    (object) => object.kind === "crop" && object.scope === "frame",
  );
  const videoCrop = view.objects.find(
    (object) => object.kind === "crop" && object.scope === "video",
  );
  const selected = view.objects.filter((object) => view.selection.includes(object.id));
  return (
    <Box
      id="markup-canvas"
      style={{
        position: "absolute",
        inset: { top: view.rect.y, left: view.rect.x },
        width: view.rect.width,
        height: view.rect.height,
        overflow: "hidden",
      }}
      onDrag={actions.record.canvasDrag}
      onWheel={actions.record.canvasWheel}
      onMouseMove={actions.record.canvasMove}
    >
      <Box
        surface={surface}
        style={{
          position: "absolute",
          inset: { top: view.frame.y, left: view.frame.x },
          width: Math.max(1, view.frame.width),
          height: Math.max(1, view.frame.height),
          cornerRadius: layout.radius,
        }}
      />
      <Box
        style={{
          position: "absolute",
          inset: { top: view.frame.y - layout.frame, left: view.frame.x - layout.frame },
          width: Math.max(1, view.frame.width) + layout.frame * 2,
          height: Math.max(1, view.frame.height) + layout.frame * 2,
          cornerRadius: layout.radius + layout.frame,
          border: { width: layout.frame, color: theme.fieldBorder },
        }}
      />
      {view.objects.map((object) => (
        <MarkupNode
          key={object.id}
          object={object}
          view={view}
          toView={toView}
          hidden={view.editing?.id === object.id}
        />
      ))}
      <RecordedPointer view={view} toView={toView} />
      {videoCrop?.kind === "crop" && <CropShade rect={videoCrop.rect} view={view} toView={toView} />}
      {frameCrop?.kind === "crop" && (
        <CropShade
          rect={frameCrop.rect}
          view={view}
          toView={toView}
          outlineOnly={videoCrop != null}
        />
      )}
      {selected.length === 1 && !view.editing && (
        <Selection object={selected[0]} view={view} toView={toView} theme={theme} />
      )}
      {selected.length > 1 && !view.editing && (
        <GroupOutline objects={selected} view={view} toView={toView} theme={theme} />
      )}
      {view.marquee && <Marquee rect={view.marquee} view={view} toView={toView} theme={theme} />}
      {view.editing && (
        <TextEditor view={view} toView={toView} actions={actions} theme={theme} />
      )}
      {view.flash > 0 && (
        <Box
          style={{
            position: "absolute",
            inset: { top: view.frame.y - 2, left: view.frame.x - 2 },
            width: view.frame.width + 4,
            height: view.frame.height + 4,
            cornerRadius: layout.rem * 0.6,
            border: { width: 3, color: withAlpha(theme.accent, Math.round(255 * view.flash)) },
          }}
        />
      )}
      <Toolbar view={view} actions={actions} layout={layout} theme={theme} />
    </Box>
  );
}

function pathNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

const penPaths = new WeakMap<MarkupObject, { scale: number; box: Rect; d: string }>();

function penPath(
  object: Extract<MarkupObject, { kind: "pen" }>,
  scale: number,
): { box: Rect; d: string } {
  const cached = penPaths.get(object);
  if (cached && cached.scale === scale) return cached;
  const box = bboxOf(object);
  const pad = Math.max(2, object.width * scale);
  const local = (p: Vec) => ({ x: (p.x - box.x) * scale + pad, y: (p.y - box.y) * scale + pad });
  const segments = penPathSegments(object.points);
  let d = `M ${pathNumber(local(segments.move).x)} ${pathNumber(local(segments.move).y)}`;
  for (const curve of segments.curves) {
    const control = local(curve.control);
    const to = local(curve.to);
    d += ` Q ${pathNumber(control.x)} ${pathNumber(control.y)} ${pathNumber(to.x)} ${pathNumber(to.y)}`;
  }
  if (segments.tail) {
    const tail = local(segments.tail);
    d += ` L ${pathNumber(tail.x)} ${pathNumber(tail.y)}`;
  }
  const entry = { scale, box, d };
  penPaths.set(object, entry);
  return entry;
}

function RecordedPointer({
  view,
  toView,
}: {
  view: MarkupCanvasView;
  toView: (p: Vec) => Vec;
}) {
  const frameH = view.frame.height / view.scale;
  const size = Math.max(14, frameH * 0.024);
  return (
    <>
      {view.clickPulses.map((pulse, index) => {
        const center = toView(pulse);
        const radius = size * (0.55 + 1.35 * pulse.progress) * view.scale;
        return (
          <Box
            key={index}
            style={{
              position: "absolute",
              inset: { left: center.x - radius, top: center.y - radius },
              width: radius * 2,
              height: radius * 2,
              cornerRadius: radius,
              background: [245, 165, 36, Math.round((1 - pulse.progress) * 130)],
            }}
          />
        );
      })}
      {view.cursor && <CursorGlyph pos={toView(view.cursor)} size={size * view.scale} />}
      <LinkToast view={view} toView={toView} />
    </>
  );
}

function LinkToast({ view, toView }: { view: MarkupCanvasView; toView: (p: Vec) => Vec }) {
  const toast = view.linkToast;
  if (!toast) return null;
  const frameW = view.frame.width / view.scale;
  const frameH = view.frame.height / view.scale;
  const titlePx = Math.min(26, Math.max(12, frameH * 0.02));
  const maxW = frameW * 0.86;
  let urlPx = titlePx * 1.15;
  const urlW = measureText(toast.url, urlPx).width;
  if (urlW > maxW) urlPx = Math.max(8, (urlPx * maxW) / urlW);
  const pad = titlePx * 0.9;
  const cardW =
    Math.max(measureText(toast.url, urlPx).width, measureText("link opened", titlePx).width) +
    pad * 2;
  const cardH = pad * 1.8 + titlePx * 1.3 + urlPx * 1.3;
  const origin = toView({ x: (frameW - cardW) / 2, y: titlePx * 1.2 });
  const alpha = (value: number) => Math.round(value * toast.fade);
  return (
    <Box
      style={{
        position: "absolute",
        inset: { left: origin.x, top: origin.y },
        width: cardW * view.scale,
        height: cardH * view.scale,
        cornerRadius: titlePx * 0.5 * view.scale,
        background: [16, 18, 24, alpha(225)],
        border: { width: 1, color: [110, 168, 254, alpha(140)] },
        flexDirection: "column",
        justifyContent: "center",
        padding: { left: pad * view.scale, right: pad * view.scale },
        gap: titlePx * 0.3 * view.scale,
      }}
    >
      <Text
        style={{
          fontSize: titlePx * view.scale,
          color: [150, 160, 175, alpha(255)],
          wrap: false,
          selectable: false,
        }}
      >
        Link opened
      </Text>
      <Text
        style={{
          fontSize: urlPx * view.scale,
          color: [235, 238, 245, alpha(255)],
          wrap: false,
          selectable: false,
        }}
      >
        {toast.url}
      </Text>
    </Box>
  );
}

function CursorGlyph({ pos, size }: { pos: Vec; size: number }) {
  const box = size * (24 / 14.5);
  const left = pos.x - (6.5 / 24) * box;
  const top = pos.y - (4.5 / 24) * box;
  const layers: { width: number; color: Rgba }[] = [
    { width: 5, color: [255, 255, 255, 235] },
    { width: 2.4, color: [15, 16, 20, 255] },
  ];
  return (
    <>
      {layers.map((layer, index) => (
        <Path
          key={index}
          d={ICONS.cursor}
          viewBox={24}
          stroke={{ width: layer.width, color: layer.color, cap: "round", join: "round" }}
          style={{ position: "absolute", inset: { left, top }, width: box, height: box }}
        />
      ))}
    </>
  );
}

function MarkupNode({
  object,
  view,
  toView,
  hidden,
}: {
  object: MarkupObject;
  view: MarkupCanvasView;
  toView: (p: Vec) => Vec;
  hidden: boolean;
}) {
  if (hidden) return null;
  const scale = view.scale;
  switch (object.kind) {
    case "pen": {
      if (object.points.length === 0) return null;
      const cached = penPath(object, scale);
      const box = cached.box;
      const origin = toView({ x: box.x, y: box.y });
      const pad = Math.max(2, object.width * scale);
      return (
        <Path
          d={cached.d}
          stroke={{ width: Math.max(1, object.width * scale), color: object.color, cap: "round", join: "round" }}
          style={{
            position: "absolute",
            inset: { top: origin.y - pad, left: origin.x - pad },
            width: box.width * scale + pad * 2,
            height: box.height * scale + pad * 2,
          }}
        />
      );
    }
    case "arrow": {
      const from = toView(object.from);
      const to = toView(object.to);
      const head = arrowHead(from, to, object.width * scale);
      const pad = Math.max(12, object.width * scale * 4);
      const minX = Math.min(from.x, to.x, head.left.x, head.right.x) - pad;
      const minY = Math.min(from.y, to.y, head.left.y, head.right.y) - pad;
      const maxX = Math.max(from.x, to.x, head.left.x, head.right.x) + pad;
      const maxY = Math.max(from.y, to.y, head.left.y, head.right.y) + pad;
      const local = (p: Vec) => `${pathNumber(p.x - minX)} ${pathNumber(p.y - minY)}`;
      const d =
        `M ${local(from)} L ${local(to)}` +
        ` M ${local(to)} L ${local(head.left)}` +
        ` M ${local(to)} L ${local(head.right)}`;
      return (
        <Path
          d={d}
          stroke={{ width: Math.max(1, object.width * scale), color: object.color, cap: "round", join: "round" }}
          style={{
            position: "absolute",
            inset: { top: minY, left: minX },
            width: maxX - minX,
            height: maxY - minY,
          }}
        />
      );
    }
    case "oval": {
      if (object.rect.width < 1 || object.rect.height < 1) return null;
      const origin = toView({ x: object.rect.x, y: object.rect.y });
      const pad = Math.max(2, object.width * scale);
      const rx = (object.rect.width * scale) / 2;
      const ry = (object.rect.height * scale) / 2;
      const cx = rx + pad;
      const cy = ry + pad;
      const k = 0.5523;
      const n = pathNumber;
      const d =
        `M ${n(cx + rx)} ${n(cy)}` +
        ` C ${n(cx + rx)} ${n(cy + k * ry)} ${n(cx + k * rx)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)}` +
        ` C ${n(cx - k * rx)} ${n(cy + ry)} ${n(cx - rx)} ${n(cy + k * ry)} ${n(cx - rx)} ${n(cy)}` +
        ` C ${n(cx - rx)} ${n(cy - k * ry)} ${n(cx - k * rx)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)}` +
        ` C ${n(cx + k * rx)} ${n(cy - ry)} ${n(cx + rx)} ${n(cy - k * ry)} ${n(cx + rx)} ${n(cy)} Z`;
      return (
        <Path
          d={d}
          stroke={{ width: Math.max(1, object.width * scale), color: object.color, cap: "round", join: "round" }}
          style={{
            position: "absolute",
            inset: { top: origin.y - pad, left: origin.x - pad },
            width: rx * 2 + pad * 2,
            height: ry * 2 + pad * 2,
          }}
        />
      );
    }
    case "text": {
      if (!object.text) return null;
      const pos = toView(object.pos);
      const size = measureText(object.text, object.fontPx);
      const padX = object.fontPx * TEXT_SCRIM_PAD_X * scale;
      const padY = object.fontPx * TEXT_SCRIM_PAD_Y * scale;
      return (
        <>
          <Box
            style={{
              position: "absolute",
              inset: { top: pos.y - padY, left: pos.x - padX },
              width: size.width * scale + padX * 2,
              height: size.height * scale + padY * 2,
              cornerRadius: object.fontPx * TEXT_SCRIM_RADIUS * scale,
              background: TEXT_SCRIM,
              border: { width: 1, color: TEXT_SCRIM_BORDER },
            }}
          />
          <Text
            style={{
              position: "absolute",
              inset: { top: pos.y, left: pos.x },
              fontSize: object.fontPx * scale,
              color: object.color,
              wrap: false,
              selectable: false,
            }}
          >
            {object.text}
          </Text>
        </>
      );
    }
    case "crop":
      return null;
  }
}

function CropShade({
  rect,
  view,
  toView,
  outlineOnly = false,
}: {
  rect: Rect;
  view: MarkupCanvasView;
  toView: (p: Vec) => Vec;
  outlineOnly?: boolean;
}) {
  const origin = toView({ x: rect.x, y: rect.y });
  const cropView = {
    x: origin.x,
    y: origin.y,
    width: rect.width * view.scale,
    height: rect.height * view.scale,
  };
  return (
    <>
      {!outlineOnly && (
        <ShadeAround
          rect={cropView}
          width={view.rect.width}
          height={view.rect.height}
          shade={[0, 0, 0, 120]}
        />
      )}
      <Box
        style={{
          position: "absolute",
          inset: { top: cropView.y, left: cropView.x },
          width: cropView.width,
          height: cropView.height,
          border: { width: 1, color: [255, 255, 255, 230] },
        }}
      />
    </>
  );
}

function Selection({
  object,
  view,
  toView,
  theme,
}: {
  object: MarkupObject;
  view: MarkupCanvasView;
  toView: (p: Vec) => Vec;
  theme: Theme;
}) {
  const handles = handlesFor(object).map((handle) => ({
    id: handle.id,
    pos: toView(handle.pos),
  }));
  const outline = (() => {
    if (object.kind === "arrow") return null;
    const box = bboxOf(object);
    const origin = toView({ x: box.x, y: box.y });
    return {
      x: origin.x - 2,
      y: origin.y - 2,
      width: box.width * view.scale + 4,
      height: box.height * view.scale + 4,
    };
  })();
  const size = object.kind === "arrow" ? 10 : 8;
  return (
    <>
      {outline && (
        <Box
          style={{
            position: "absolute",
            inset: { top: outline.y, left: outline.x },
            width: outline.width,
            height: outline.height,
            border: { width: 1, color: theme.accent },
          }}
        />
      )}
      {handles.map((handle) => (
        <Box
          key={handle.id}
          style={{
            position: "absolute",
            inset: { top: handle.pos.y - size / 2, left: handle.pos.x - size / 2 },
            width: size,
            height: size,
            cornerRadius: object.kind === "arrow" ? size / 2 : 2,
            background: [255, 255, 255, 255],
            border: { width: 1, color: theme.accent },
          }}
        />
      ))}
    </>
  );
}

function GroupOutline({
  objects,
  view,
  toView,
  theme,
}: {
  objects: MarkupObject[];
  view: MarkupCanvasView;
  toView: (p: Vec) => Vec;
  theme: Theme;
}) {
  const box = unionRects(objects.map(bboxOf));
  const origin = toView({ x: box.x, y: box.y });
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: origin.y - 3, left: origin.x - 3 },
        width: box.width * view.scale + 6,
        height: box.height * view.scale + 6,
        border: { width: 1, color: theme.accent },
      }}
    />
  );
}

function Marquee({
  rect,
  view,
  toView,
  theme,
}: {
  rect: Rect;
  view: MarkupCanvasView;
  toView: (p: Vec) => Vec;
  theme: Theme;
}) {
  const origin = toView({ x: rect.x, y: rect.y });
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: origin.y, left: origin.x },
        width: Math.max(1, rect.width * view.scale),
        height: Math.max(1, rect.height * view.scale),
        background: withAlpha(theme.accent, 36),
        border: { width: 1, color: theme.accent },
      }}
    />
  );
}

function TextEditor({
  view,
  toView,
  actions,
  theme,
}: {
  view: MarkupCanvasView;
  toView: (p: Vec) => Vec;
  actions: ChromeActions;
  theme: Theme;
}) {
  const editing = view.editing!;
  const object = view.objects.find((o) => o.id === editing.id);
  if (!object || object.kind !== "text") return null;
  const pos = toView(object.pos);
  const fontSize = object.fontPx * view.scale;
  const width = Math.max(
    fontSize * 5,
    measureText(editing.draft || " ", object.fontPx).width * view.scale + fontSize,
  );
  const padX = object.fontPx * TEXT_SCRIM_PAD_X * view.scale;
  const padY = object.fontPx * TEXT_SCRIM_PAD_Y * view.scale;
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: pos.y - padY, left: pos.x - padX },
        width: width + padX * 2,
        padding: { left: padX, right: padX, top: padY, bottom: padY },
        cornerRadius: object.fontPx * TEXT_SCRIM_RADIUS * view.scale,
        border: { width: 1, color: theme.accent },
        background: TEXT_SCRIM,
      }}
    >
      <Input
      // i dont even remember adding this
        autoFocus
        defaultValue={editing.draft}
        caretColor={object.color}
        selectionColor={theme.selection}
        style={{ fontSize, color: object.color, wrap: false, flexGrow: 1 }}
        onChange={(text) => actions.record.textChange(text)}
        onSubmit={(text) => actions.record.textSubmit(text)}
      />
    </Box>
  );
}

function Toolbar({
  view,
  actions,
  layout,
  theme,
}: {
  view: MarkupCanvasView;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const size = toolbarSize(rem, !view.onShot);
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: view.toolbar.y, left: view.toolbar.x },
        width: size.width,
        height: size.height,
        alignItems: "center",
        gap: rem * 0.12,
        padding: { left: rem * 0.3, right: rem * 0.15 },
        background: theme.overlay,
        cornerRadius: rem * 0.45,
        border: { width: 1, color: theme.fieldBorder },
      }}
    >
      {TOOLS.map((tool, index) => (
        <Box
          key={tool}
          style={{
            width: rem * 1.7,
            height: rem * 1.7,
            alignItems: "center",
            justifyContent: "center",
            cornerRadius: rem * 0.3,
            background: view.tool === tool ? theme.hoverStrong : undefined,
            hoverBackground: view.tool === tool ? theme.hoverStrong : theme.hover,
            flexShrink: 0,
          }}
          onClick={() =>
            tool === "crop" ? actions.record.toggleCropMenu() : actions.record.setTool(tool)
          }
        >
          <Icon
            icon={TOOL_ICONS[tool]}
            size={rem * 1.25}
            color={view.tool === tool ? theme.fg : theme.muted}
          />
          <Text
            style={{
              position: "absolute",
              inset: { right: 2, bottom: 0 },
              fontSize: rem * 0.45,
              color: view.tool === tool ? theme.fg : theme.disabled,
              selectable: false,
              wrap: false,
            }}
          >
            {String(index + 1)}
          </Text>
          {tool === "crop" && view.cropMenu && (
            <Box style={{ position: "absolute", inset: { bottom: rem * 1.8, left: -rem * 3.2 } }}>
              <PopupMenu
                items={CROP_SCOPES.map((item) => ({
                  label: item.label,
                  run: () => actions.record.beginCrop(item.scope),
                }))}
                width={rem * 8}
                rem={rem}
                theme={theme}
                focused={view.cropMenu.focus}
                onPick={() => {}}
                onDismiss={() => actions.record.closeCropMenu()}
              />
            </Box>
          )}
        </Box>
      ))}
      {MARKUP_COLORS.map((color) => (
        <Box
          key={color}
          style={{
            width: rem * 1.1,
            height: rem * 1.5,
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
          onClick={() => actions.record.setColor(color)}
        >
          <Box
            style={{
              width: rem * 0.78,
              height: rem * 0.78,
              cornerRadius: rem * 0.39,
              background: color,
              border:
                view.color === color
                  ? { width: 2, color: [255, 255, 255, 235] }
                  : { width: 1, color: [0, 0, 0, 80] },
            }}
          />
        </Box>
      ))}
      {!view.onShot && (
        <>
          <Box
            style={{
              width: rem * 0.35,
              height: rem * 1.7,
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Box style={{ width: 1, height: rem * 1.2, background: theme.fieldBorder }} />
          </Box>
          <Box
            style={{
              height: rem * 1.7,
              alignItems: "center",
              gap: rem * 0.35,
              padding: { left: rem * 0.4, right: rem * 0.4 },
              cornerRadius: rem * 0.3,
              hoverBackground: theme.hover,
              flexShrink: 0,
            }}
            onClick={() => actions.record.snapshot()}
          >
            <Icon icon="camera" size={rem * 0.95} color={theme.muted} />
            <Text style={{ fontSize: rem * 0.72, color: theme.fg, wrap: false, selectable: false }}>
              Screenshot
            </Text>
            <Text style={{ fontSize: rem * 0.65, color: theme.muted, wrap: false, selectable: false }}>
              enter
            </Text>
          </Box>
        </>
      )}
      <Box
        style={{
          width: rem * 1.2,
          height: rem * 1.7,
          alignItems: "center",
          justifyContent: "center",
          cornerRadius: rem * 0.25,
          hoverBackground: theme.hover,
          flexShrink: 0,
          flexDirection: "column",
          gap: 3,
        }}
        onDrag={actions.record.toolbarDrag}
      >
        {[0, 1, 2].map((row) => (
          <Box key={row} style={{ gap: 3 }}>
            <GripDot theme={theme} />
            <GripDot theme={theme} />
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function GripDot({ theme }: { theme: Theme }) {
  return <Box style={{ width: 2, height: 2, cornerRadius: 1, background: theme.muted }} />;
}
