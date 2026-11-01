import { execFileSync } from "node:child_process";

import { Bar } from "../ai/bar";
import { Popup } from "../completion/popup";
import { GUI_CHORDS, chordName } from "../terminal/chords";
import type { GuiAction } from "../terminal/chords";
import { isModifierKey } from "../terminal/input";
import type { MouseReport, Unit } from "../terminal/input";
import { logError, trace } from "../log";
import type { FromView, MenuView, ViewState } from "../protocol";
import type { Shell } from "../terminal/shell";
import { ghosttyEatsReleasesAtThePrompt } from "../terminal/tty";
import { indexAt } from "../zsh/layout";
import type { LineEditor } from "../zsh/zsh";
import { Editor, INSERT_KEYMAPS } from "./editor";
import { Presenter } from "./presenter";

const MENU = { askAi: "Ask AI", copy: "Copy", paste: "Paste", clear: "Clear" };

interface MenuItem {
  label: string;
  shortcut?: string;
  enabled?: boolean;
  run(): void;
}

export class Ui {
  private readonly presenter: Presenter;
  private readonly editor: Editor;
  private readonly bar: Bar;
  private readonly popup: Popup;
  private menu: { x: number; y: number; items: (MenuItem | "separator")[] } | null = null;
  private boundGestures = new Set<string>();
  private pressedInView = false;
  private releaseAlreadySent = false;
  private wasAlt = false;

  constructor(private readonly shell: Shell) {
    this.presenter = new Presenter(shell, {
      viewState: () => this.viewState(),
      hidesCursor: () => this.bar.hasFocus,
      viewMessage: (message) => this.viewMessage(message),
      linesToScrollFor: (regions) => Math.max(this.bar.linesToScrollFor(regions.bar), this.popup.linesToScrollFor(regions.completion)),
    });
    this.editor = new Editor(shell);
    this.bar = new Bar(shell, this.editor, this.presenter);
    this.popup = new Popup(shell, this.editor, this.presenter, () => {
      this.menu = null;
    });
    shell.hooks = {
      beforeOutput: () => this.presenter.lift(),
      afterOutput: () => this.afterOutput(),
      input: (unit) => this.input(unit),
      resized: () => this.presenter.resized(),
      prompt: (...args) => this.prompt(...args),
      commandStarted: () => this.commandStarted(),
      editor: (state) => this.editorReport(state),
      historyLines: (chunk) => this.popup.historyLines(chunk),
      completions: (list) => this.popup.receive(list),
    };
    shell.hooks.answered = (kind) => {
      if (kind === "cell") return;
      this.presenter.recolor();
    };
  }

  stop(): void {
    this.bar.stop();
    this.presenter.stop();
  }

  private viewMessage(message: FromView): void {
    switch (message.type) {
      case "pick":
        this.popup.accept(message.row);
        break;
      case "wheel":
        this.popup.scroll(message.rows);
        break;
      case "menu": {
        const item = this.menu?.items[message.index];
        this.menu = null;
        this.presenter.sync();
        if (item && item !== "separator") item.run();
        break;
      }
      default:
        this.bar.viewMessage(message);
    }
  }

  private afterOutput(): void {
    const info = this.shell.vt.info();
    if (info.altScreen !== this.wasAlt) {
      this.wasAlt = info.altScreen;
      if (info.altScreen) {
        this.menu = null;
        if (this.bar.isOpen) this.bar.close();
        this.popup.close();
        this.presenter.sync();
      }
    }
    this.editor.flush();
    this.bar.postponePreload();
    this.presenter.queuePresent();
  }

  private viewState(): ViewState {
    const info = this.shell.vt.info();
    return {
      colors: this.presenter.barColors(),
      menuColors: this.presenter.menuColors(),
      bar: this.bar.isOpen && !info.altScreen ? this.bar.view() : null,
      completion: this.popup.view(),
      menu: this.menu ? ({ x: this.menu.x, y: this.menu.y, items: this.menu.items.map((i) => (i === "separator" ? i : { label: i.label, shortcut: i.shortcut, enabled: i.enabled })) } satisfies MenuView) : null,
    };
  }

  private prompt(code: number, dir: string, bound: Set<string>, newest: { event: number; line: string } | null): void {
    this.boundGestures = bound;
    this.popup.prompt(newest);
    this.bar.prompt(code, dir);
    this.presenter.start();
  }

  private commandStarted(): void {
    this.popup.close();
    this.editor.commandStarted();
    this.bar.commandStarted();
  }

  private editorReport(state: LineEditor | null): void {
    const settled = this.editor.report(state);
    this.bar.editorReported(state, settled);
    this.popup.editorReported(state);
    this.editor.flush();
    this.presenter.sync();
  }

  private input(unit: Unit): boolean {
    try {
      switch (unit.kind) {
        case "key":
          this.key(unit);
          return true;
        case "paste":
          this.paste(unit);
          return true;
        case "mouse":
          if (!this.mouse(unit.mouse)) this.editor.send(unit.bytes);
          return true;
        case "focus":
          this.presenter.view?.focus(unit.focused);
          if (this.shell.vt.mode("focusEvents")) this.editor.send(unit.bytes);
          return true;
        default:
          this.editor.send(this.shell.encode(unit));
          return true;
      }
    } catch (error) {
      logError(error);
      this.editor.send(this.shell.encode(unit));
      return true;
    }
  }

  private key(unit: Extract<Unit, { kind: "key" }>): void {
    const event = unit.key;
    this.bar.postponePreload();
    this.popup.postponeHistoryLoad();
    if (event.kind === "release" || isModifierKey(event.key)) {
      if (this.bar.hasFocus) return;
      this.editor.send(this.shell.encode(unit));
      return;
    }
    if (this.bar.hasFocus) {
      this.bar.handleKey(event);
      return;
    }
    if (chordName(event) === "escape" && this.closeInnermost()) return;
    if (this.popup.handleKey(event)) return;
    const info = this.shell.vt.info();
    const { super: cmd, shift, alt, ctrl } = event.mods;
    const state = info.altScreen ? null : this.editor.state;
    const range = state ? this.editor.range(state) : null;
    const inserting = state != null && INSERT_KEYMAPS.has(state.keymap);
    trace("key", event.key, event.mods, event.text, state && { keymap: state.keymap, cursor: state.cursor, range });

    const action = GUI_CHORDS[chordName(event)];
    if (action && this.runGuiAction(action, state, range)) return;
    if (state && shift && !cmd && !ctrl) {
      const direction =
        event.key === "home" || event.key === "end"
          ? event.key
          : event.key === "left" || event.key === "right"
            ? alt
              ? (`word-${event.key}` as const)
              : event.key
            : null;
      if (direction && !this.boundGestures.has(`${alt ? "alt+" : ""}shift+${event.key}`)) {
        this.editor.extend(direction);
        return;
      }
    }
    if (state?.regionActive && this.editor.guiSelection && inserting && !cmd && !ctrl) {
      if (event.key === "backspace" || event.key === "delete") {
        this.editor.insert("");
        return;
      }
      const typed = event.text ?? ([...event.key].length === 1 ? (shift ? event.key.toUpperCase() : event.key) : null);
      if (typed && !alt) {
        this.editor.insert(typed);
        return;
      }
      if (event.key === "left" || event.key === "right") {
        this.editor.collapse(event.key);
        return;
      }
      if (event.key === "escape") this.editor.collapse("here");
    }
    this.editor.guiSelection = false;
    this.editor.send(this.shell.encode(unit));
  }

  private closeInnermost(): boolean {
    if (this.menu) {
      this.menu = null;
      this.presenter.sync();
    } else if (this.popup.isOpen) this.popup.close();
    else if (this.bar.isOpen) this.bar.dismiss();
    else return false;
    return true;
  }

  private paste(unit: Extract<Unit, { kind: "paste" }>): void {
    if (this.bar.hasFocus) {
      this.presenter.view?.paste(unit.text);
      return;
    }
    const info = this.shell.vt.info();
    const state = info.altScreen ? null : this.editor.state;
    const range = state ? this.editor.range(state) : null;
    if (state && range && this.editor.guiSelection && INSERT_KEYMAPS.has(state.keymap)) {
      this.editor.insert(unit.text);
      return;
    }
    this.editor.guiSelection = false;
    this.editor.send(unit.bytes, "paste");
  }

  private mouse(report: MouseReport): boolean {
    const info = this.shell.vt.info();
    const showing = this.presenter.showing;
    const { width: cw, height: ch } = this.shell.cell;
    const x = report.col * cw + cw / 2;
    const y = report.row * ch + ch / 2;
    const inView = this.presenter.regionAt(x, y);
    if (!showing || (info.mouseTracking && !inView)) return false;
    if (report.kind === "up" && this.releaseAlreadySent) {
      this.releaseAlreadySent = false;
      return true;
    }
    if (report.kind === "down") {
      this.releaseAlreadySent = false;
      this.pressedInView = inView;
      if (!inView) {
        this.menu = null;
        this.popup.close();
        this.bar.blur();
        if (report.button === "right") this.openMenu(x, y);
        if (report.button === "left") this.moveCaretTo(report);
        this.presenter.sync();
        return true;
      }
      if (this.menu && !this.presenter.regionNamed("menu", x, y)) {
        this.menu = null;
        this.presenter.sync();
      }
    }
    if (inView || report.kind === "move" || (report.kind === "up" && this.pressedInView)) {
      this.presenter.view?.mouse(report.kind, report.button, report.mods, x, y);
    }
    if (report.kind === "down" && inView && this.terminalWillKeepRelease(report)) {
      this.presenter.view?.mouse("up", report.button, report.mods, x, y);
      this.releaseAlreadySent = true;
    }
    return true;
  }

  private moveCaretTo(report: MouseReport): void {
    const places = this.editor.linePlaces();
    if (!this.editor.state || !places || this.shell.vt.info().altScreen || this.terminalWillKeepRelease(report)) return;
    const first = places[0];
    const last = places[places.length - 1];
    const cell = { row: report.row, col: report.col };
    const onLine = (cell.row > first.row || (cell.row === first.row && cell.col >= first.col)) && cell.row <= last.row;
    if (!onLine) return;
    this.editor.guiSelection = false;
    this.editor.gesture((geometry) => this.shell.zsh.setCursor(indexAt(geometry.places, cell)));
  }

  private terminalWillKeepRelease(report: MouseReport): boolean {
    const vt = this.shell.vt;
    const info = vt.info();
    if (report.button !== "left" || !this.editor.state || info.altScreen || !ghosttyEatsReleasesAtThePrompt(this.shell.queries.facts.version)) return false;
    const prompt = vt.newestPromptLineAtOrAbove(info.cursorY);
    return prompt != null && report.row >= prompt;
  }

  private runGuiAction(action: GuiAction, state: LineEditor | null, range: [number, number] | null): boolean {
    if (action === "copy") {
      const text = this.editor.selectedText();
      if (!text) return false;
      this.presenter.copyText(text);
    } else if (action === "ask-ai") return this.openBar();
    else if (!state) return false;
    else if (action === "complete") return this.popup.open(state);
    else if (action === "cut") {
      if (!range) return false;
      this.presenter.copyText(this.editor.selectedText());
      this.editor.insert("");
    } else if (action === "undo" || action === "redo") {
      this.editor.undoOrRedo(action);
    } else if (action === "select-line") {
      this.editor.selectLine(state);
    } else if (action === "newline") {
      this.editor.insert("\n");
    }
    return true;
  }

  private openBar(): boolean {
    if (this.shell.vt.info().altScreen) return false;
    this.popup.close();
    this.menu = null;
    this.bar.open();
    return true;
  }

  private openMenu(x: number, y: number): void {
    const info = this.shell.vt.info();
    const items: (MenuItem | "separator")[] = [
      ...(info.altScreen ? [] : [{ label: MENU.askAi, shortcut: "⇧⌘E", run: () => this.openBar() }, "separator" as const]),
      { label: MENU.copy, shortcut: "⌘C", enabled: this.editor.selectedText() !== "", run: () => this.presenter.copyText(this.editor.selectedText()) },
      { label: MENU.paste, shortcut: "⌘V", run: () => this.pasteFromClipboard() },
      "separator" as const,
      { label: MENU.clear, run: () => this.clearTerminal() },
    ];
    this.menu = { x, y, items };
  }

  private pasteFromClipboard(): void {
    try {
      const text = execFileSync("pbpaste", { encoding: "utf8" });
      const bracketed = this.shell.vt.mode("bracketedPaste");
      const bytes = Buffer.from(bracketed ? `\x1b[200~${text.replace(/\x1b\[201~/g, "")}\x1b[201~` : text);
      this.paste({ kind: "paste", bytes, text });
    } catch {}
  }

  private clearTerminal(): void {
    this.presenter.writeAtGround("\x1b[H\x1b[2J\x1b[3J");
    if (this.editor.state) this.editor.send("\x0c");
  }
}
