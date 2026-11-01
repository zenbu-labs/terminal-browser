import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { ensureOwnedDir, replacePrivateFile } from "shared";

export type LevelOfControl =
  | "not_controllable"
  | "controlled_by_other_extensions"
  | "controllable_by_this_extension"
  | "controlled_by_this_extension";

export interface SettingDefinition {
  // The value when no extension controls the setting.
  base: () => unknown;
  // False when terminal-browser has nothing an extension could turn on or off.
  controllable: boolean;
}

interface Controller {
  id: string;
  installedAt: number;
}

type Persisted = Record<string, Record<string, unknown>>;

// Browser settings that extensions control, like Chrome's extension pref store:
// the most recently installed enabled extension that set a value wins, values
// last across restarts, stop applying while their extension is off, and are
// dropped when it's uninstalled.
export class SettingStore {
  private readonly definitions = new Map<string, SettingDefinition>();
  private readonly values: Persisted;
  private readonly active = new Map<string, number>();
  private readonly listeners = new Set<(pref: string, value: unknown) => void>();

  constructor(private readonly file: string | null) {
    this.values = file ? read(file) : {};
  }

  define(pref: string, definition: SettingDefinition) {
    this.definitions.set(pref, definition);
  }

  has(pref: string): boolean {
    return this.definitions.has(pref);
  }

  onChange(listener: (pref: string, value: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  value(pref: string): unknown {
    const controller = this.controller(pref);
    return controller ? this.values[controller.id][pref] : this.definition(pref).base();
  }

  isControlled(pref: string): boolean {
    return this.controller(pref) !== null;
  }

  levelOfControl(pref: string, extensionId: string): LevelOfControl {
    if (!this.definition(pref).controllable) return "not_controllable";
    const controller = this.controller(pref);
    if (!controller) return "controllable_by_this_extension";
    if (controller.id === extensionId) return "controlled_by_this_extension";
    const installedAt = this.active.get(extensionId);
    return installedAt !== undefined && controller.installedAt <= installedAt
      ? "controllable_by_this_extension"
      : "controlled_by_other_extensions";
  }

  set(extensionId: string, pref: string, value: unknown) {
    this.definition(pref);
    this.update([pref], () => {
      (this.values[extensionId] ??= {})[pref] = value;
    });
  }

  clear(extensionId: string, pref: string) {
    this.definition(pref);
    if (!this.values[extensionId] || !(pref in this.values[extensionId])) return;
    this.update([pref], () => {
      delete this.values[extensionId][pref];
      if (Object.keys(this.values[extensionId]).length === 0) delete this.values[extensionId];
    });
  }

  setActive(extensions: Map<string, number>) {
    const changed = [...new Set([...extensions.keys(), ...this.active.keys()])].filter(
      (id) => extensions.get(id) !== this.active.get(id),
    );
    if (changed.length === 0) return;
    const prefs = changed.flatMap((id) => Object.keys(this.values[id] ?? {})).filter((pref) => this.definitions.has(pref));
    this.update(
      prefs,
      () => {
        this.active.clear();
        for (const [id, at] of extensions) this.active.set(id, at);
      },
      false,
    );
  }

  extensions(): string[] {
    return Object.keys(this.values);
  }

  forget(extensionId: string) {
    if (!this.values[extensionId]) return;
    const prefs = Object.keys(this.values[extensionId]).filter((pref) => this.definitions.has(pref));
    this.update(prefs, () => {
      delete this.values[extensionId];
    });
  }

  private definition(pref: string): SettingDefinition {
    const definition = this.definitions.get(pref);
    if (!definition) throw new Error(`Unknown setting ${pref}`);
    return definition;
  }

  private controller(pref: string): Controller | null {
    if (!this.definition(pref).controllable) return null;
    let winner: Controller | null = null;
    for (const [id, installedAt] of this.active) {
      if (!this.values[id] || !(pref in this.values[id])) continue;
      if (!winner || installedAt >= winner.installedAt) winner = { id, installedAt };
    }
    return winner;
  }

  private update(prefs: string[], change: () => void, persist = true) {
    const before = new Map(prefs.map((pref) => [pref, this.value(pref)]));
    change();
    if (persist) this.save();
    for (const [pref, previous] of before) {
      if (!isDeepStrictEqual(previous, this.value(pref))) this.emit(pref);
    }
  }

  private emit(pref: string) {
    const value = this.value(pref);
    for (const listener of [...this.listeners]) {
      try {
        listener(pref, value);
      } catch (error) {
        console.error(error);
      }
    }
  }

  private save() {
    if (!this.file) return;
    if (Object.keys(this.values).length === 0) {
      fs.rmSync(this.file, { force: true });
      return;
    }
    ensureOwnedDir(path.dirname(this.file));
    replacePrivateFile(this.file, JSON.stringify(this.values));
  }
}

function read(file: string): Persisted {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Persisted) : {};
  } catch {
    return {};
  }
}
