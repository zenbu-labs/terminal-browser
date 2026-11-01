import fs from "node:fs";

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

const tapFd = process.env.PXSH_TAP ? fs.openSync(process.env.PXSH_TAP, "w") : null;

export function tap(from: "shell" | "pxsh" | "raw" | "zsh", bytes: Buffer): void {
  if (tapFd == null) return;
  const header = Buffer.alloc(5);
  header[0] = { shell: 0x73, pxsh: 0x70, raw: 0x72, zsh: 0x7a }[from];
  header.writeUInt32LE(bytes.length, 1);
  fs.writeSync(tapFd, Buffer.concat([header, bytes]));
}

export function writeOut(data: Buffer | string, from: "shell" | "pxsh" = "pxsh"): void {
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  tap(from, bytes);
  let written = 0;
  while (written < bytes.length) {
    try {
      written += fs.writeSync(1, bytes, written);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
      Atomics.wait(SLEEP_CELL, 0, 0, 1);
    }
  }
}

type Rgb = [number, number, number];

interface TerminalFacts {
  cell: { width: number; height: number } | null;
  foreground: Rgb | null;
  background: Rgb | null;
  palette: Map<number, Rgb>;
  version: string | null;
  cursor: { row: number; col: number } | null;
}

const QUERIES = {
  cell: { ask: "\x1b[16t", answer: /^\x1b\[6;(\d+);(\d+)t$/ },
  foreground: { ask: "\x1b]10;?\x1b\\", answer: /^\x1b\]10;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)(\x07|\x1b\\)$/i },
  background: { ask: "\x1b]11;?\x1b\\", answer: /^\x1b\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)(\x07|\x1b\\)$/i },
  palette: { ask: "", answer: /^\x1b\]4;(\d+);rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)(\x07|\x1b\\)$/i },
  version: { ask: "\x1b[>q", answer: /^\x1bP>\|([^\x1b]*)\x1b\\$/ },
  cursor: { ask: "\x1b[6n", answer: /^\x1b\[(\d+);(\d+)R$/ },
} as const;

type QueryKind = keyof typeof QUERIES;

const ANSWER_WAIT_MS = 1000;

function channel(hex: string): number {
  return Math.round((parseInt(hex, 16) / (16 ** hex.length - 1)) * 255);
}

export class TerminalQueries {
  readonly facts: TerminalFacts = { cell: null, foreground: null, background: null, palette: new Map(), version: null, cursor: null };
  private waiting: { kind: QueryKind; until: number }[] = [];
  onAnswer: ((kind: QueryKind) => void) | null = null;

  ask(kind: QueryKind, extra = ""): void {
    writeOut(kind === "palette" ? `\x1b]4;${extra};?\x1b\\` : QUERIES[kind].ask);
    this.waiting.push({ kind, until: Date.now() + ANSWER_WAIT_MS });
  }

  take(bytes: Buffer): boolean {
    if (!this.waiting.length) return false;
    const now = Date.now();
    this.waiting = this.waiting.filter((w) => w.until > now);
    const text = bytes.toString("latin1");
    for (let i = 0; i < this.waiting.length; i++) {
      const { kind } = this.waiting[i];
      const match = QUERIES[kind].answer.exec(text);
      if (!match) continue;
      this.waiting.splice(i, 1);
      if (kind === "cell") this.facts.cell = { width: Number(match[2]), height: Number(match[1]) };
      else if (kind === "version") this.facts.version = match[1];
      else if (kind === "cursor") this.facts.cursor = { row: Number(match[1]) - 1, col: Number(match[2]) - 1 };
      else if (kind === "palette") this.facts.palette.set(Number(match[1]), [channel(match[2]), channel(match[3]), channel(match[4])]);
      else this.facts[kind] = [channel(match[1]), channel(match[2]), channel(match[3])];
      this.onAnswer?.(kind);
      return true;
    }
    return false;
  }
}

export function ghosttyEatsReleasesAtThePrompt(version: string | null): boolean {
  const ghostty = version && /^ghostty (\d+)\.(\d+)/.exec(version);
  return !!ghostty && (Number(ghostty[1]) < 1 || (Number(ghostty[1]) === 1 && Number(ghostty[2]) < 4));
}
