import os from "node:os";
import path from "node:path";

import { LOGS_DIR } from "../paths";
import { z } from "zod";

import { AUTO, DISPLAY_FPS, UNCAPPED } from "./render";
import { SEARCH_ENGINES, SUGGESTIONS_OFF } from "./search";

export type SettingGroup = "general" | "advanced";

export interface SettingChoice {
  value: string;
  name: string;
  logo: string | null;
}

interface SettingDef<S extends z.ZodType> {
  group: SettingGroup;
  label: string;
  hint: string;
  schema: S;
  default: z.infer<S>;
  choices?: SettingChoice[];
  inverted?: boolean;
}

function setting<S extends z.ZodType>(def: SettingDef<S>): SettingDef<S> {
  return def;
}

const plain = (value: string, name = value): SettingChoice => ({ value, name, logo: null });

const onOff = [plain("on", "On"), plain("off", "Off")];

export const ENGINE_LOG_FILE = path.join(LOGS_DIR, "engine.jsonl");
const ENGINE_LOG_FILE_SHORT = ENGINE_LOG_FILE.replace(os.homedir() + path.sep, "~" + path.sep);

export const SETTINGS = {
  "search.engine": setting({
    group: "general",
    label: "Search engine",
    hint: "Default search engine used for search queries.",
    schema: z.string(),
    default: SEARCH_ENGINES[0].search,
    choices: SEARCH_ENGINES.map(({ search, name, logo }) => ({ value: search, name, logo })),
  }),
  "search.suggestions": setting({
    group: "general",
    label: "Search suggestions",
    hint: "Provider for autocomplete suggestions.",
    schema: z.string(),
    default: SEARCH_ENGINES[0].suggest!,
    choices: [
      ...SEARCH_ENGINES.filter((engine) => engine.suggest).map(({ suggest, name, logo }) => ({
        value: suggest!,
        name,
        logo,
      })),
      { value: SUGGESTIONS_OFF, name: "Off", logo: null },
    ],
  }),
  "home.default": setting({
    group: "general",
    label: "Home page on launch",
    hint: "Open the home page for new windows and tabs, or a blank page instead.",
    schema: z.enum(["start", "blank"]),
    default: "start",
    choices: [plain("start", "Home page"), plain("blank", "Blank page")],
  }),
  "home.restore": setting({
    group: "general",
    label: "Restore last tab on launch",
    hint: "Reopen the last visited page on launch instead of the default page.",
    schema: z.boolean(),
    default: true,
    choices: onOff,
  }),
  "telemetry.usage": setting({
    group: "general",
    label: "Disable anonymous telemetry",
    hint: "Minimal anonymous events are tracked to help improve the project",
    schema: z.enum(["on", "off"]),
    default: "on",
    choices: onOff,
    inverted: true,
  }),
  "telemetry.crashReports": setting({
    group: "general",
    label: "Disable crash reports",
    hint: "Crash reporting helps improve the project and prevents future crashes",
    schema: z.enum(["on", "off"]),
    default: "on",
    choices: onOff,
    inverted: true,
  }),
  "updates.check": setting({
    group: "general",
    label: "Disable update checks",
    hint: "Prevents terminal-browser from making a network request to check if an update is available",
    schema: z.enum(["on", "off"]),
    default: "on",
    choices: onOff,
    inverted: true,
  }),
  "window.transparent": setting({
    group: "general",
    label: "Transparent website backgrounds",
    hint: "The terminal background will show through pages without a background color",
    schema: z.enum(["on", "off"]),
    default: "off",
    choices: onOff,
  }),
  "render.fps": setting({
    group: "advanced",
    label: "Frame rate",
    hint: "How many times the screen is allowed to update per second.",
    schema: z.coerce
      .string()
      .regex(
        /^(display|uncapped|[1-9]\d*(\.\d+)?)$/,
        "expected display, uncapped, or a number of frames per second",
      ),
    default: DISPLAY_FPS,
    choices: [
      plain(DISPLAY_FPS, "Display"),
      plain("30"),
      plain("60"),
      plain(UNCAPPED, "Uncapped"),
    ],
  }),
  "render.presenter": setting({
    group: "advanced",
    label: "Image transmission format",
    hint: "The format pixels are transmitted to the terminal. Applies to new windows.",
    schema: z.enum([AUTO, "full", "patched", "animation"]),
    default: AUTO,
    choices: [
      plain(AUTO, "Automatic"),
      plain("full", "Whole frame"),
      plain("patched", "Patches"),
      plain("animation", "Kitty animation"),
    ],
  }),
  "render.transport": setting({
    group: "advanced",
    label: "Frame transport",
    hint: "The mechanism used to transmit pixels to the terminal. Applies to new windows.",
    schema: z.enum([AUTO, "shared", "file", "inline"]),
    default: AUTO,
    choices: [
      plain(AUTO, "Automatic"),
      plain("shared", "Shared memory"),
      plain("file", "File"),
      plain("inline", "Inline"),
    ],
  }),
  "render.frameEvents": setting({
    group: "advanced",
    label: "Display debug actions",
    hint: "Overlay internal debugging information at the top of the browser.",
    schema: z.enum(["on", "off"]),
    default: "off",
    choices: onOff,
  }),
  "render.transmitOutlines": setting({
    group: "advanced",
    label: "Highlight updates",
    hint: "Display a border around new images sent to the terminal.",
    schema: z.enum(["on", "off"]),
    default: "off",
    choices: onOff,
  }),
  "debug.logFile": setting({
    group: "advanced",
    label: "Enable logging",
    hint: `Write internal logs to ${ENGINE_LOG_FILE_SHORT}`,
    schema: z.enum(["on", "off"]),
    default: "off",
    choices: onOff,
  }),
};

export type SettingKey = keyof typeof SETTINGS;

export type Settings = { [K in SettingKey]: z.infer<(typeof SETTINGS)[K]["schema"]> };

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(value: string): value is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, value);
}

export function defaultSettings(): Settings {
  const out = {} as Record<string, unknown>;
  for (const key of SETTING_KEYS) out[key] = SETTINGS[key].default;
  return out as Settings;
}
