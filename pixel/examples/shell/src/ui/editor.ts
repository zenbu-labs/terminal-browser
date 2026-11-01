import { bufferRows, bufferStarts, placeChars } from "../zsh/layout";
import type { Point } from "../zsh/layout";
import { trace } from "../log";
import type { Shell } from "../terminal/shell";
import { UndoCheckpoints } from "../zsh/undo";
import type { LineEditor } from "../zsh/zsh";

const GESTURE_WAIT_MS = 400;

export const INSERT_KEYMAPS = new Set(["main", "viins", "emacs", ""]);

interface Outgoing {
  gesture: boolean;
  run: () => void;
}

interface Geometry {
  state: LineEditor;
  chars: string[];
  places: Point[];
}

export class Editor {
  guiSelection = false;
  private current: LineEditor | null = null;
  private reported: LineEditor | null = null;
  private lastGeometry: Geometry | null = null;
  private undoSteps = new UndoCheckpoints();
  private outbox: Outgoing[] = [];
  private blocked = { since: 0, nudged: false };
  private flushTimer: NodeJS.Timeout | null = null;
  private lastSent: "key" | "paste" | "command" = "key";

  constructor(private readonly shell: Shell) {}

  get state(): LineEditor | null {
    return this.current;
  }

  report(state: LineEditor | null): boolean {
    trace("editor", state);
    this.current = state;
    this.reported = state;
    if (state) this.undoSteps.observe(state);
    else this.undoSteps.reset();
    const settled = !this.outbox.some((item) => item.gesture);
    if (!state?.regionActive && settled) this.guiSelection = false;
    return settled;
  }

  commandStarted(): void {
    this.current = null;
    this.reported = null;
    this.lastGeometry = null;
  }

  linePlaces(): Point[] | undefined {
    return (this.geometry() ?? this.lastGeometry)?.places;
  }

  range(state: LineEditor): [number, number] | null {
    if (!state.regionActive) return null;
    return [Math.min(state.mark, state.cursor), Math.max(state.mark, state.cursor)];
  }

  selectedText(): string {
    const state = this.current;
    const range = state && this.range(state);
    return range ? Array.from(state.buffer).slice(range[0], range[1]).join("") : "";
  }

  flush(): void {
    const zsh = this.shell.zsh;
    while (this.outbox.length) {
      const next = this.outbox[0];
      if (next.gesture && !this.geometry()) {
        const now = Date.now();
        if (!this.blocked.since) this.blocked = { since: now, nudged: false };
        if (now - this.blocked.since < GESTURE_WAIT_MS) {
          this.scheduleFlush();
          return;
        }
        const pasteHandlerMayWaitForAKey = this.lastSent === "paste" && !this.blocked.nudged;
        if (pasteHandlerMayWaitForAKey) {
          this.blocked = { since: now, nudged: true };
          zsh.sendNoOpKey();
          this.scheduleFlush();
          return;
        }
        trace("dropped gesture");
        this.outbox.shift();
        this.blocked = { since: 0, nudged: false };
        continue;
      }
      if (next.gesture) this.lastSent = "command";
      this.outbox.shift();
      this.blocked = { since: 0, nudged: false };
      next.run();
    }
  }

  send(bytes: Buffer | string, kind: "key" | "paste" = "key"): void {
    if (!bytes.length) return;
    this.enqueue({
      gesture: false,
      run: () => {
        this.lastSent = kind;
        this.shell.send(bytes);
        this.shell.flushOutgoing();
      },
    });
  }

  gesture(run: (geometry: Geometry) => void): void {
    this.enqueue({ gesture: true, run: () => run(this.geometry()!) });
  }

  insert(text: string): void {
    this.gesture(() => this.shell.zsh.insert(text));
    this.guiSelection = false;
    if (this.current) this.current = { ...this.current, regionActive: false };
  }

  extend(direction: "left" | "right" | "word-left" | "word-right" | "home" | "end"): void {
    this.guiSelection = true;
    this.gesture(() => this.shell.zsh.extend(direction));
    if (this.current) this.current = { ...this.current, regionActive: true };
  }

  collapse(side: "left" | "right" | "here"): void {
    this.gesture(() => this.shell.zsh.collapse(side));
    this.guiSelection = false;
    if (this.current) this.current = { ...this.current, regionActive: false };
  }

  selectLine(state: LineEditor): void {
    this.gesture((geometry) => this.select(0, geometry.chars.length));
    this.guiSelection = true;
    this.current = { ...state, mark: 0, cursor: Array.from(state.buffer).length, regionActive: true };
  }

  undoOrRedo(action: "undo" | "redo"): void {
    const zsh = this.shell.zsh;
    this.gesture(() => {
      const step = action === "undo" ? this.undoSteps.undo() : this.undoSteps.redo();
      if (step?.action === "undo") zsh.undo(step.change);
      else if (step?.action === "redo") zsh.redo(step.change);
    });
  }

  private geometry(): Geometry | null {
    const state = this.reported;
    const vt = this.shell.vt;
    const info = vt.info();
    if (!state || this.shell.zsh.awaitingReport || info.altScreen) return null;
    const chars = Array.from(state.buffer);
    const onScreen = (places: Point[]) =>
      bufferRows(chars, places).every(({ row, col, end, text }) => vt.textRange({ line: row, col }, { line: row, col: end - 1 }).trimEnd() === text.trimEnd());
    const places = bufferStarts(chars, state.cursor, { row: info.cursorY, col: info.cursorX }, info.cols)
      .map((start) => placeChars(chars, start, info.cols))
      .find(onScreen);
    if (!places) return null;
    this.lastGeometry = { state, chars, places };
    return this.lastGeometry;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 30);
  }

  private enqueue(item: Outgoing): void {
    this.outbox.push(item);
    this.flush();
  }

  private select(mark: number, cursor: number): void {
    this.guiSelection = true;
    this.shell.zsh.select(mark, cursor);
    if (this.current) this.current = { ...this.current, mark, cursor, regionActive: true };
  }
}
