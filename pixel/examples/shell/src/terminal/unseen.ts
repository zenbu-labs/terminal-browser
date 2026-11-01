import type { Vt } from "./vt";

const ERASE_DISPLAY = /\x1b\[([0-3]?)J|\x1bc/g;

export class UnseenRows {
  private count = 0;
  private history = 0;

  constructor(private readonly vt: Vt) {}

  get rows(): number {
    return this.count;
  }

  startAbove(rows: number): void {
    this.count = Math.max(0, rows);
    this.history = this.vt.info().history;
  }

  atLeastAboveCursor(): void {
    this.count = Math.max(this.count, this.vt.info().cursorY);
  }

  write(bytes: Buffer): void {
    if (!this.count) {
      this.vt.write(bytes);
      return;
    }
    let fed = 0;
    for (const erase of bytes.toString("latin1").matchAll(ERASE_DISPLAY)) {
      this.vt.write(bytes.subarray(fed, erase.index));
      fed = erase.index;
      if (!this.vt.atGround()) continue;
      this.followScrolling();
      if (erase[0] === "\x1bc") this.count = 0;
      else this.erased(erase[1] || "0");
    }
    this.vt.write(bytes.subarray(fed));
    this.followScrolling();
  }

  reflowed(): void {
    const { history, altScreen } = this.vt.info();
    if (altScreen) return;
    this.count = Math.max(0, this.count + this.history - history);
    this.history = history;
  }

  shifted(rows: number): void {
    this.count = Math.max(0, this.count + rows);
  }

  private followScrolling(): void {
    const { history, altScreen } = this.vt.info();
    if (altScreen) return;
    if (history > this.history) this.count = Math.max(0, this.count - (history - this.history));
    this.history = history;
  }

  private erased(which: string): void {
    const { cursorX, cursorY, altScreen } = this.vt.info();
    if (altScreen) return;
    if (which === "2") this.count = 0;
    else if (which === "1" && this.count <= cursorY) this.count = 0;
    else if (which === "0") this.count = Math.min(this.count, cursorX === 0 ? cursorY : cursorY + 1);
  }
}
