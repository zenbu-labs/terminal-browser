import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };

export type Harness = "claude" | "codex";

export const HARNESSES: Harness[] = ["claude", "codex"];

interface EffortOption {
  level: string;
  description: string;
}

export interface ModelOption {
  harness: Harness;
  id: string;
  name: string;
  hint?: string;
  details: string[];
  efforts: EffortOption[];
  defaultEffort: string | null;
  fastTier: string | null;
  preferred: boolean;
}

export interface HarnessModels {
  models: ModelOption[];
  signedIn: boolean;
}

export interface AiChoice {
  harness: Harness;
  model: string;
  effort: string | null;
  fast: boolean;
}

interface AiState {
  choice?: AiChoice;
  models?: Partial<Record<Harness, HarnessModels>>;
}

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"].map((level) => ({ level, description: "" }));

export const FALLBACK_MODELS: Record<Harness, ModelOption[]> = {
  claude: [
    { harness: "claude", id: "opus", name: "Opus", details: [], efforts: CLAUDE_EFFORTS, defaultEffort: null, fastTier: null, preferred: false },
    { harness: "claude", id: "sonnet", name: "Sonnet", details: [], efforts: CLAUDE_EFFORTS, defaultEffort: null, fastTier: null, preferred: true },
    { harness: "claude", id: "haiku", name: "Haiku", details: [], efforts: CLAUDE_EFFORTS, defaultEffort: null, fastTier: null, preferred: false },
  ],
  codex: [
    ["gpt-6.1-sol", "GPT-6.1-Sol"],
    ["gpt-6-luna", "GPT-6-Luna"],
  ].map(([id, name], i) => ({
    harness: "codex" as const,
    id,
    name,
    details: [],
    efforts: ["low", "medium", "high", "xhigh"].map((level) => ({ level, description: "" })),
    defaultEffort: "medium",
    fastTier: null,
    preferred: i === 0,
  })),
};

function claudeName(model: ModelInfo): string {
  const match = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/.exec(model.resolvedModel ?? model.value);
  const name = match ? `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}${match[3] ? `.${match[3]}` : ""}` : model.displayName;
  // fixme: placeholder copy
  return /\[1m\]$/i.test(model.value) ? `${name} (1M)` : name;
}

export function claudeModels(models: ModelInfo[]): ModelOption[] {
  return models.map((model) => {
    const name = claudeName(model);
    const [first, ...rest] = model.description.split(" · ");
    const isDefault = model.value === "default";
    return {
      harness: "claude",
      id: model.value,
      // fixme: placeholder copy
      name: isDefault ? "Default" : name,
      hint: isDefault ? name : undefined,
      details: first === name.replace(/ \(1M\)$/, "") ? rest : [first, ...rest],
      efforts: (model.supportedEffortLevels ?? []).map((level) => ({ level, description: "" })),
      defaultEffort: null,
      fastTier: model.supportsFastMode ? "fast" : null,
      preferred: model.value === "sonnet",
    };
  });
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string;
  serviceTiers?: { id: string; name: string }[];
  isDefault: boolean;
}

export function codexModels(models: CodexModel[]): ModelOption[] {
  return models
    .filter((model) => !model.hidden)
    .map((model) => ({
      harness: "codex",
      id: model.model,
      name: model.displayName,
      details: model.description ? [model.description] : [],
      efforts: model.supportedReasoningEfforts.map((effort) => ({ level: effort.reasoningEffort, description: effort.description })),
      defaultEffort: model.defaultReasoningEffort,
      fastTier: model.serviceTiers?.find((tier) => /fast/i.test(tier.name))?.id ?? null,
      preferred: model.isDefault,
    }));
}

function stateFile(): string {
  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "pxsh", "ai.json");
}

function readState(file: string): AiState {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeState(file: string, update: AiState): void {
  try {
    const next = { ...readState(file), ...update };
    if (update.models) next.models = { ...readState(file).models, ...update.models };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2) + "\n");
    fs.renameSync(temp, file);
  } catch {}
}

function parseChoice(value: unknown): AiChoice | null {
  if (!value || typeof value !== "object") return null;
  const { harness, model, effort, fast } = value as Record<string, unknown>;
  if (!HARNESSES.includes(harness as Harness) || typeof model !== "string" || !model) return null;
  return { harness: harness as Harness, model, effort: typeof effort === "string" ? effort : null, fast: fast === true };
}

function parseModels(value: unknown): HarnessModels | null {
  if (!value || typeof value !== "object") return null;
  const { models, signedIn } = value as Record<string, unknown>;
  if (!Array.isArray(models) || !models.length) return null;
  return { models: models as ModelOption[], signedIn: signedIn !== false };
}

export function readChoice(file = stateFile()): AiChoice | null {
  return parseChoice(readState(file).choice);
}

export function saveChoice(choice: AiChoice, file = stateFile()): void {
  writeState(file, { choice });
}

export function readModels(file = stateFile()): Partial<Record<Harness, HarnessModels>> {
  const saved = readState(file).models ?? {};
  const out: Partial<Record<Harness, HarnessModels>> = {};
  for (const harness of HARNESSES) {
    const parsed = parseModels(saved[harness]);
    if (parsed) out[harness] = parsed;
  }
  return out;
}

export function saveModels(harness: Harness, models: HarnessModels, file = stateFile()): void {
  writeState(file, { models: { [harness]: models } });
}

export function resolveChoice(saved: AiChoice | null, installed: Harness[], known: Partial<Record<Harness, HarnessModels>>): AiChoice | null {
  if (saved && installed.includes(saved.harness)) return saved;
  const harness = installed[0];
  if (!harness) return null;
  const models = known[harness]?.models ?? FALLBACK_MODELS[harness];
  const model = models.find((m) => m.preferred) ?? models[0];
  return { harness, model: model.id, effort: null, fast: false };
}

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function findExecutable(name: string, searchPath: string, extra: string[] = []): string | null {
  const dirs = [...searchPath.split(path.delimiter).filter(Boolean), ...extra];
  for (const dir of dirs) {
    const file = path.join(dir, name);
    if (executable(file)) return file;
  }
  return null;
}

export function harnessExecutables(): Record<Harness, string | null> {
  const searchPath = process.env.PATH ?? "";
  const pinned = (file: string | undefined) => (file && executable(file) ? file : null);
  const home = os.homedir();
  return {
    claude: pinned(process.env.PXSH_CLAUDE) ?? findExecutable("claude", path.join(home, ".local", "bin") + path.delimiter + searchPath),
    codex: pinned(process.env.PXSH_CODEX) ?? findExecutable("codex", searchPath, ["/opt/homebrew/bin", "/usr/local/bin"]),
  };
}

export function effortLabel(level: string): string {
  // fixme: placeholder copy
  const names: Record<string, string> = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" };
  return names[level] ?? level[0].toUpperCase() + level.slice(1);
}

function findModel(choice: AiChoice, known: Partial<Record<Harness, HarnessModels>>): ModelOption | null {
  const models = known[choice.harness]?.models ?? FALLBACK_MODELS[choice.harness];
  return models.find((m) => m.id === choice.model) ?? null;
}

export function choiceLabel(choice: AiChoice, known: Partial<Record<Harness, HarnessModels>>): string {
  const model = findModel(choice, known);
  const effort = choice.effort ?? model?.defaultEffort ?? null;
  // fixme: placeholder copy
  return [model ? (model.hint ?? model.name) : choice.model, effort && effortLabel(effort), choice.fast && model?.fastTier && "Fast"].filter(Boolean).join(" ");
}
