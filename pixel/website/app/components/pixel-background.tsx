"use client";

import { useEffect, useRef } from "react";

const TRIAD_CSS_PX = 6;
const SCALE = 2;
const TRIAD = TRIAD_CSS_PX / SCALE;
const PER_CLUSTER = 14;
const CLUSTERS = 7;
const STRAYS = 45;
const FALLOFF_FRACTION = 0.5;
const CONTENT_PAD_CSS_PX = 20;
const STRAY_TRIES = 6;
const FPS = 12;
const TRAIL_STEP_CSS_PX = 24;
const TRAIL_CHANCE = 0.5;
const TRAIL_RADIUS = 2;
const TRAIL_MIN_MS = 150;
const TRAIL_MAX_MS = 400;
const TRAIL_ALPHA = 0.14;
const TRAIL_MAX = 10;
const COLUMN = ".col";
const HERO = ".hero";
const HERO_CONTENT = "header .right, #wordmark, .lede, .install";
const CHANNEL_SETS = [[0], [1], [2], [0, 1], [1, 2], [0, 2], [0, 1, 2]];

type Rect = { x0: number; y0: number; x1: number; y1: number };
type Pixel = { x: number; y: number; channels: number[]; phase: number; speed: number };
type TrailPixel = { x: number; y: number; channels: number[]; until: number };

function startBackground(canvas: HTMLCanvasElement, trailCanvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")!;
  const trailCtx = trailCanvas.getContext("2d")!;
  let trail: TrailPixel[] = [];
  let lastSpawn: { x: number; y: number } | null = null;
  let cols = 0;
  let rows = 0;
  let tints: string[] = [];
  let pixels: Pixel[] = [];
  let keepOut: Rect[] = [];

  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const gaussian = () => (random() + random() + random() - 1.5) / 1.5;

  function readTints() {
    const css = getComputedStyle(document.documentElement);
    tints = ["--r", "--g", "--b"].map((name) => css.getPropertyValue(name).trim());
  }

  function keepOutRects(): DOMRect[] {
    const rects: DOMRect[] = [];
    const pad = (r: DOMRect) =>
      new DOMRect(r.left - CONTENT_PAD_CSS_PX, r.top - CONTENT_PAD_CSS_PX, r.width + CONTENT_PAD_CSS_PX * 2, r.height + CONTENT_PAD_CSS_PX * 2);
    document.querySelectorAll(HERO_CONTENT).forEach((el) => rects.push(pad(el.getBoundingClientRect())));
    const column = document.querySelector(COLUMN);
    const hero = document.querySelector(HERO);
    if (column && hero) {
      const box = column.getBoundingClientRect();
      const style = getComputedStyle(column);
      const left = box.left + parseFloat(style.paddingLeft) - CONTENT_PAD_CSS_PX;
      const right = box.right - parseFloat(style.paddingRight) + CONTENT_PAD_CSS_PX;
      const top = hero.getBoundingClientRect().bottom;
      rects.push(new DOMRect(left, top, right - left, box.bottom - top));
    }
    return rects;
  }

  function measureKeepOut() {
    const origin = canvas.getBoundingClientRect();
    keepOut = keepOutRects().map((r) => ({
      x0: (r.left - origin.left) / TRIAD_CSS_PX,
      y0: (r.top - origin.top) / TRIAD_CSS_PX,
      x1: (r.right - origin.left) / TRIAD_CSS_PX,
      y1: (r.bottom - origin.top) / TRIAD_CSS_PX,
    }));
  }

  const blocked = (x: number, y: number) =>
    keepOut.some((r) => x + 1 >= r.x0 && x <= r.x1 && y + 1 >= r.y0 && y <= r.y1);

  function place() {
    seed = 7;
    pixels = [];
    const add = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= cols || y >= rows || blocked(x, y)) return;
      pixels.push({
        x: Math.round(x),
        y: Math.round(y),
        channels: CHANNEL_SETS[Math.floor(random() * CHANNEL_SETS.length)],
        phase: random() * Math.PI * 2,
        speed: 0.07 + random() * 0.25,
      });
    };
    const falloff = rows * FALLOFF_FRACTION;
    const decay = 1 - Math.exp(-rows / falloff);
    const sampleY = () => -falloff * Math.log(1 - random() * decay);
    for (let c = CLUSTERS; c > 0; c--) {
      const cx = random() * cols;
      const cy = sampleY();
      const spread = 3 + random() * 9;
      for (let i = 0; i < PER_CLUSTER; i++) add(cx + gaussian() * spread * 1.6, cy + gaussian() * spread);
    }
    for (let i = STRAYS; i > 0; i--) {
      let x = random() * cols;
      let y = sampleY();
      for (let tries = 0; tries < STRAY_TRIES && blocked(x, y); tries++) {
        x = random() * cols;
        y = sampleY();
      }
      add(x, y);
    }
  }

  function resize() {
    cols = Math.ceil(canvas.clientWidth / TRIAD_CSS_PX);
    rows = Math.ceil(canvas.clientHeight / TRIAD_CSS_PX);
    canvas.width = cols * TRIAD;
    canvas.height = rows * TRIAD;
    measureKeepOut();
    place();
  }

  function resizeTrail() {
    trailCanvas.width = Math.ceil(window.innerWidth / TRIAD_CSS_PX) * TRIAD;
    trailCanvas.height = Math.ceil(window.innerHeight / TRIAD_CSS_PX) * TRIAD;
  }

  function spawnTrail(event: PointerEvent) {
    const now = performance.now();
    if (lastSpawn && Math.hypot(event.clientX - lastSpawn.x, event.clientY - lastSpawn.y) < TRAIL_STEP_CSS_PX) return;
    lastSpawn = { x: event.clientX, y: event.clientY };
    if (Math.random() > TRAIL_CHANCE || trail.length >= TRAIL_MAX) return;
    const x = Math.floor(event.clientX / TRIAD_CSS_PX + (Math.random() * 2 - 1) * TRAIL_RADIUS);
    const y = Math.floor(event.clientY / TRIAD_CSS_PX + (Math.random() * 2 - 1) * TRAIL_RADIUS);
    const px = x * TRIAD_CSS_PX;
    const py = y * TRIAD_CSS_PX;
    const hit = (r: DOMRect) => px + TRIAD_CSS_PX >= r.left && px <= r.right && py + TRIAD_CSS_PX >= r.top && py <= r.bottom;
    if (keepOutRects().some(hit)) return;
    trail.push({
      x,
      y,
      channels: CHANNEL_SETS[Math.floor(Math.random() * CHANNEL_SETS.length)],
      until: now + TRAIL_MIN_MS + Math.random() * (TRAIL_MAX_MS - TRAIL_MIN_MS),
    });
  }

  function drawTrail(now: number) {
    trail = trail.filter((pixel) => pixel.until > now);
    trailCtx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
    trailCtx.globalAlpha = TRAIL_ALPHA;
    for (const pixel of trail) {
      for (const c of pixel.channels) {
        trailCtx.fillStyle = tints[c];
        trailCtx.fillRect(pixel.x * TRIAD + c, pixel.y * TRIAD, 1, TRIAD - 1);
      }
    }
  }

  function frame(now: number) {
    const t = now / 1000;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 0.8;
    for (const pixel of pixels) {
      if (Math.sin(t * pixel.speed + pixel.phase) < 0.35) continue;
      for (const c of pixel.channels) {
        ctx.fillStyle = tints[c];
        ctx.fillRect(pixel.x * TRIAD + c, pixel.y * TRIAD, 1, TRIAD - 1);
      }
    }
    ctx.globalAlpha = 1;
  }

  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let last = 0;
  let raf = 0;
  let stopped = false;
  function loop(now: number) {
    if (stopped) return;
    if (!still) raf = requestAnimationFrame(loop);
    if (now - last < 1000 / FPS) return;
    last = now;
    frame(now);
    drawTrail(performance.now());
  }

  readTints();
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resizeTrail();
  window.addEventListener("resize", resizeTrail);
  if (!still) window.addEventListener("pointermove", spawnTrail, { passive: true });
  document.fonts.ready.then(() => !stopped && resize());
  raf = requestAnimationFrame(loop);

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    observer.disconnect();
    window.removeEventListener("resize", resizeTrail);
    window.removeEventListener("pointermove", spawnTrail);
  };
}

export default function PixelBackground() {
  const dither = useRef<HTMLCanvasElement>(null);
  const trail = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!dither.current || !trail.current) return;
    return startBackground(dither.current, trail.current);
  }, []);

  return (
    <>
      <canvas id="dither" ref={dither} aria-hidden />
      <canvas id="trail" ref={trail} aria-hidden />
    </>
  );
}
