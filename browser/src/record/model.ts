export type Tool = "select" | "pen" | "arrow" | "oval" | "text" | "crop";

export const TOOLS: Tool[] = ["select", "pen", "arrow", "oval", "text", "crop"];

export const MARKUP_COLORS = ["#e5484d", "#f5a524", "#3b82f6", "#30a46c"];

export interface Vec {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type MarkupObject =
  | { kind: "pen"; id: number; color: string; width: number; points: Vec[] }
  | { kind: "arrow"; id: number; color: string; width: number; from: Vec; to: Vec }
  | { kind: "oval"; id: number; color: string; width: number; rect: Rect }
  | { kind: "text"; id: number; color: string; text: string; pos: Vec; fontPx: number }
  | { kind: "crop"; id: number; rect: Rect; scope: CropScope };

export type CropScope = "frame" | "video";

export type HandleId = "nw" | "n" | "ne" | "w" | "e" | "sw" | "s" | "se" | "from" | "to";

export const CROP_SCOPES: { label: string; scope: CropScope }[] = [
  { label: "Crop this frame", scope: "frame" },
  { label: "Crop full video", scope: "video" },
];

const MONO_ADVANCE = 0.6;
const LINE_HEIGHT = 1.3;

export function measureText(text: string, fontPx: number): { width: number; height: number } {
  const lines = text.split("\n");
  const chars = Math.max(1, ...lines.map((line) => line.length));
  return { width: chars * fontPx * MONO_ADVANCE, height: lines.length * fontPx * LINE_HEIGHT };
}

export function bboxOf(object: MarkupObject): Rect {
  switch (object.kind) {
    case "pen": {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of object.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      const pad = object.width / 2;
      return {
        x: minX - pad,
        y: minY - pad,
        width: Math.max(1, maxX - minX + object.width),
        height: Math.max(1, maxY - minY + object.width),
      };
    }
    case "arrow": {
      const x = Math.min(object.from.x, object.to.x);
      const y = Math.min(object.from.y, object.to.y);
      return {
        x,
        y,
        width: Math.max(1, Math.abs(object.from.x - object.to.x)),
        height: Math.max(1, Math.abs(object.from.y - object.to.y)),
      };
    }
    case "text": {
      const size = measureText(object.text || " ", object.fontPx);
      return { x: object.pos.x, y: object.pos.y, ...size };
    }
    case "oval":
    case "crop":
      return object.rect;
  }
}

export function unionRects(rects: Rect[]): Rect {
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function rectFromPoints(a: Vec, b: Vec): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

export function clampRect(
  rect: Rect,
  bounds: { width: number; height: number },
  min: number,
): Rect {
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  return {
    x,
    y,
    width: Math.max(min, Math.min(Math.round(rect.width), bounds.width - x)),
    height: Math.max(min, Math.min(Math.round(rect.height), bounds.height - y)),
  };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

export function pointInRect(p: Vec, rect: Rect, tolerance = 0): boolean {
  return (
    p.x >= rect.x - tolerance &&
    p.x <= rect.x + rect.width + tolerance &&
    p.y >= rect.y - tolerance &&
    p.y <= rect.y + rect.height + tolerance
  );
}

function nearRectBorder(p: Vec, rect: Rect, tolerance: number): boolean {
  const inOuter =
    p.x >= rect.x - tolerance &&
    p.x <= rect.x + rect.width + tolerance &&
    p.y >= rect.y - tolerance &&
    p.y <= rect.y + rect.height + tolerance;
  const inInner =
    p.x >= rect.x + tolerance &&
    p.x <= rect.x + rect.width - tolerance &&
    p.y >= rect.y + tolerance &&
    p.y <= rect.y + rect.height - tolerance;
  return inOuter && !inInner;
}

export function hitTest(objects: MarkupObject[], p: Vec, tolerance: number): number | null {
  for (let i = objects.length - 1; i >= 0; i--) {
    const object = objects[i];
    switch (object.kind) {
      case "pen": {
        const reach = tolerance + object.width / 2;
        for (let s = 0; s + 1 < object.points.length; s++) {
          if (distToSegment(p, object.points[s], object.points[s + 1]) <= reach) return object.id;
        }
        break;
      }
      case "arrow": {
        if (distToSegment(p, object.from, object.to) <= tolerance + object.width / 2) return object.id;
        break;
      }
      case "text": {
        if (pointInRect(p, bboxOf(object), tolerance)) return object.id;
        break;
      }
      case "oval": {
        const rx = Math.max(1, object.rect.width / 2);
        const ry = Math.max(1, object.rect.height / 2);
        const dx = (p.x - (object.rect.x + rx)) / rx;
        const dy = (p.y - (object.rect.y + ry)) / ry;
        const fromRing = Math.abs(Math.hypot(dx, dy) - 1) * Math.min(rx, ry);
        if (fromRing <= tolerance + object.width / 2) return object.id;
        break;
      }
      case "crop": {
        if (nearRectBorder(p, object.rect, tolerance)) return object.id;
        break;
      }
    }
  }
  return null;
}

export function handlesFor(object: MarkupObject): { id: HandleId; pos: Vec }[] {
  if (object.kind === "arrow") {
    return [
      { id: "from", pos: object.from },
      { id: "to", pos: object.to },
    ];
  }
  const box = bboxOf(object);
  const xs = { w: box.x, c: box.x + box.width / 2, e: box.x + box.width };
  const ys = { n: box.y, c: box.y + box.height / 2, s: box.y + box.height };
  const all: { id: HandleId; pos: Vec }[] = [
    { id: "nw", pos: { x: xs.w, y: ys.n } },
    { id: "n", pos: { x: xs.c, y: ys.n } },
    { id: "ne", pos: { x: xs.e, y: ys.n } },
    { id: "w", pos: { x: xs.w, y: ys.c } },
    { id: "e", pos: { x: xs.e, y: ys.c } },
    { id: "sw", pos: { x: xs.w, y: ys.s } },
    { id: "s", pos: { x: xs.c, y: ys.s } },
    { id: "se", pos: { x: xs.e, y: ys.s } },
  ];
  if (object.kind === "text") {
    return all.filter((handle) => ["nw", "ne", "sw", "se"].includes(handle.id));
  }
  return all;
}

export function moveObject(object: MarkupObject, dx: number, dy: number): MarkupObject {
  switch (object.kind) {
    case "pen":
      return { ...object, points: object.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    case "arrow":
      return {
        ...object,
        from: { x: object.from.x + dx, y: object.from.y + dy },
        to: { x: object.to.x + dx, y: object.to.y + dy },
      };
    case "text":
      return { ...object, pos: { x: object.pos.x + dx, y: object.pos.y + dy } };
    case "oval":
    case "crop":
      return { ...object, rect: { ...object.rect, x: object.rect.x + dx, y: object.rect.y + dy } };
  }
}

function resizedRect(box: Rect, handle: HandleId, p: Vec, minSize: number): Rect {
  let left = box.x;
  let top = box.y;
  let right = box.x + box.width;
  let bottom = box.y + box.height;
  if (handle === "nw" || handle === "w" || handle === "sw") left = Math.min(p.x, right - minSize);
  if (handle === "ne" || handle === "e" || handle === "se") right = Math.max(p.x, left + minSize);
  if (handle === "nw" || handle === "n" || handle === "ne") top = Math.min(p.y, bottom - minSize);
  if (handle === "sw" || handle === "s" || handle === "se") bottom = Math.max(p.y, top + minSize);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function resizeObject(start: MarkupObject, handle: HandleId, p: Vec): MarkupObject {
  if (start.kind === "arrow") {
    if (handle === "from") return { ...start, from: p };
    if (handle === "to") return { ...start, to: p };
    return start;
  }
  const box = bboxOf(start);
  switch (start.kind) {
    case "pen": {
      const target = resizedRect(box, handle, p, 4);
      const sx = target.width / box.width;
      const sy = target.height / box.height;
      return {
        ...start,
        points: start.points.map((point) => ({
          x: target.x + (point.x - box.x) * sx,
          y: target.y + (point.y - box.y) * sy,
        })),
      };
    }
    case "text": {
      const anchor = {
        x: handle.includes("w") ? box.x + box.width : box.x,
        y: handle.includes("n") ? box.y + box.height : box.y,
      };
      const corner = {
        x: handle.includes("w") ? box.x : box.x + box.width,
        y: handle.includes("n") ? box.y : box.y + box.height,
      };
      const v = { x: corner.x - anchor.x, y: corner.y - anchor.y };
      const along =
        ((p.x - anchor.x) * v.x + (p.y - anchor.y) * v.y) / (v.x * v.x + v.y * v.y);
      const fontPx = Math.max(8, Math.min(200, start.fontPx * Math.max(0.2, along)));
      const scale = fontPx / start.fontPx;
      return {
        ...start,
        fontPx,
        pos: {
          x: anchor.x - (handle.includes("w") ? box.width * scale : 0),
          y: anchor.y - (handle.includes("n") ? box.height * scale : 0),
        },
      };
    }
    case "oval":
      return { ...start, rect: resizedRect(start.rect, handle, p, 8) };
    case "crop":
      return { ...start, rect: resizedRect(start.rect, handle, p, 12) };
  }
}

export function penPathSegments(
  points: Vec[],
): { move: Vec; curves: { control: Vec; to: Vec }[]; tail: Vec | null } {
  if (points.length < 3) {
    return { move: points[0], curves: [], tail: points[1] ?? null };
  }
  const curves: { control: Vec; to: Vec }[] = [];
  for (let i = 1; i + 1 < points.length; i++) {
    curves.push({
      control: points[i],
      to: {
        x: (points[i].x + points[i + 1].x) / 2,
        y: (points[i].y + points[i + 1].y) / 2,
      },
    });
  }
  return { move: points[0], curves, tail: points[points.length - 1] };
}

export function arrowHead(from: Vec, to: Vec, width: number): { left: Vec; right: Vec } {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const length = Math.max(10, width * 3.5);
  const spread = 0.48;
  return {
    left: {
      x: to.x - length * Math.cos(angle - spread),
      y: to.y - length * Math.sin(angle - spread),
    },
    right: {
      x: to.x - length * Math.cos(angle + spread),
      y: to.y - length * Math.sin(angle + spread),
    },
  };
}

export class MarkupStore {
  private byState = new Map<number, MarkupObject[]>();
  private videoCropState: { id: number; rect: Rect } | null = null;
  private undoStacks = new Map<number, MarkupObject[][]>();
  private redoStacks = new Map<number, MarkupObject[][]>();
  private seq = 1;

  allocId(): number {
    return this.seq++;
  }

  objects(key: number): MarkupObject[] {
    const own = this.ownObjects(key);
    const video = this.videoCropState;
    if (!video) return own;
    return [...own, { kind: "crop", id: video.id, rect: video.rect, scope: "video" }];
  }

  ownObjects(key: number): MarkupObject[] {
    return this.byState.get(key) ?? [];
  }


  drawables(key: number): MarkupObject[] {
    return this.ownObjects(key).filter((object) => object.kind !== "crop");
  }

  crop(key: number): Rect | null {
    const object = this.ownObjects(key).find((o) => o.kind === "crop" && o.scope === "frame");
    return object?.kind === "crop" ? object.rect : null;
  }

  videoCrop(): Rect | null {
    return this.videoCropState?.rect ?? null;
  }

  removeVideoCrops() {
    this.videoCropState = null;
  }

  annotatedKeys(): readonly number[] {
    if (!this.keysCache) {
      this.keysCache = [...this.byState.keys()].sort((a, b) => a - b);
    }
    return this.keysCache;
  }

  private keysCache: number[] | null = null;

  begin(key: number) {
    const stack = this.undoStacks.get(key) ?? [];
    stack.push(structuredClone(this.ownObjects(key)));
    if (stack.length > 50) stack.shift();
    this.undoStacks.set(key, stack);
    this.redoStacks.delete(key);
  }

  replace(key: number, objects: MarkupObject[]) {
    const video = objects.filter((o) => o.kind === "crop" && o.scope === "video").pop();
    if (video?.kind === "crop") this.videoCropState = { id: video.id, rect: video.rect };
    const own = objects.filter((o) => !(o.kind === "crop" && o.scope === "video"));
    if (own.length === 0) this.byState.delete(key);
    else this.byState.set(key, own);
    this.keysCache = null;
  }

  update(key: number, object: MarkupObject) {
    if (object.kind === "crop" && object.scope === "video") {
      if (this.videoCropState?.id === object.id) {
        this.videoCropState = { id: object.id, rect: object.rect };
      }
      return;
    }
    this.replace(
      key,
      this.ownObjects(key).map((existing) => (existing.id === object.id ? object : existing)),
    );
  }

  remove(key: number, id: number) {
    if (this.videoCropState?.id === id) {
      this.videoCropState = null;
      return;
    }
    this.replace(key, this.ownObjects(key).filter((object) => object.id !== id));
  }

  undo(key: number) {
    this.shift(key, this.undoStacks, this.redoStacks);
  }

  redo(key: number) {
    this.shift(key, this.redoStacks, this.undoStacks);
  }

  private shift(key: number, from: Map<number, MarkupObject[][]>, to: Map<number, MarkupObject[][]>) {
    const snapshot = from.get(key)?.pop();
    if (!snapshot) return;
    const stack = to.get(key) ?? [];
    stack.push(structuredClone(this.ownObjects(key)));
    to.set(key, stack);
    this.replace(key, snapshot);
  }
}
