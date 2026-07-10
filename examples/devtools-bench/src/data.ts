export interface FakeLog {
  id: number;
  level: "info" | "warn" | "error" | "debug";
  text: string;
}

export interface FakeNode {
  id: number;
  name: string;
  depth: number;
  children: FakeNode[];
}

export interface FakeSpan {
  name: string;
  start: number;
  dur: number;
  depth: number;
  lane: number;
}

/** Deterministic PRNG so every run stresses the engine identically. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS =
  `layout paint reconcile commit flush scroll resolve measure glyph raster blit clip
   viewport thumb caret selection wrap batch node tree taffy kitty frame shm pipe waker
   hover focus input submit divider overlay highlight profile span counter epoch`.split(/\s+/);

const COMPONENTS =
  `App Shell Sidebar NoteList Editor Toolbar StatusBar TabBar LogPanel FlameChart
   Overview Ruler Lane SpanBox Details TreeRow Chip Button Input Scroller`.split(/\s+/);

function sentence(rand: () => number, min: number, max: number): string {
  const count = min + Math.floor(rand() * (max - min));
  const words: string[] = [];
  for (let i = 0; i < count; i++) {
    words.push(WORDS[Math.floor(rand() * WORDS.length)]);
  }
  return words.join(" ");
}

let nextLogId = 1;

export function makeLogs(count: number, rand: () => number): FakeLog[] {
  const logs: FakeLog[] = [];
  for (let i = 0; i < count; i++) {
    const roll = rand();
    const level = roll < 0.72 ? "info" : roll < 0.86 ? "debug" : roll < 0.95 ? "warn" : "error";
    const long = rand() < 0.12;
    const text = `${sentence(rand, 3, long ? 40 : 12)} ${level === "error" ? "(exit 1)" : ""}`;
    logs.push({ id: nextLogId++, level, text });
  }
  return logs;
}

export function makeTree(targetNodes: number, rand: () => number): FakeNode {
  let id = 0;
  let budget = targetNodes;
  const make = (depth: number): FakeNode => {
    budget--;
    const node: FakeNode = {
      id: id++,
      name: COMPONENTS[Math.floor(rand() * COMPONENTS.length)],
      depth,
      children: [],
    };
    const fanout = depth > 9 ? 0 : Math.floor(rand() * 4);
    for (let i = 0; i < fanout && budget > 0; i++) {
      node.children.push(make(depth + 1));
    }
    return node;
  };
  const root: FakeNode = { id: id++, name: "Root", depth: 0, children: [] };
  budget--;
  while (budget > 0) {
    root.children.push(make(1));
  }
  return root;
}

export function countNodes(node: FakeNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

/**
 * A fake recording: frames every ~16ms, each frame recursively split into
 * nested spans across two lanes, until the span budget runs out.
 */
export function makeSpans(target: number, rand: () => number): { spans: FakeSpan[]; end: number } {
  const spans: FakeSpan[] = [];
  const split = (start: number, dur: number, depth: number, lane: number) => {
    if (spans.length >= target || dur < 0.05 || depth > 7) return;
    spans.push({
      name: WORDS[Math.floor(rand() * WORDS.length)],
      start,
      dur,
      depth,
      lane,
    });
    let at = start + dur * rand() * 0.15;
    while (at < start + dur * 0.9 && spans.length < target) {
      const child = Math.min(dur * (0.1 + rand() * 0.5), start + dur - at);
      if (child < 0.05) break;
      if (rand() < 0.8) split(at, child, depth + 1, lane);
      at += child + dur * rand() * 0.1;
    }
  };
  let t = 0;
  while (spans.length < target) {
    const frame = 4 + rand() * 24;
    split(t, frame * (0.4 + rand() * 0.6), 0, 0);
    if (rand() < 0.6) split(t + rand() * 4, frame * 0.3, 0, 1);
    t += 16.7;
  }
  return { spans, end: t };
}
