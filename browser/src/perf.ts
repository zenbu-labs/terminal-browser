export interface FramePerfSample {
  captureToPaintMs: number | null;
  consumeMs: number;
  dirtyFraction: number;
  intervalMs: number;
}

export interface PerfSnapshot {
  paintFps: number;
  consumeMsP50: number;
  consumeMsP95: number;
  captureToPaintMsP50: number | null;
  dirtyFractionP50: number;
  loopLagMsP95: number;
  pageRafFps: number | null;
  droppedTextures: number;
}

const WINDOW = 240;

export class FramePerf {
  private samples: FramePerfSample[] = [];
  private loopLags: number[] = [];
  private lastPaintAt = 0;
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private expectedTick = 0;
  pageRafFps: number | null = null;
  droppedTextures = 0;

  start() {
    if (this.loopTimer) return;
    this.expectedTick = performance.now() + 50;
    this.loopTimer = setInterval(() => {
      const now = performance.now();
      this.loopLags.push(Math.max(0, now - this.expectedTick));
      this.expectedTick = now + 50;
      if (this.loopLags.length > WINDOW) this.loopLags.shift();
    }, 50);
  }

  stop() {
    if (this.loopTimer) clearInterval(this.loopTimer);
    this.loopTimer = null;
    this.samples = [];
    this.loopLags = [];
    this.pageRafFps = null;
    this.droppedTextures = 0;
    this.lastPaintAt = 0;
  }

  get running() {
    return this.loopTimer !== null;
  }

  frame(sample: Omit<FramePerfSample, "intervalMs">) {
    const now = performance.now();
    const intervalMs = this.lastPaintAt ? now - this.lastPaintAt : 0;
    this.lastPaintAt = now;
    this.samples.push({ ...sample, intervalMs });
    if (this.samples.length > WINDOW) this.samples.shift();
  }

  snapshot(): PerfSnapshot | null {
    if (!this.running || this.samples.length < 2) return null;
    const recent = this.samples.slice(-WINDOW);
    const intervals = recent.map((s) => s.intervalMs).filter((v) => v > 0);
    const consume = recent.map((s) => s.consumeMs);
    const capture = recent
      .map((s) => s.captureToPaintMs)
      .filter((v): v is number => v !== null);
    const dirty = recent.map((s) => s.dirtyFraction);
    return {
      paintFps: intervals.length ? 1000 / percentile(intervals, 0.5) : 0,
      consumeMsP50: percentile(consume, 0.5),
      consumeMsP95: percentile(consume, 0.95),
      captureToPaintMsP50: capture.length ? percentile(capture, 0.5) : null,
      dirtyFractionP50: percentile(dirty, 0.5),
      loopLagMsP95: this.loopLags.length ? percentile([...this.loopLags], 0.95) : 0,
      pageRafFps: this.pageRafFps,
      droppedTextures: this.droppedTextures,
    };
  }
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** Injected into the page while the HUD is enabled; reports rAF fps once a
 * second through the existing __pixelEmit binding. Kept out of the page
 * otherwise: an idle page has no rAF loop, and adding one forces begin
 * frames. */
export const RAF_PROBE = `(() => {
  if (window.__pixelPerfProbe) return true;
  window.__pixelPerfProbe = true;
  let frames = 0;
  let last = performance.now();
  let stopped = false;
  window.__pixelPerfProbeStop = () => { stopped = true; window.__pixelPerfProbe = false; };
  function tick() {
    if (stopped) return;
    frames++;
    const now = performance.now();
    if (now - last >= 1000) {
      window.__pixelEmit && window.__pixelEmit(JSON.stringify({
        channel: "perf-raf", data: { fps: frames * 1000 / (now - last) },
      }));
      frames = 0;
      last = now;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return true;
})()`;
