import type { EngineKeyEvent } from "@zenbu-labs/pixel";

import { listStep } from "shared";

import type { OmniboxDisposition, OmniboxInput, OmniboxKeyword, OmniboxStore } from "../extensions/api/omnibox";
import type { KeywordView } from "../ui/types";

// Chrome's omnibox keyword mode for the address bar: typing an extension's keyword
// and a space hands the rest of the text to that extension.
export class AddressKeyword {
  private input: OmniboxInput | null = null;
  private typed = "";
  private index = 0;
  private candidate: OmniboxKeyword | null = null;

  constructor(
    private readonly store: () => OmniboxStore | null,
    private readonly changed: () => void,
  ) {}

  get active(): boolean {
    return this.input !== null;
  }

  type(text: string): string {
    if (this.input) {
      this.typed = text;
      this.index = 0;
      this.input.change(text);
      return text;
    }
    const store = this.store();
    const word = /^(\S+)\s([^]*)$/.exec(text);
    const keyword = word ? store?.keywordFor(word[1]) : null;
    if (word && keyword && store) return this.start(store, keyword, word[2]);
    this.candidate = store?.keywordFor(text) ?? null;
    return text;
  }

  get text(): string {
    return this.typed;
  }

  private start(store: OmniboxStore, keyword: OmniboxKeyword, rest: string): string {
    this.candidate = null;
    this.input = store.start(keyword, this.changed);
    this.typed = "";
    this.index = 0;
    return this.type(rest);
  }

  view(): KeywordView | null {
    if (!this.input) return null;
    const { name, icon } = this.input.keyword;
    const rows = this.input.rows().map((row) => ({ runs: row.description, deletable: row.deletable }));
    return { name, icon, rows, index: Math.min(this.index, Math.max(0, rows.length - 1)) };
  }

  captureKeys(): string[] {
    if (this.input) return this.typed ? ["enter", "up", "down"] : ["enter", "up", "down", "backspace"];
    return this.candidate ? ["tab"] : [];
  }

  key(event: EngineKeyEvent, disposition: OmniboxDisposition): { text: string; done: boolean } | null {
    const store = this.store();
    if (!this.input) {
      if (event.key !== "tab" || !this.candidate || !store) return null;
      return { text: this.start(store, this.candidate, ""), done: false };
    }
    const step = listStep(event);
    const count = this.input.rows().length;
    if (step && count > 0) {
      this.index = (this.index + step + count) % count;
      this.changed();
      return { text: this.typed, done: false };
    }
    if (event.key === "enter") {
      this.enter(this.index, disposition);
      return { text: "", done: true };
    }
    if (event.key === "backspace" && !this.typed) {
      const word = this.input.keyword.keyword;
      this.cancel();
      this.candidate = this.store()?.keywordFor(word) ?? null;
      return { text: word, done: false };
    }
    return null;
  }

  enter(index: number, disposition: OmniboxDisposition) {
    this.input?.enter(index, disposition);
    this.input = null;
  }

  remove(index: number) {
    this.input?.delete(index);
  }

  cancel() {
    this.input?.cancel();
    this.input = null;
    this.typed = "";
    this.candidate = null;
  }
}
