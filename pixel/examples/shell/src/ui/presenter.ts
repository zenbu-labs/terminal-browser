import { PixelView, transmitFrame } from "../terminal/embed";
import type { Frame, Rgba } from "../terminal/embed";
import { trace } from "../log";
import { MAX_IMAGE_CELLS, Overlay } from "../terminal/overlay";
import type { CellContent } from "../terminal/overlay";
import type { FromView, Rect, ViewState } from "../protocol";
import type { Shell } from "../terminal/shell";
import type { BarColors } from "../view/sizes";
import { writeOut } from "../terminal/tty";

const VIEW_START_AFTER_FIRST_PROMPT_MS = 150;

interface PresenterHooks {
  viewState(): ViewState;
  hidesCursor(): boolean;
  viewMessage(message: FromView): void;
  linesToScrollFor(regions: Record<string, Rect | null>): number;
}

function hex(c: readonly number[], alpha = 1): string {
  const part = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return `#${part(c[0])}${part(c[1])}${part(c[2])}${part(alpha * 255)}`;
}

export class Presenter {
  private readonly overlay: Overlay;
  private pixelView: PixelView | null = null;
  private viewStarting = false;
  private basePx: number | null = null;
  private regions: Record<string, Rect | null> = {};
  private frame: Frame | null = null;
  private frameShown = false;
  private presentQueued = false;
  private atGroundWrites: string[] = [];
  private lastState = "";
  private pointer: string | null = null;

  constructor(
    private readonly shell: Shell,
    private readonly hooks: PresenterHooks,
  ) {
    this.overlay = new Overlay(shell.vt, (data) => writeOut(data));
  }

  get view(): PixelView | null {
    return this.pixelView;
  }

  get showing(): boolean {
    return this.overlay.showing;
  }

  get scaleKnown(): boolean {
    return this.basePx != null;
  }

  lift(): void {
    this.overlay.lift();
  }

  stop(): void {
    if (this.overlay.showing || this.overlay.active) {
      this.overlay.setCells(new Map());
      this.overlay.wantMouse = false;
      this.overlay.cursor = "shell";
      this.overlay.commit();
    }
    if (this.pixelView) writeOut(`\x1b_Ga=d,d=I,i=${this.pixelView.imageId},q=2\x1b\\`);
    this.pixelView?.stop();
  }

  start(): void {
    if (this.pixelView || this.viewStarting || process.env.PXSH_NO_UI || !PixelView.available()) return;
    this.viewStarting = true;
    setTimeout(() => {
      const view = new PixelView(this.paneSize(), this.terminalColors());
      view.onFrame = (frame) => {
        this.frame = frame;
        this.frameShown = false;
        this.queuePresent();
      };
      view.onMessage = (message) => this.viewMessage(message);
      view.onPointer = (shape) => {
        this.pointer = shape;
        this.writeAtGround(`\x1b]22;${shape}\x1b\\`);
      };
      view.onClipboard = (text) => this.copyText(text);
      view.onExit = () => {
        trace("view exited");
        this.pixelView = null;
        this.viewStarting = false;
        this.regions = {};
        this.queuePresent();
      };
      this.pixelView = view;
      view.start();
      this.resync();
    }, VIEW_START_AFTER_FIRST_PROMPT_MS);
  }

  recolor(): void {
    this.pixelView?.setColors(this.terminalColors());
    this.resync();
  }

  resized(): void {
    const repaint = this.overlay.resized(this.shell.unseen.rows);
    if (repaint) {
      const { cursorX, cursorY } = this.shell.vt.info();
      const bytes = `\x1b[?2026h${repaint}\x1b[${cursorY + 1};${cursorX + 1}H\x1b[?2026l`;
      if (this.shell.vt.atGround()) writeOut(bytes);
      else this.writeAtGround(bytes);
    }
    this.pixelView?.resize(this.paneSize());
    this.resync();
  }

  private makeRoomBelow(lines: number): number {
    if (lines <= 0 || !this.shell.vt.atGround() || this.shell.waitingForCursor) return 0;
    this.overlay.lift();
    return this.shell.scrollUp(lines);
  }

  scale(): number {
    return (this.basePx ?? this.shell.cell.height * 0.45) / 13;
  }

  barColors(): BarColors {
    const facts = this.shell.queries.facts;
    const fg = facts.foreground ?? [220, 223, 228];
    const bg = facts.background ?? [30, 32, 38];
    const mix = (t: number) => [0, 1, 2].map((i) => bg[i] + (fg[i] - bg[i]) * t);
    return {
      fg: hex(mix(0.92)),
      muted: hex(mix(0.62)),
      faint: hex(mix(0.42)),
      border: hex(mix(0.2)),
      button: hex(mix(0.55)),
      buttonGlyph: hex(bg),
      panel: hex(bg, 0),
      hover: hex(mix(0.12)),
      codeBg: hex(mix(0.07)),
      error: "#f07178ff",
      on: "#34c759ff",
      knob: "#ffffffff",
    };
  }

  menuColors(): BarColors {
    return { ...this.barColors(), panel: hex([0, 1, 2].map((i) => {
      const facts = this.shell.queries.facts;
      const bg = facts.background ?? [30, 32, 38];
      const fg = facts.foreground ?? [220, 223, 228];
      return bg[i] + (fg[i] - bg[i]) * 0.06;
    }), 0.98) };
  }

  sync(): void {
    if (!this.pixelView) {
      this.queuePresent();
      return;
    }
    const state = this.hooks.viewState();
    const json = JSON.stringify(state);
    if (json !== this.lastState) {
      this.lastState = json;
      this.pixelView.send({ type: "state", state });
    }
    this.queuePresent();
  }

  queuePresent(): void {
    if (this.presentQueued) return;
    this.presentQueued = true;
    setImmediate(() => {
      this.presentQueued = false;
      this.present();
    });
  }

  writeAtGround(bytes: string): void {
    this.atGroundWrites.push(bytes);
    this.queuePresent();
  }

  copyText(text: string): void {
    if (text) this.writeAtGround(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x1b\\`);
  }

  regionAt(x: number, y: number): boolean {
    return Object.keys(this.regions).some((name) => this.regionNamed(name, x, y));
  }

  regionNamed(name: string, x: number, y: number): boolean {
    const r = this.regions[name];
    return !!r && x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
  }

  private resync(): void {
    this.lastState = "";
    this.sync();
  }

  private paneSize() {
    return { ...this.shell.size, cell: this.shell.cell };
  }

  private terminalColors(): { foreground: Rgba | null; background: Rgba | null; palette: (Rgba | null)[] } {
    const facts = this.shell.queries.facts;
    const rgba = (c: [number, number, number] | null | undefined): Rgba | null => (c ? [c[0], c[1], c[2], 255] : null);
    const palette: (Rgba | null)[] = [];
    for (let i = 0; i < 16; i++) palette.push(rgba(facts.palette.get(i)));
    return { foreground: rgba(facts.foreground), background: rgba(facts.background), palette };
  }

  private viewMessage(message: FromView): void {
    switch (message.type) {
      case "hello":
        this.basePx = message.basePx;
        this.resync();
        break;
      case "regions":
        this.regions = message.regions;
        if (this.makeRoomBelow(this.hooks.linesToScrollFor(this.regions))) {
          this.regions = {};
          this.resync();
        }
        this.queuePresent();
        break;
      default:
        this.hooks.viewMessage(message);
    }
  }

  private present(): void {
    const vt = this.shell.vt;
    if (!vt.atGround() || this.shell.waitingForCursor) return;
    const out = this.atGroundWrites.splice(0).join("");
    const view = this.pixelView;
    if (view && this.frame && !this.frameShown) {
      this.frameShown = true;
      writeOut(out + transmitFrame(this.frame, view.imageId));
    } else if (out) writeOut(out);
    const info = vt.info();
    const cells = new Map<number, CellContent>();
    if (view && this.frame && !info.altScreen) {
      const { width: cw, height: ch } = this.shell.cell;
      const firstSeenRow = this.shell.unseen.rows;
      for (const rect of Object.values(this.regions)) {
        if (!rect || rect.width <= 0 || rect.height <= 0) continue;
        const c0 = Math.max(0, Math.floor(rect.x / cw));
        const r0 = Math.max(firstSeenRow, Math.floor(rect.y / ch));
        const c1 = Math.min(info.cols, MAX_IMAGE_CELLS, Math.ceil((rect.x + rect.width) / cw));
        const r1 = Math.min(info.rows, MAX_IMAGE_CELLS, Math.ceil((rect.y + rect.height) / ch));
        for (let row = r0; row < r1; row++) for (let col = c0; col < c1; col++) cells.set(this.overlay.key(row, col), { image: view.imageId, row, col });
      }
    }
    this.overlay.setCells(cells);
    this.overlay.wantMouse = cells.size > 0;
    this.overlay.cursor = this.hooks.hidesCursor() && this.overlay.showing ? "hidden" : "shell";
    if (!this.overlay.wantMouse && this.pointer) {
      this.pointer = null;
      writeOut("\x1b]22;default\x1b\\");
    }
    this.overlay.commit();
  }
}
