import fs from "node:fs";

export type ProtocolRange = [number, number];
export const PROTOCOL: ProtocolRange = [1, 1];
export function protocolRange(env: NodeJS.ProcessEnv = process.env): ProtocolRange {
  const given = env.PIXEL_PAIR_PROTOCOL?.match(/^(\d+)-(\d+)$/);
  return given ? [Number(given[1]), Number(given[2])] : PROTOCOL;
}
export function olderSide(mine: ProtocolRange, theirs: ProtocolRange): "mine" | "theirs" | null {
  if (mine[1] < theirs[0]) return "mine";
  if (theirs[1] < mine[0]) return "theirs";
  return null;
}

const KIND = { control: 0, out: 1, in: 2 } as const;

export const PING_MS = 2000;
export const DEAD_MS = 6000;
export const WINDOW_BYTES = 4 * 1024 * 1024;

export type Control = { type: string } & Record<string, unknown>;

export class Wire {
  heard = Date.now();
  open = true;
  onControl: (message: Control) => void = () => {};
  onOutput: (bytes: Buffer) => void = () => {};
  onInput: (bytes: Buffer) => void = () => {};

  constructor(private readonly deliver: (message: Uint8Array) => void) {}

  receive(message: Uint8Array) {
    if (!this.open || message.length < 1) return;
    this.heard = Date.now();
    const payload = Buffer.from(message.buffer, message.byteOffset + 1, message.length - 1);
    if (message[0] === KIND.out) this.onOutput(payload);
    else if (message[0] === KIND.in) this.onInput(payload);
    else if (message[0] === KIND.control) {
      let control: Control;
      try {
        control = JSON.parse(payload.toString("utf8")) as Control;
      } catch {
        return;
      }
      if (control.type !== "ping") this.onControl(control);
    }
  }

  private put(kind: number, payload: Buffer) {
    if (!this.open) return;
    const message = Buffer.allocUnsafe(1 + payload.length);
    message[0] = kind;
    payload.copy(message, 1);
    this.deliver(message);
  }

  send(control: Control) {
    this.put(KIND.control, Buffer.from(JSON.stringify(control)));
  }

  output(bytes: Buffer) {
    this.put(KIND.out, bytes);
  }

  input(bytes: Buffer) {
    this.put(KIND.in, bytes);
  }

  keepAlive(dead: () => void): () => void {
    const timer = setInterval(() => {
      if (Date.now() - this.heard > DEAD_MS) {
        clearInterval(timer);
        dead();
        return;
      }
      this.send({ type: "ping", t: Date.now() });
    }, PING_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}

const traceFile = process.env.PIXEL_PAIR_TRACE;
export function trace(event: string, fields: Record<string, unknown> = {}) {
  if (!traceFile) return;
  fs.appendFile(traceFile, `${JSON.stringify({ t: Date.now(), pid: process.pid, event, ...fields })}\n`, () => {});
}
