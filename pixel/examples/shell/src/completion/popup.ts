import { chordName } from "../terminal/chords";
import { HistoryCache, completionMove, completionRows, historyItem, historyRows, moveSelection, narrowCompletions, popupPlacement, scrollTop, typedSince, wordStart } from "./complete";
import type { CompletionItem, CompletionList } from "./complete";
import type { KeyEvent } from "../terminal/input";
import { trace } from "../log";
import type { CompletionView, Rect } from "../protocol";
import type { Shell } from "../terminal/shell";
import { COMPLETION_VISIBLE_ROWS, completionChrome, completionSizes, completionWidth } from "../view/sizes";
import { INSERT_KEYMAPS } from "../ui/editor";
import type { Editor } from "../ui/editor";
import type { Presenter } from "../ui/presenter";
import type { LineEditor } from "../zsh/zsh";

const COMPLETION_TYPING_PAUSE_MS = 60;
const COMPLETION_GIVE_UP_MS = 2000;
const COMPLETION_EMPTY_MS = 1500;
const HISTORY_LOAD_CHUNK_LINES = 2000;
const HISTORY_LOAD_AFTER_IDLE_MS = 1000;

// fixme: placeholder copy
const NO_COMPLETIONS = "No completions";

interface CompletionSession {
  start: number;
  before: string;
  list: CompletionList | null;
  listFor: { buffer: string; cursor: number } | null;
  rows: CompletionItem[];
  shown: CompletionItem[];
  left: string;
  details: boolean;
  side: "below" | "above" | null;
  growsDown: boolean;
  visible: number;
  width: number;
  selected: number;
  top: number;
  asked: { buffer: string; cursor: number } | null;
  inFlight: boolean;
  again: boolean;
  timer: NodeJS.Timeout | null;
  accepting: { word: string; history: boolean } | null;
  empty: string | null;
  typedPastEveryRow: boolean;
}

export class Popup {
  private completion: CompletionSession | null = null;
  private historyCache = new HistoryCache();
  private historyLoad = { timer: null as NodeJS.Timeout | null, asked: 0, lastKey: 0 };
  private lastList: { list: CompletionList; listFor: { buffer: string; cursor: number }; rows: CompletionItem[]; width: number } | null = null;

  constructor(
    private readonly shell: Shell,
    private readonly editor: Editor,
    private readonly presenter: Presenter,
    private readonly closeMenu: () => void,
  ) {}

  prompt(newest: { event: number; line: string } | null): void {
    if (newest) this.historyCache.add(newest.event, newest.line);
    this.loadHistoryWhenIdle();
  }

  historyLines(chunk: { newest: number; oldest: number; lines: string[] } | null): void {
    this.historyLoad.asked = 0;
    if (chunk) this.historyCache.addChunk(chunk);
    this.loadHistoryWhenIdle(chunk ? 30 : HISTORY_LOAD_AFTER_IDLE_MS);
  }

  postponeHistoryLoad(): void {
    this.historyLoad.lastKey = Date.now();
  }

  editorReported(state: LineEditor | null): void {
    if (this.completion) this.followLine(state);
  }

  view(): CompletionView | null {
    const c = this.completion;
    const state = this.editor.state;
    const info = this.shell.vt.info();
    if (!c || !state || (!c.shown.length && c.empty == null && c.list != null) || info.altScreen || !this.presenter.scaleKnown) return null;
    const s = this.presenter.scale();
    const { cols, rows } = this.shell.size;
    const { width: cw, height: ch } = this.shell.cell;
    const caret = this.caret(state);
    const sizes = completionSizes(s);
    // fixme: placeholder copy
    const empty = c.empty ?? (c.shown.length ? null : "…");
    const width = c.empty != null ? Math.round(200 * s) : Math.max(c.width, sizes.width);
    const more = c.empty == null && c.list ? c.list.total - c.list.items.length : 0;
    const paneWidth = cols * cw;
    const shownRows = empty != null ? 1 : Math.min(COMPLETION_VISIBLE_ROWS, c.shown.length);
    const placement = (wanted: number, side?: "below" | "above") =>
      popupPlacement({
        caret,
        cell: { width: cw, height: ch },
        pane: { width: paneWidth, height: (rows + (c.growsDown ? caret.row : 0)) * ch },
        width,
        rowHeight: sizes.row,
        chrome: completionChrome(c.shown, c.top, wanted, empty != null, more, s),
        rows: wanted,
        side,
      });
    if (!c.side) {
      const wanted = c.list ? shownRows : COMPLETION_VISIBLE_ROWS;
      const first = placement(wanted);
      c.side = first.side;
      if (first.side === "above" && first.top < this.shell.unseen.rows * ch) {
        c.side = "below";
        c.growsDown = true;
      }
    }
    const { left, top, visible, height } = placement(shownRows, c.side);
    if (empty == null && visible !== c.visible) {
      c.visible = visible;
      c.top = scrollTop(c.top, c.selected, visible, c.shown.length);
    }
    const focused = c.shown[c.selected];
    const detailsItem = c.details && c.empty == null && focused?.description ? focused : null;
    const gap = Math.round(6 * s);
    const detailsWidth = Math.min(sizes.detailsWidth, Math.max(paneWidth - left - width, left) - gap);
    const detailsLeft = left + width + gap + detailsWidth <= paneWidth ? left + width + gap : Math.max(0, left - detailsWidth - gap);
    return {
      left,
      top,
      rows: c.shown,
      selected: c.selected,
      top_: c.top,
      visible,
      width,
      empty,
      more,
      details: detailsItem
        ? { inset: c.side === "above" ? { left: detailsLeft, bottom: rows * ch - (top + height) } : { left: detailsLeft, top }, width: detailsWidth, item: detailsItem }
        : null,
    };
  }

  get isOpen(): boolean {
    return this.completion != null;
  }

  linesToScrollFor(rect: Rect | null | undefined): number {
    const c = this.completion;
    const state = this.editor.state;
    if (!c?.growsDown || !state || !rect) return 0;
    const { height: ch } = this.shell.cell;
    const caret = this.caret(state);
    if (Math.abs(rect.y - (caret.row + 1) * ch) > 1) return 0;
    const overflow = rect.y + rect.height - this.shell.size.rows * ch;
    return overflow > 0 ? Math.min(caret.row, Math.ceil(overflow / ch)) : 0;
  }

  private caret(state: LineEditor): { row: number; col: number } {
    const places = this.editor.linePlaces();
    const { cursorX, cursorY } = this.shell.vt.info();
    return places?.[Math.min(state.cursor, places.length - 1)] ?? { row: cursorY, col: cursorX };
  }

  close(): void {
    const c = this.completion;
    if (!c) return;
    if (c.list && c.listFor && c.empty == null) this.lastList = { list: c.list, listFor: c.listFor, rows: c.rows, width: c.width };
    if (c.timer) clearTimeout(c.timer);
    this.completion = null;
    this.presenter.sync();
  }

  open(state: LineEditor): boolean {
    if (!INSERT_KEYMAPS.has(state.keymap)) return false;
    if (this.completion) {
      this.close();
      return true;
    }
    trace("completion open", Date.now());
    const start = wordStart(state.buffer, state.cursor);
    const c: CompletionSession = {
      start,
      before: Array.from(state.buffer).slice(0, start).join(""),
      list: null,
      listFor: null,
      rows: [],
      shown: [],
      left: "",
      details: false,
      side: null,
      growsDown: false,
      visible: COMPLETION_VISIBLE_ROWS,
      width: 0,
      selected: -1,
      top: 0,
      asked: null,
      inFlight: false,
      again: false,
      timer: null,
      accepting: null,
      empty: null,
      typedPastEveryRow: false,
    };
    this.completion = c;
    const last = this.lastList;
    if (last && last.listFor.buffer === state.buffer && last.listFor.cursor === state.cursor) Object.assign(c, { list: last.list, listFor: last.listFor, rows: last.rows, width: last.width });
    this.closeMenu();
    this.presenter.start();
    this.showCompletions(c);
    this.askCompletions();
    return true;
  }

  receive(list: CompletionList): void {
    trace("completions", list.items.length, list.total, Date.now());
    const c = this.completion;
    if (!c || !c.asked) return;
    const first = c.list == null;
    c.listFor = c.asked;
    c.asked = null;
    c.inFlight = false;
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    const rows = completionRows(list);
    const history = historyRows(list, Array.from(c.listFor.buffer).slice(0, c.listFor.cursor).join(""));
    const accepting = c.accepting;
    if (accepting != null) {
      const wanted = (accepting.history ? history : rows).find((item) => item.word === accepting.word) ?? history[0] ?? rows[0];
      if (wanted) this.insertCompletion(list, wanted);
      else this.close();
      return;
    }
    if (!rows.length && !history.length) {
      if (!first) {
        this.close();
        return;
      }
      c.list = list;
      c.empty = list.messages[0] ?? NO_COMPLETIONS;
      c.timer = setTimeout(() => {
        if (this.completion === c) this.close();
      }, COMPLETION_EMPTY_MS);
      this.presenter.sync();
      return;
    }
    if (first && rows.length === 1 && !history.length) {
      this.insertCompletion(list, rows[0]);
      return;
    }
    c.list = list;
    c.rows = rows;
    c.width = completionWidth([...history, ...rows], this.presenter.scale(), this.completionMaxWidth());
    this.showCompletions(c);
    const state = this.editor.state;
    if (c.again || (state && (state.buffer !== c.listFor.buffer || state.cursor !== c.listFor.cursor))) this.askCompletions(COMPLETION_TYPING_PAUSE_MS);
  }

  accept(row = this.completion?.selected ?? -1): void {
    const c = this.completion;
    const picked = c?.shown[row];
    if (!c || !picked) return;
    const state = this.editor.state;
    if (c.list && !c.inFlight && c.listFor && state && !this.shell.zsh.awaitingReport && state.buffer === c.listFor.buffer && state.cursor === c.listFor.cursor) {
      this.insertCompletion(c.list, picked);
      return;
    }
    c.accepting = { word: picked.word, history: picked.history };
    if (!c.inFlight) this.askCompletions();
  }

  scroll(rows: number): void {
    const c = this.completion;
    if (!c) return;
    c.top = Math.max(0, Math.min(c.shown.length - c.visible, c.top + rows));
    this.presenter.sync();
  }

  handleKey(event: KeyEvent): boolean {
    const c = this.completion;
    if (!c) return false;
    const chord = chordName(event);
    if (!c.list && !c.shown.length && c.empty == null && (chord === "enter" || chord === "tab")) {
      c.accepting = { word: "", history: false };
      return true;
    }
    if (c.shown.length && c.empty == null && !c.accepting) {
      const page = Math.max(1, c.visible - 1);
      const move = completionMove(chord, page);
      if (move != null) {
        this.moveCompletion(move);
        return true;
      }
      if (chord === "enter" || chord === "tab") {
        if (c.typedPastEveryRow) this.close();
        else this.accept();
        return true;
      }
      if (chord === "ctrl+space") {
        c.details = !c.details;
        this.presenter.sync();
        return true;
      }
    }
    if (c.accepting) return true;
    if (chord === "enter" || chord === "tab") {
      this.close();
      return true;
    }
    const { ctrl, alt, super: cmd } = event.mods;
    const typed = !ctrl && !alt && !cmd && (event.text ?? ([...event.key].length === 1 ? event.key : ""));
    const keepsHistory = typed && this.historyLinesFor(c, c.left + typed, c.left + typed) > 0;
    if (chord === "ctrl+space" || chord === "backspace" || (typed && (!/\s/.test(typed) || keepsHistory) && c.empty == null)) return false;
    this.close();
    return false;
  }

  private loadHistoryWhenIdle(delay = HISTORY_LOAD_AFTER_IDLE_MS): void {
    const load = this.historyLoad;
    if (load.timer) clearTimeout(load.timer);
    load.timer = setTimeout(() => {
      load.timer = null;
      const from = this.historyCache.next();
      if (from == null || (load.asked && Date.now() - load.asked < 2000)) return;
      if (!this.editor.state || this.completion || Date.now() - load.lastKey < HISTORY_LOAD_AFTER_IDLE_MS) {
        this.loadHistoryWhenIdle();
        return;
      }
      load.asked = Date.now();
      this.editor.gesture(() => this.shell.zsh.historyLines(from, HISTORY_LOAD_CHUNK_LINES));
    }, delay);
    load.timer.unref();
  }

  private askCompletions(delay = 0): void {
    const c = this.completion;
    if (!c) return;
    if (c.inFlight) {
      c.again = true;
      return;
    }
    if (c.timer) clearTimeout(c.timer);
    c.timer = setTimeout(() => {
      c.timer = null;
      if (this.completion !== c) return;
      c.inFlight = true;
      c.again = false;
      this.editor.gesture((geometry) => {
        trace("completion asked", Date.now());
        c.asked = { buffer: geometry.state.buffer, cursor: geometry.state.cursor };
        this.shell.zsh.complete();
      });
      c.timer = setTimeout(() => {
        c.timer = null;
        if (this.completion !== c || !c.inFlight) return;
        if (c.list) c.inFlight = false;
        else this.close();
      }, COMPLETION_GIVE_UP_MS);
    }, delay);
  }

  private completionMaxWidth(): number {
    const { cols } = this.shell.size;
    const cw = this.shell.cell.width;
    return cols * cw - 2 * cw;
  }

  private insertCompletion(list: CompletionList, item: CompletionItem): void {
    this.close();
    this.editor.gesture(() => (item.history ? this.shell.zsh.acceptHistory(list.generation, item.index) : this.shell.zsh.acceptCompletion(list.generation, item.index)));
  }

  private historyLinesFor(c: CompletionSession, left: string, line: string): number {
    return (c.list ? historyRows(c.list, left) : this.historyCache.upArrow(left, line)).length;
  }

  private showCompletions(c: CompletionSession): void {
    const state = this.editor.state ?? c.listFor;
    if (!state) return;
    const left = Array.from(state.buffer).slice(0, state.cursor).join("");
    let rows: CompletionItem[];
    if (c.list && c.listFor) {
      const typed = typedSince(c.listFor, state);
      const completions = typed ? completionRows(c.list, narrowCompletions(c.list, typed), typed) : c.rows;
      rows = [...historyRows(c.list, left), ...completions];
    } else {
      rows = this.historyCache.upArrow(left, state.buffer).map((line) => historyItem(line, 0));
      c.width = completionWidth(rows, this.presenter.scale(), this.completionMaxWidth());
    }
    c.typedPastEveryRow = !rows.length && c.shown.length > 0;
    if (c.typedPastEveryRow) {
      this.presenter.sync();
      return;
    }
    const previous = c.shown[c.selected];
    c.shown = rows;
    c.left = left;
    const kept = previous == null ? -1 : rows.findIndex((item) => item.word === previous.word && item.history === previous.history);
    c.selected = kept >= 0 ? kept : moveSelection(rows.length, -1, 0);
    c.top = scrollTop(kept >= 0 ? c.top : 0, c.selected, c.visible, rows.length);
    this.presenter.sync();
  }

  private followLine(state: LineEditor | null): void {
    const c = this.completion!;
    if (!state || !INSERT_KEYMAPS.has(state.keymap)) {
      this.close();
      return;
    }
    const chars = Array.from(state.buffer);
    const start = wordStart(state.buffer, state.cursor);
    if (state.cursor < c.start || start !== c.start || chars.slice(0, c.start).join("") !== c.before) {
      if (!this.historyLinesFor(c, chars.slice(0, state.cursor).join(""), state.buffer)) {
        this.close();
        return;
      }
      c.start = start;
      c.before = chars.slice(0, start).join("");
    }
    if (c.empty != null) return;
    this.showCompletions(c);
    const changed = !c.listFor || state.buffer !== c.listFor.buffer || state.cursor !== c.listFor.cursor;
    if (changed && c.list) this.askCompletions(c.accepting != null ? 0 : COMPLETION_TYPING_PAUSE_MS);
  }

  private moveCompletion(delta: number): void {
    const c = this.completion;
    if (!c) return;
    c.selected = moveSelection(c.shown.length, c.selected, delta);
    c.top = scrollTop(c.top, c.selected, c.visible, c.shown.length);
    this.presenter.sync();
  }
}
