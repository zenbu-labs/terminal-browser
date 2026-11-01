import type { LineEditor } from "./zsh";

interface Checkpoint {
  change: number;
  history: number;
}

interface UndoStep {
  action: "undo" | "redo";
  change?: number;
}

type Edit = { kind: "type"; char: string; replaced: boolean } | { kind: "delete" } | { kind: "other" };
type Run = { kind: "type"; space: boolean } | { kind: "delete" };

const isSpace = (char: string) => /\s/.test(char);

function classify(before: LineEditor, after: LineEditor): Edit {
  const a = Array.from(before.buffer);
  const b = Array.from(after.buffer);
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((c, i) => c === y[i]);
  const inserted = (from: number, to: number) =>
    after.cursor === from + 1 && b.length === a.length - (to - from) + 1 && same(b.slice(0, from), a.slice(0, from)) && same(b.slice(from + 1), a.slice(to));
  if (inserted(before.cursor, before.cursor)) return { kind: "type", char: b[before.cursor], replaced: false };
  const [from, to] = [Math.min(before.mark, before.cursor), Math.max(before.mark, before.cursor)];
  if (before.regionActive && to > from && inserted(from, to)) return { kind: "type", char: b[from], replaced: true };
  if (b.length === a.length - 1) {
    const backward = after.cursor === before.cursor - 1 && same(b, [...a.slice(0, before.cursor - 1), ...a.slice(before.cursor)]);
    const forward = after.cursor === before.cursor && same(b, [...a.slice(0, before.cursor), ...a.slice(before.cursor + 1)]);
    if (backward || forward) return { kind: "delete" };
  }
  return { kind: "other" };
}

export class UndoCheckpoints {
  private marks: Checkpoint[] = [];
  private top: Checkpoint | null = null;
  private at = 0;
  private last: LineEditor | null = null;
  private run: Run | null = null;
  private known = true;
  private moving = false;

  reset(): void {
    this.marks = [];
    this.top = null;
    this.at = 0;
    this.last = null;
    this.run = null;
    this.known = true;
    this.moving = false;
  }

  observe(state: LineEditor): void {
    const last = this.last;
    if (!last || state.change < last.change) {
      this.reset();
      this.top = { change: state.change, history: state.history };
      this.last = state;
      return;
    }
    this.last = state;
    if (this.moving) {
      this.moving = false;
      this.run = null;
      return;
    }
    const before = { change: last.change, history: last.history };
    const now = { change: state.change, history: state.history };
    if (state.change > last.change) {
      const edit = classify(last, state);
      const continues =
        this.known &&
        this.at === this.marks.length &&
        ((edit.kind === "type" && !edit.replaced && this.run?.kind === "type" && !(isSpace(edit.char) && !this.run.space)) ||
          (edit.kind === "delete" && this.run?.kind === "delete"));
      if (!this.known) {
        this.marks = [before];
        this.known = true;
      } else if (this.at < this.marks.length) {
        this.marks = this.marks.slice(0, this.at + 1);
      } else if (!continues) {
        this.marks.push(before);
      }
      this.top = now;
      this.at = this.marks.length;
      this.run = edit.kind === "type" ? { kind: "type", space: isSpace(edit.char) } : edit.kind === "delete" ? { kind: "delete" } : null;
      return;
    }
    if (state.cursor !== last.cursor || state.buffer !== last.buffer) this.run = null;
    if (state.history !== last.history) {
      if (!this.known || this.at < this.marks.length) {
        this.known = false;
        return;
      }
      if (this.marks.at(-1)?.change !== before.change) this.marks.push(before);
      this.top = now;
      this.at = this.marks.length;
    } else if (state.buffer !== last.buffer) {
      this.known = false;
    }
  }

  undo(): UndoStep | null {
    if (!this.last) return null;
    if (!this.known) return this.step({ action: "undo" });
    if (this.at === 0) return null;
    const current = this.state(this.at);
    const target = this.marks[this.at - 1];
    this.at -= 1;
    const overHistoryRecall = target.change === current.change;
    if (overHistoryRecall) return this.step({ action: "undo" });
    return this.step({ action: "undo", change: target.change });
  }

  redo(): UndoStep | null {
    if (!this.last) return null;
    if (!this.known) return this.step({ action: "redo" });
    if (this.at === this.marks.length) return null;
    const current = this.state(this.at);
    const target = this.state(this.at + 1);
    const zleCannotRedoHistoryRecall = target.change === current.change;
    if (zleCannotRedoHistoryRecall) return null;
    this.at += 1;
    return this.step({ action: "redo", change: target.change });
  }

  private state(index: number): Checkpoint {
    return index < this.marks.length ? this.marks[index] : this.top!;
  }

  private step(step: UndoStep): UndoStep {
    this.moving = true;
    this.run = null;
    return step;
  }
}
