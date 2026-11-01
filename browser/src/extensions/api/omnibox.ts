import { extensionIcon } from "../action";
import type { LoadedExtension } from "../loaded";
import { parseDescription, plainDescription } from "../omnibox-xml";
import type { DescriptionRun } from "../omnibox-xml";
import type { Caller } from "../router";
import type { ExtensionService } from "../service";

export type OmniboxDisposition = "currentTab" | "newForegroundTab" | "newBackgroundTab";

export interface OmniboxKeyword {
  extensionId: string;
  keyword: string;
  name: string;
  icon: string | null;
}

export interface OmniboxRow {
  content: string;
  description: DescriptionRun[];
  deletable: boolean;
}

const MAX_SUGGESTIONS = 6;

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function invalidArgument(): Error {
  // fixme: placeholder copy
  return new Error("Invalid suggestion.");
}

function suggestionArg(value: unknown): { content: string; description: string; deletable: boolean } {
  const { content, description, deletable } = (value ?? {}) as Record<string, unknown>;
  if (typeof content !== "string" || typeof description !== "string") throw invalidArgument();
  return { content, description, deletable: deletable === true };
}

export class OmniboxInput {
  private requestId = 0;
  private text = "";
  private suggestions: OmniboxRow[] = [];
  private finished = false;

  constructor(
    private readonly store: OmniboxStore,
    readonly keyword: OmniboxKeyword,
    private readonly onChange: () => void,
  ) {
    store.dispatch(this, "omnibox.onInputStarted", []);
  }

  change(text: string) {
    if (this.finished || text === this.text) return;
    this.text = text;
    this.requestId = this.store.nextRequestId();
    this.suggestions = [];
    this.store.dispatch(this, "omnibox.onInputChanged", [text, this.requestId]);
    this.onChange();
  }

  suggested(requestId: number, rows: OmniboxRow[]) {
    if (this.finished || requestId !== this.requestId) return;
    this.suggestions = rows.slice(0, MAX_SUGGESTIONS);
    this.onChange();
  }

  rows(): OmniboxRow[] {
    const typed = this.store.defaultRow(this.keyword.extensionId, this.text);
    return typed ? [typed, ...this.suggestions] : this.suggestions;
  }

  enter(index: number, disposition: OmniboxDisposition) {
    if (this.finished) return;
    this.finished = true;
    const row = this.rows()[index];
    this.store.dispatch(this, "omnibox.onInputEntered", [row ? row.content : this.text, disposition]);
  }

  delete(index: number) {
    const row = this.rows()[index];
    if (this.finished || !row?.deletable) return;
    this.suggestions = this.suggestions.filter((suggestion) => suggestion !== row);
    this.store.dispatch(this, "omnibox.onDeleteSuggestion", [plainDescription(row.description)]);
    this.onChange();
  }

  cancel() {
    if (this.finished) return;
    this.finished = true;
    this.store.dispatch(this, "omnibox.onInputCancelled", []);
  }

  refresh() {
    if (!this.finished) this.onChange();
  }

  get done(): boolean {
    return this.finished;
  }
}

export class OmniboxStore {
  private readonly defaults = new Map<string, string>();
  private readonly inputs = new Set<OmniboxInput>();
  private requestSeq = 0;

  constructor(private readonly service: ExtensionService) {
    service.onUnload((id) => {
      this.defaults.delete(id);
      for (const input of this.inputs) if (input.keyword.extensionId === id) this.inputs.delete(input);
    });
  }

  keywords(): OmniboxKeyword[] {
    const found: OmniboxKeyword[] = [];
    for (const extension of this.service.loaded.values()) {
      const keyword = extension.manifest.omnibox?.keyword?.trim();
      if (!keyword) continue;
      found.push({ extensionId: extension.id, keyword, name: extension.name, icon: extensionIcon(extension, 32) });
    }
    return found;
  }

  keywordFor(word: string): OmniboxKeyword | null {
    const wanted = word.toLowerCase();
    return this.keywords().find((entry) => entry.keyword.toLowerCase() === wanted) ?? null;
  }

  start(keyword: OmniboxKeyword, onChange: () => void): OmniboxInput {
    const input = new OmniboxInput(this, keyword, onChange);
    this.inputs.add(input);
    return input;
  }

  nextRequestId(): number {
    return ++this.requestSeq;
  }

  dispatch(input: OmniboxInput, event: string, args: unknown[]) {
    if (input.done && event !== "omnibox.onInputEntered" && event !== "omnibox.onInputCancelled") return;
    if (event === "omnibox.onInputEntered" || event === "omnibox.onInputCancelled") this.inputs.delete(input);
    this.service.dispatch(input.keyword.extensionId, event, args);
  }

  defaultRow(extensionId: string, text: string): OmniboxRow | null {
    const template = this.defaults.get(extensionId);
    if (template === undefined) return text ? { content: text, description: [{ text, styles: [] }], deletable: false } : null;
    try {
      return { content: text, description: parseDescription(template.replaceAll("%s", escapeXml(text))), deletable: false };
    } catch {
      return { content: text, description: [{ text, styles: [] }], deletable: false };
    }
  }

  setDefault(extension: LoadedExtension, raw: unknown) {
    const { description } = (raw ?? {}) as { description?: unknown };
    if (typeof description !== "string") throw invalidArgument();
    parseDescription(description);
    this.defaults.set(extension.id, description);
    for (const input of this.inputs) if (input.keyword.extensionId === extension.id) input.refresh();
  }

  send(extension: LoadedExtension, requestId: unknown, results: unknown) {
    if (typeof requestId !== "number" || !Array.isArray(results)) throw invalidArgument();
    const rows = results.map((value) => {
      const suggestion = suggestionArg(value);
      return { content: suggestion.content, description: parseDescription(suggestion.description), deletable: suggestion.deletable };
    });
    for (const input of this.inputs) if (input.keyword.extensionId === extension.id) input.suggested(requestId, rows);
  }
}

export function installOmnibox(service: ExtensionService) {
  const { router, omnibox } = service;
  const withKeyword = (caller: Caller) => {
    if (!caller.extension.manifest.omnibox) throw new Error("Access to extension API denied.");
    return caller.extension;
  };
  router.handle("omnibox.setDefaultSuggestion", (caller, suggestion) => omnibox.setDefault(withKeyword(caller), suggestion));
  router.handle("omnibox.sendSuggestions", (caller, requestId, results) => omnibox.send(withKeyword(caller), requestId, results));
}
