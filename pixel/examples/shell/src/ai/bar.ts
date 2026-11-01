import { chordName } from "../terminal/chords";
import type { KeyEvent } from "../terminal/input";
import { barPlacement } from "../zsh/layout";
import { FALLBACK_MODELS, HARNESSES, choiceLabel, harnessExecutables, readChoice, readModels, resolveChoice, saveChoice, saveModels } from "./models";
import type { AiChoice, Harness, HarnessModels } from "./models";
import type { ModelGroup } from "../view/modelmenu";
import { MENU_KEYS } from "../protocol";
import type { BarView, FromView, Rect } from "../protocol";
import type { Shell } from "../terminal/shell";
import { fullBarHeight } from "../view/sizes";
import type { AiSession } from "./turn";
import type { Editor } from "../ui/editor";
import type { Presenter } from "../ui/presenter";
import type { LineEditor } from "../zsh/zsh";

const AI_PRELOAD_IDLE_MS = 1500;
const BAR_EDGE_MARGIN = 6;
const RECENT_OUTPUT_LINES = 80;

const HARNESS_TITLES: Record<Harness, string> = { claude: "Claude", codex: "OpenAI" };
const SIGNED_OUT: Record<Harness, string> = { claude: "Not signed in. Run claude to sign in", codex: "Not signed in. Run codex login" };
const NO_HARNESS = "No AI found. Install claude or codex";
const NEW_CHAT = (title: string) => `New chat with ${title}`;

interface AiCatalog {
  executables: Record<Harness, string | null>;
  models: Partial<Record<Harness, HarnessModels>>;
  choice: AiChoice | null;
}

let aiModule: typeof import("./session") | null = null;
const loadAi = () => (aiModule ??= require("./session") as typeof import("./session"));

export class Bar {
  private bar = {
    open: false,
    focused: false,
    busy: false,
    text: "",
    before: null as string | null,
    written: null as string | null,
    complete: false,
    turnWrote: false,
    lastRun: null as { command: string; exitCode: number | null } | null,
    lastQuery: "",
    history: [] as string[],
    historyIndex: -1,
    answer: "",
    status: null as string | null,
    error: null as string | null,
    notice: null as string | null,
    pickerOpen: false,
    conversation: false,
    side: undefined as "below" | "above" | undefined,
    growsDown: false,
  };
  private catalog: AiCatalog | null = null;
  private modelsRefreshed = new Set<Harness>();
  private ai: AiSession | null = null;
  private aiPreload: NodeJS.Timeout | null = null;
  private cwd = process.env.PXSH_CWD ?? process.cwd();

  constructor(
    private readonly shell: Shell,
    private readonly editor: Editor,
    private readonly presenter: Presenter,
  ) {}

  get isOpen(): boolean {
    return this.bar.open;
  }

  get hasFocus(): boolean {
    return this.bar.open && this.bar.focused;
  }

  blur(): void {
    this.bar.focused = false;
    this.bar.pickerOpen = false;
  }

  dismiss(): void {
    if (this.bar.pickerOpen) this.openPicker(false);
    else this.close();
  }

  stop(): void {
    this.ai?.close();
  }

  postponePreload(): void {
    this.aiPreload?.refresh();
  }

  prompt(code: number, dir: string): void {
    const lastRun = this.bar.lastRun;
    if (lastRun) {
      if (lastRun.exitCode === null) lastRun.exitCode = code;
      else this.bar.lastRun = null;
    }
    this.cwd = dir;
    this.preloadAiWhenIdle();
  }

  commandStarted(): void {
    if (this.bar.written != null) this.forgetWritten();
  }

  editorReported(state: LineEditor | null, settled: boolean): void {
    if (state && settled && !this.bar.busy && this.bar.written != null && state.buffer !== this.bar.written) this.forgetWritten();
  }

  viewMessage(message: FromView): void {
    switch (message.type) {
      case "text":
        this.bar.text = message.value;
        this.presenter.sync();
        break;
      case "submit":
        this.submitBar();
        break;
      case "stop":
        void this.ai?.stop();
        break;
      case "close":
        this.close();
        break;
      case "focusBar":
        this.bar.focused = true;
        this.presenter.view?.send({ type: "focusInput" });
        this.presenter.sync();
        break;
      case "picker":
        this.openPicker(message.open);
        break;
      case "choice":
        this.chooseModel(message.choice);
        break;
    }
  }

  view(): BarView {
    const s = this.presenter.scale();
    this.bar.side ??= this.chooseSide(s);
    const { cols } = this.shell.size;
    const { width: cw } = this.shell.cell;
    const room = this.room(s);
    const width = Math.min(cols * cw - 2 * cw, 520 * s);
    const left = Math.max(cw, Math.min(room.start.col * cw - 6 * s, cols * cw - width - cw));
    const tallest = fullBarHeight(s);
    const placement = barPlacement({ ...room, tallest, side: this.bar.side });
    const maxHeight = this.bar.growsDown ? Math.min(tallest, room.roomBelow + room.start.row * this.shell.cell.height) : placement.maxHeight;
    const catalog = this.catalog;
    return {
      inset: placement.side === "below" ? { left, top: room.below } : { left, bottom: room.bottom - room.above },
      width,
      maxHeight,
      busy: this.bar.busy,
      ready: this.isReady() && this.bar.text === "",
      status: this.bar.status,
      answer: this.bar.answer,
      error: this.bar.error,
      notice: this.bar.notice,
      model: catalog?.choice
        ? { groups: this.modelGroups(catalog), choice: catalog.choice, label: choiceLabel(catalog.choice, catalog.models), conversation: this.bar.conversation, open: this.bar.pickerOpen }
        : null,
    };
  }

  private room(s: number) {
    const { rows } = this.shell.size;
    const { height: ch } = this.shell.cell;
    const info = this.shell.vt.info();
    const start = this.editor.linePlaces()?.[0] ?? { row: info.cursorY, col: info.cursorX };
    const gap = 2 * s;
    const below = (info.cursorY + 1) * ch + gap;
    const above = (start.row - 1) * ch - gap;
    const bottom = rows * ch;
    const margin = BAR_EDGE_MARGIN * s;
    return { start, below, above, bottom, roomBelow: bottom - below - margin, roomAbove: above - margin, seenAbove: above - Math.max(margin, this.shell.unseen.rows * ch) };
  }

  private chooseSide(s: number): "below" | "above" {
    const tallest = fullBarHeight(s);
    const room = this.room(s);
    const { side } = barPlacement({ ...room, tallest });
    if (side === "below" || Math.min(tallest, room.roomAbove) <= room.seenAbove) return side;
    this.bar.growsDown = true;
    return "below";
  }

  linesToScrollFor(rect: Rect | null | undefined): number {
    if (!this.bar.open || !this.bar.growsDown || !rect) return 0;
    const room = this.room(this.presenter.scale());
    if (Math.abs(rect.y - room.below) > 1) return 0;
    const overflow = rect.y + rect.height + BAR_EDGE_MARGIN * this.presenter.scale() - room.bottom;
    return overflow > 0 ? Math.min(room.start.row, Math.ceil(overflow / this.shell.cell.height)) : 0;
  }

  open(): void {
    this.bar.open = true;
    this.bar.focused = true;
    this.presenter.view?.send({ type: "input", text: this.bar.text });
    this.presenter.view?.send({ type: "focusInput" });
    this.presenter.start();
    this.presenter.sync();
    setImmediate(() => {
      if (!this.bar.open) return;
      this.loadCatalog();
      this.ensureSession();
    });
  }

  close(): void {
    this.ai?.close();
    this.ai = null;
    Object.assign(this.bar, {
      open: false,
      focused: false,
      busy: false,
      text: "",
      before: null,
      written: null,
      complete: false,
      lastRun: null,
      historyIndex: -1,
      answer: "",
      status: null,
      error: null,
      notice: null,
      pickerOpen: false,
      conversation: false,
      side: undefined,
      growsDown: false,
    });
    this.presenter.sync();
  }

  handleKey(event: KeyEvent): void {
    const { super: cmd } = event.mods;
    const chord = chordName(event);
    if (this.bar.pickerOpen && MENU_KEYS.includes(chord)) {
      this.presenter.view?.send({ type: "menuKey", key: chord });
      return;
    }
    if (chord === "alt+p") {
      if (this.loadCatalog().choice) this.openPicker(!this.bar.pickerOpen);
    } else if (chord === "escape") this.close();
    else if (chord === "shift+super+e") return;
    else if (event.key === "enter" && cmd) this.runCommand();
    else if (event.key === "backspace" && cmd) {
      if (this.bar.busy) void this.ai?.stop();
      else if (!this.bar.text) this.rejectCommand();
    } else if (event.key === "pageup" || event.key === "pagedown") this.presenter.view?.send({ type: "page", direction: event.key === "pageup" ? -1 : 1 });
    else if ((event.key === "up" || event.key === "down") && !this.bar.text.includes("\n") && chord === event.key) {
      const { history, historyIndex } = this.bar;
      const next = Math.max(-1, Math.min(history.length - 1, historyIndex + (event.key === "up" ? 1 : -1)));
      this.bar.historyIndex = next;
      this.setBarInput(next === -1 ? "" : history[next]);
    } else this.presenter.view?.key(event);
  }

  private modelGroups({ executables, models }: AiCatalog): ModelGroup[] {
    return HARNESSES.filter((harness) => executables[harness]).map((harness) => {
      const signedIn = models[harness]?.signedIn !== false;
      return { harness, title: HARNESS_TITLES[harness], models: models[harness]?.models ?? FALLBACK_MODELS[harness], note: signedIn ? null : SIGNED_OUT[harness], enabled: signedIn };
    });
  }

  private isReady(): boolean {
    return !this.bar.busy && this.bar.complete && this.bar.written != null && this.editor.state?.buffer === this.bar.written;
  }

  private forgetWritten(): void {
    Object.assign(this.bar, { written: null, before: null, complete: false });
    this.presenter.sync();
  }

  private preloadAiWhenIdle(): void {
    if (aiModule || this.aiPreload || process.env.PXSH_NO_UI) return;
    this.aiPreload = setTimeout(() => {
      this.aiPreload = null;
      this.loadCatalog();
      loadAi().preloadSdk();
    }, AI_PRELOAD_IDLE_MS);
  }

  private loadCatalog(): AiCatalog {
    if (this.catalog) return this.catalog;
    const executables = harnessExecutables();
    const models = readModels();
    const installed = HARNESSES.filter((harness) => executables[harness]);
    this.catalog = { executables, models, choice: resolveChoice(readChoice(), installed, models) };
    this.presenter.sync();
    return this.catalog;
  }

  private updateModels(harness: Harness, found: HarnessModels): void {
    this.modelsRefreshed.add(harness);
    const current = this.loadCatalog();
    if (JSON.stringify(current.models[harness]) === JSON.stringify(found)) return;
    this.catalog = { ...current, models: { ...current.models, [harness]: found } };
    saveModels(harness, found);
    this.presenter.sync();
  }

  private ensureSession(): AiSession | null {
    if (this.ai) return this.ai;
    const { choice, executables } = this.loadCatalog();
    const executable = choice && executables[choice.harness];
    if (!choice || !executable) {
      this.bar.error = NO_HARNESS;
      this.presenter.sync();
      return null;
    }
    this.ai = loadAi().createSession(
      choice,
      executable,
      {
        text: (delta) => {
          this.bar.answer += delta;
          this.presenter.sync();
        },
        command: (command, final) => {
          this.bar.complete = final;
          if (!this.bar.turnWrote) this.bar.answer = "";
          this.bar.turnWrote = true;
          this.presenter.sync();
          if (command === this.bar.written) return;
          this.bar.written = command;
          this.editor.gesture(() => this.shell.zsh.setBuffer(command));
        },
        status: (status) => {
          this.bar.status = status;
          this.presenter.sync();
        },
        done: () => {
          this.bar.busy = false;
          this.bar.status = null;
          this.presenter.sync();
        },
        failed: (message) => {
          this.bar.error = message;
          this.presenter.sync();
        },
        models: (harness, models) => this.updateModels(harness, models),
      },
      this.cwd,
    );
    return this.ai;
  }

  private endConversation(): void {
    this.ai?.close();
    this.ai = null;
    Object.assign(this.bar, { busy: false, before: null, written: null, complete: false, lastRun: null, answer: "", status: null, error: null, conversation: false });
  }

  private chooseModel(next: AiChoice): void {
    const current = this.loadCatalog();
    const previous = current.choice;
    this.catalog = { ...current, choice: next };
    saveChoice(next);
    if (!this.ai || previous?.harness === next.harness) {
      this.ai?.setChoice(next);
      this.presenter.sync();
      return;
    }
    const hadConversation = this.bar.conversation;
    this.endConversation();
    this.bar.notice = hadConversation ? NEW_CHAT(HARNESS_TITLES[next.harness]) : null;
    this.ensureSession();
    this.presenter.sync();
  }

  private openPicker(open: boolean): void {
    this.bar.pickerOpen = open;
    this.presenter.sync();
    if (!open) {
      this.presenter.view?.send({ type: "focusInput" });
      return;
    }
    setImmediate(() => {
      const { executables } = this.loadCatalog();
      const stale = Object.fromEntries(HARNESSES.filter((h) => !this.modelsRefreshed.has(h)).map((h) => [h, executables[h]]));
      for (const harness of Object.keys(stale) as Harness[]) this.modelsRefreshed.add(harness);
      loadAi().refreshModels(stale, (harness, models) => this.updateModels(harness, models));
    });
  }

  private setBarInput(value: string): void {
    this.bar.text = value;
    this.presenter.view?.send({ type: "input", text: value });
    this.presenter.sync();
  }

  private recentOutput(): string {
    const lines = this.shell.vt.text().split("\n");
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.slice(-RECENT_OUTPUT_LINES).join("\n");
  }

  private askAi(): void {
    const query = this.bar.text.trim();
    if (!query || this.bar.busy) return;
    const session = this.ensureSession();
    if (!session) return;
    this.bar.conversation = true;
    this.bar.notice = null;
    if (this.bar.written == null) {
      this.bar.before = this.editor.state?.buffer ?? "";
      this.bar.complete = false;
    }
    this.bar.turnWrote = false;
    this.bar.lastQuery = query;
    this.bar.history = [query, ...this.bar.history.filter((h) => h !== query)];
    this.bar.historyIndex = -1;
    this.bar.busy = true;
    this.bar.answer = "";
    this.bar.error = null;
    const context = {
      cwd: this.cwd,
      commandLine: this.editor.state?.buffer ?? "",
      recentOutput: this.recentOutput(),
      selection: this.editor.selectedText(),
      lastRun: this.bar.lastRun,
    };
    this.bar.lastRun = null;
    this.setBarInput("");
    session.ask(query, context);
  }

  private rejectCommand(): void {
    if (this.bar.written == null || this.bar.before == null) return;
    const before = this.bar.before;
    this.editor.gesture(() => this.shell.zsh.setBuffer(before));
    this.forgetWritten();
    this.setBarInput(this.bar.lastQuery);
  }

  private runCommand(): void {
    if (!this.editor.state || this.bar.busy) return;
    this.editor.gesture((geometry) => {
      this.bar.lastRun = { command: geometry.state.buffer, exitCode: null };
      this.shell.zsh.write("\r");
    });
  }

  private submitBar(): void {
    if (this.bar.text.trim()) this.askAi();
    else if (this.isReady()) this.runCommand();
  }
}
