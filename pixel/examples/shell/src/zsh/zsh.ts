import { parseCompletions } from "../completion/complete";
import type { CompletionList } from "../completion/complete";
import { GESTURE_KEYS, MARKER_CODE, encodeCommand } from "./startup";

export interface LineEditor {
  keymap: string;
  cursor: number;
  mark: number;
  regionActive: boolean;
  buffer: string;
  postdisplay: string;
  predisplay: string;
  highlight: string[];
  change: number;
  history: number;
}

export interface ZshEvents {
  prompt(exitCode: number, cwd: string, boundGestures: Set<string>, newest: { event: number; line: string } | null): void;
  commandStarted(): void;
  editor(state: LineEditor | null): void;
  completions(list: CompletionList): void;
  historyLines(chunk: { newest: number; oldest: number; lines: string[] } | null): void;
}

function encodeArgument(text: string): string {
  return [...Buffer.from(text)].map((b) => (/[A-Za-z0-9]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).padStart(2, "0")}`)).join("");
}

function decodeMarker(text: string): string {
  return text.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

export class Zsh {
  private readonly prefix: Buffer;
  private carry = Buffer.alloc(0);
  atPrompt = false;
  awaitingReport = false;

  constructor(
    nonce: string,
    private readonly input: (data: Buffer | string) => void,
    private readonly events: ZshEvents,
  ) {
    this.prefix = Buffer.from(`\x1b]${MARKER_CODE};${nonce};`);
  }

  write(data: Buffer | string): void {
    this.awaitingReport = true;
    this.input(data);
  }

  receive(data: Buffer): Buffer {
    let buffer = this.carry.length ? Buffer.concat([this.carry, data]) : data;
    this.carry = Buffer.alloc(0);
    const out: Buffer[] = [];
    while (buffer.length) {
      const at = buffer.indexOf(this.prefix);
      if (at < 0) {
        const keep = partialPrefix(buffer, this.prefix);
        out.push(buffer.subarray(0, buffer.length - keep));
        this.carry = Buffer.from(buffer.subarray(buffer.length - keep));
        break;
      }
      const end = buffer.indexOf(0x07, at + this.prefix.length);
      if (end < 0) {
        out.push(buffer.subarray(0, at));
        this.carry = Buffer.from(buffer.subarray(at));
        break;
      }
      out.push(buffer.subarray(0, at));
      this.marker(buffer.subarray(at + this.prefix.length, end).toString("utf8"));
      buffer = buffer.subarray(end + 1);
    }
    return out.length === 1 ? out[0] : Buffer.concat(out);
  }

  setCursor(offset: number): void {
    this.command(`cursor ${offset}`);
  }

  select(mark: number, cursor: number): void {
    this.command(`select ${mark} ${cursor}`);
  }

  insert(text: string): void {
    this.command(`insert ${encodeArgument(text)}`);
  }

  extend(direction: "left" | "right" | "word-left" | "word-right" | "home" | "end"): void {
    this.command(`extend ${direction}`);
  }

  collapse(side: "left" | "right" | "here"): void {
    this.command(`collapse ${side}`);
  }

  setBuffer(text: string): void {
    this.command(`set ${encodeArgument(text)}`);
  }

  undo(change?: number): void {
    this.command(change == null ? "undo" : `undo ${change}`);
  }

  redo(change?: number): void {
    this.command(change == null ? "redo" : `redo ${change}`);
  }

  complete(): void {
    this.command("complete");
  }

  acceptCompletion(generation: number, index: number): void {
    this.command(`accept ${generation} ${index}`);
  }

  historyLines(before: number, count: number): void {
    this.command(`history-lines ${before} ${count}`);
  }

  acceptHistory(generation: number, index: number): void {
    this.command(`history ${generation} ${index}`);
  }

  sendNoOpKey(): void {
    this.command("sync");
  }

  private command(line: string): void {
    this.write(encodeCommand(line));
  }

  private marker(body: string): void {
    const [kind, ...rest] = body.split(";");
    if (kind === "D") {
      const [code, cwd, bound = "", event, line] = rest;
      this.atPrompt = true;
      const names = Object.keys(GESTURE_KEYS);
      const newest = event && Number(event) > 0 ? { event: Number(event), line: decodeMarker(line ?? "") } : null;
      this.events.prompt(Number(code), decodeMarker(cwd), new Set(names.filter((_, i) => bound[i] === "1")), newest);
    } else if (kind === "C") {
      this.atPrompt = false;
      this.events.commandStarted();
    } else if (kind === "E") {
      const [keymap, cursor, mark, region, buffer, post, pre, highlight, change, history] = rest;
      this.awaitingReport = false;
      this.events.editor({
        keymap,
        cursor: Number(cursor),
        mark: Number(mark),
        regionActive: region !== "0",
        buffer: decodeMarker(buffer),
        postdisplay: decodeMarker(post),
        predisplay: decodeMarker(pre),
        highlight: highlight ? decodeMarker(highlight).split("\n") : [],
        change: Number(change),
        history: Number(history),
      });
    } else if (kind === "H") {
      const [newest, oldest, lines] = rest;
      this.events.historyLines(newest === "skip" ? null : { newest: Number(newest), oldest: Number(oldest), lines: lines ? lines.split("\x1e").map(decodeMarker) : [] });
    } else if (kind === "M") {
      this.events.completions(parseCompletions(body.slice(2)));
    } else if (kind === "F") {
      this.events.editor(null);
    }
  }
}

function partialPrefix(buffer: Buffer, prefix: Buffer): number {
  for (let keep = Math.min(prefix.length - 1, buffer.length); keep > 0; keep--) {
    if (buffer.subarray(buffer.length - keep).equals(prefix.subarray(0, keep))) return keep;
  }
  return 0;
}
