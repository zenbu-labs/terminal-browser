import type { IPty } from "node-pty";

import { InputParser } from "./input";
import type { Unit } from "./input";
import { KITTY_DISAMBIGUATE_FLAG, legacyKey } from "./keys";
import type { ZshLaunch } from "./launch";
import { trace } from "../log";
import { TerminalQueries, tap, writeOut } from "./tty";
import { UnseenRows } from "./unseen";
import { Vt, sgr } from "./vt";
import { Zsh } from "../zsh/zsh";
import type { ZshEvents } from "../zsh/zsh";

const SCROLLBACK = 10_000;
const CUT_OFF_SEQUENCE_WAIT_MS = 10;
const FULL_RESET = "\x1bc";
const KEYBOARD_MODE_ANSWER = /^\x1b\[\?\d+u$/;
const DEFAULT_CELL = { width: 8, height: 16 };
const CURSOR_ANSWER_WAIT_MS = 200;

interface ShellHooks extends Partial<ZshEvents> {
  beforeOutput?(): void;
  afterOutput?(data: Buffer): void;
  input?(unit: Unit): boolean;
  resized?(): void;
  answered?(kind: string): void;
}

export class Shell {
  readonly vt: Vt;
  readonly zsh: Zsh;
  readonly queries = new TerminalQueries();
  readonly parser = new InputParser();
  readonly unseen: UnseenRows;
  hooks: ShellHooks = {};
  size: { cols: number; rows: number };
  private heldTimer: NodeJS.Timeout | null = null;
  private kittyPushed = false;
  private outgoing: Buffer[] = [];
  private exited = false;
  private heldOutput: Buffer[] | null = null;
  private cursorAnswersDue = 0;
  private cursorWait: NodeJS.Timeout | null = null;
  private lineUpAfterAnswer: (() => void) | null = null;

  constructor(
    private readonly pty: IPty,
    launch: ZshLaunch,
    size: { cols: number; rows: number },
    private readonly onExit: (code: number) => void,
  ) {
    this.size = size;
    this.vt = new Vt(size.cols, size.rows, { scrollback: SCROLLBACK });
    this.unseen = new UnseenRows(this.vt);
    this.zsh = new Zsh(launch.nonce, (data) => {
      this.send(data);
      this.flushOutgoing();
    }, {
      prompt: (...args) => this.hooks.prompt?.(...args),
      commandStarted: () => this.hooks.commandStarted?.(),
      editor: (state) => this.hooks.editor?.(state),
      completions: (list) => this.hooks.completions?.(list),
      historyLines: (chunk) => this.hooks.historyLines?.(chunk),
    });
    this.queries.onAnswer = (kind) => {
      if (kind === "cursor") return this.cursorAnswered();
      if (kind === "cell") this.applySize();
      this.hooks.answered?.(kind);
    };
    pty.onData((data) => this.output(data as unknown as Buffer));
    pty.onExit(({ exitCode, signal }) => this.finish(signal ? 128 + signal : exitCode));
  }

  get cell(): { width: number; height: number } {
    return this.queries.facts.cell ?? DEFAULT_CELL;
  }

  get waitingForCursor(): boolean {
    return this.heldOutput != null;
  }

  start(): void {
    this.askWhereTheCursorIs(() => this.startBelowWhatIsOnScreen());
    this.queries.ask("cell");
    this.queries.ask("foreground");
    this.queries.ask("background");
    this.queries.ask("palette", "3");
    this.queries.ask("version");
    this.pushKittyOnMainScreen();
  }

  private output(data: Buffer): void {
    if (this.heldOutput) {
      this.heldOutput.push(data);
      return;
    }
    tap("raw", data);
    const clean = this.zsh.receive(data);
    if (!clean.length) return;
    this.hooks.beforeOutput?.();
    writeOut(clean, "shell");
    this.unseen.write(clean);
    if (this.kittyPushed && clean.includes(FULL_RESET)) this.kittyPushed = false;
    if (!this.kittyPushed) this.pushKittyOnMainScreen();
    this.hooks.afterOutput?.(clean);
  }

  private askWhereTheCursorIs(lineUp: () => void): void {
    this.heldOutput ??= [];
    this.lineUpAfterAnswer = lineUp;
    this.cursorAnswersDue++;
    this.queries.ask("cursor");
    if (this.cursorWait) clearTimeout(this.cursorWait);
    this.cursorWait = setTimeout(() => {
      this.cursorAnswersDue = 0;
      this.queries.facts.cursor = null;
      this.lineUp();
    }, CURSOR_ANSWER_WAIT_MS);
  }

  private cursorAnswered(): void {
    this.cursorAnswersDue = Math.max(0, this.cursorAnswersDue - 1);
    if (this.cursorAnswersDue || !this.heldOutput) return;
    this.lineUp();
  }

  private lineUp(): void {
    if (this.cursorWait) clearTimeout(this.cursorWait);
    this.cursorWait = null;
    const lineUp = this.lineUpAfterAnswer;
    this.lineUpAfterAnswer = null;
    lineUp?.();
    const held = this.heldOutput ?? [];
    this.heldOutput = null;
    for (const data of held) this.output(data);
  }

  private startBelowWhatIsOnScreen(): void {
    const answer = this.queries.facts.cursor;
    if (answer) {
      this.vt.write(`\x1b[${answer.row + 1};${answer.col + 1}H`);
      this.unseen.startAbove(answer.col > 0 ? answer.row + 1 : answer.row);
      return;
    }
    const assumeTheBottomRow = `\x1b[${this.size.rows};1H`;
    writeOut(assumeTheBottomRow);
    this.vt.write(assumeTheBottomRow);
    this.unseen.startAbove(this.size.rows - 1);
  }

  private lineUpAfterReflow(): void {
    const answer = this.queries.facts.cursor;
    const info = this.vt.info();
    if (answer && !info.altScreen && this.vt.atGround()) {
      const shift = answer.row - info.cursorY;
      if (shift > 0) this.vt.write(`\x1b[H\x1b[${shift}L`);
      if (shift < 0) this.vt.write(`\x1b[H\x1b[${-shift}M`);
      this.vt.write(`\x1b[${answer.row + 1};${answer.col + 1}H`);
      this.unseen.shifted(shift);
    }
    this.hooks.resized?.();
    this.unseen.atLeastAboveCursor();
  }

  scrollUp(lines: number): number {
    const info = this.vt.info();
    const scrolled = Math.min(lines, info.cursorY);
    if (scrolled <= 0 || this.heldOutput || info.altScreen || info.pendingWrap || !this.vt.atGround()) return 0;
    const bytes = `\x1b[0m\x1b[${info.rows};1H${"\n".repeat(scrolled)}\x1b[${info.cursorY - scrolled + 1};${info.cursorX + 1}H${sgr(this.vt.pen())}`;
    writeOut(bytes);
    this.unseen.write(Buffer.from(bytes));
    return scrolled;
  }

  private pushKittyOnMainScreen(): void {
    if (this.kittyPushed || this.vt.info().altScreen || !this.vt.atGround()) return;
    writeOut(`\x1b[>${KITTY_DISAMBIGUATE_FLAG}u`);
    this.kittyPushed = true;
  }

  get keysInKittyForm(): boolean {
    if (!this.kittyPushed) return false;
    const info = this.vt.info();
    return !info.altScreen && info.kittyFlags === 0;
  }

  input(data: Buffer): void {
    if (this.heldTimer) {
      clearTimeout(this.heldTimer);
      this.heldTimer = null;
    }
    for (const unit of this.parser.feed(data)) this.route(unit);
    if (this.parser.pending) {
      this.heldTimer = setTimeout(() => {
        this.heldTimer = null;
        for (const unit of this.parser.flush()) this.route(unit);
        this.flushOutgoing();
      }, CUT_OFF_SEQUENCE_WAIT_MS);
    }
    this.flushOutgoing();
  }

  private route(unit: Unit): void {
    if (unit.kind !== "paste" && this.queries.take(unit.bytes)) return;
    trace("input", unit.kind, unit.bytes.toString("latin1"));
    if (this.hooks.input?.(unit)) return;
    this.forward(unit);
  }

  forward(unit: Unit): void {
    this.send(this.encode(unit));
  }

  encode(unit: Unit): Buffer {
    if (unit.kind === "key" && this.keysInKittyForm) return legacyKey(unit.key, this.vt);
    if (unit.kind === "other" && this.keysInKittyForm && KEYBOARD_MODE_ANSWER.test(unit.bytes.toString("latin1"))) {
      return Buffer.from(`\x1b[?${this.vt.info().kittyFlags}u`);
    }
    return unit.bytes;
  }

  send(bytes: Buffer | string): void {
    if (!bytes.length) return;
    this.outgoing.push(typeof bytes === "string" ? Buffer.from(bytes) : bytes);
  }

  flushOutgoing(): void {
    if (!this.outgoing.length || this.exited) return;
    const data = Buffer.concat(this.outgoing);
    this.outgoing = [];
    this.zsh.awaitingReport = true;
    tap("zsh", data);
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this.size = { cols, rows };
    this.applySize();
    this.queries.ask("cell");
  }

  private applySize(): void {
    const { cols, rows } = this.size;
    const { width, height } = this.cell;
    const before = this.vt.info();
    const unseenRowsMayHaveMoved = this.unseen.rows > 0 && !before.altScreen && (before.cols !== cols || before.rows !== rows);
    this.vt.resize(cols, rows, width, height);
    if (!this.exited) this.pty.resize(cols, rows, { width: cols * width, height: rows * height });
    if (!unseenRowsMayHaveMoved) {
      this.hooks.resized?.();
      return;
    }
    this.unseen.reflowed();
    this.askWhereTheCursorIs(() => this.lineUpAfterReflow());
  }

  stop(): void {
    if (this.kittyPushed && !this.vt.info().altScreen) writeOut("\x1b[<u");
    this.kittyPushed = false;
  }

  private finish(code: number): void {
    if (this.exited) return;
    if (this.heldOutput) this.lineUp();
    this.exited = true;
    this.onExit(code);
  }
}
