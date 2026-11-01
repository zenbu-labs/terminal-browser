import { execFile } from "node:child_process";
import path from "node:path";

import { setWebPreferenceDefaults } from "@zenbu-labs/pixel";
import { app, webContents as allWebContents } from "electron";
import type { WebContents } from "electron";
import { ConfigStore, getExtension, SEARCH_ENGINES, SETTINGS_FILE, SHORTCUTS_FILE, SUGGESTIONS_OFF } from "shared";

import { API_SCHEMAS } from "../api-schemas";
import { ACCESSIBILITY_SETTINGS, GENERIC_FONT_FAMILIES, PRIVACY_SETTINGS, settingKey } from "../chrome-settings";
import type { LoadedExtension } from "../loaded";
import { networkHooks } from "../network-hooks";
import type { SendHeadersHook } from "../network-hooks";
import type { ExtensionService } from "../service";
import { SettingStore } from "../setting-store";
import type { ArgSpec } from "../validate";

const INCOGNITO_ERROR = "You do not have permission to access incognito preferences.";
const SANDBOX_ERROR = "Extensions aren’t allowed to enable Privacy Sandbox APIs.";
const permissionError = (key: string) =>
  `You do not have permission to access the preference '${key}'. Be sure to declare in your manifest what permissions you need.`;

const FONT_PREFIX = "webkit.webprefs.fonts.";
const FONT_SIZES = {
  DefaultFontSize: { pref: "webkit.webprefs.default_font_size", base: 16, electron: "defaultFontSize" },
  DefaultFixedFontSize: { pref: "webkit.webprefs.default_fixed_font_size", base: 13, electron: "defaultMonospaceFontSize" },
  MinimumFontSize: { pref: "webkit.webprefs.minimum_font_size", base: 0, electron: "minimumFontSize" },
} as const;
const COMMON_SCRIPT = "Zyyy";

// Chrome's font defaults on macOS (locale_settings_mac.grd); unlisted ones are empty.
const FONT_DEFAULTS: Record<string, string> = {
  "standard.Zyyy": "Times",
  "fixed.Zyyy": "Menlo",
  "serif.Zyyy": "Times",
  "sansserif.Zyyy": "Helvetica",
  "cursive.Zyyy": "Apple Chancery",
  "fantasy.Zyyy": "Papyrus",
  "math.Zyyy": "STIX Two Math",
  "standard.Jpan": "Hiragino Kaku Gothic ProN",
  "fixed.Jpan": "Osaka",
  "serif.Jpan": "Hiragino Mincho ProN",
  "sansserif.Jpan": "Hiragino Kaku Gothic ProN",
  "standard.Kore": "Apple SD Gothic Neo",
  "serif.Kore": "AppleMyungjo",
  "sansserif.Kore": "Apple SD Gothic Neo",
  "standard.Hans": "PingFang SC",
  "serif.Hans": "Songti SC",
  "sansserif.Hans": "PingFang SC",
  "cursive.Hans": "Kaiti SC",
  "standard.Hant": "PingFang TC",
  "serif.Hant": "Songti TC",
  "sansserif.Hant": "PingFang TC",
  "cursive.Hant": "Kaiti TC",
  "standard.Deva": "Devanagari MT",
  "fixed.Deva": "Menlo",
  "serif.Deva": "Devanagari MT",
  "sansserif.Deva": "Kohinoor Devanagari",
};

const ELECTRON_FAMILIES: Record<string, string> = {
  standard: "standard",
  serif: "serif",
  sansserif: "sansSerif",
  fixed: "monospace",
  cursive: "cursive",
  fantasy: "fantasy",
  math: "math",
};

const ANIMATION_POLICIES: Record<string, "animate" | "animateOnce" | "noAnimation"> = {
  allowed: "animate",
  once: "animateOnce",
  none: "noAnimation",
};

const fontPref = (family: string, script: string) => `${FONT_PREFIX}${family}.${script}`;

function userSuggestions(): string {
  const settings = new ConfigStore({ settings: SETTINGS_FILE, shortcuts: SHORTCUTS_FILE }).load().settings;
  return settings?.["search.suggestions"] ?? SEARCH_ENGINES[0].suggest!;
}

// What each Chrome setting is in terminal-browser. Settings for features it
// doesn't have report them as off, and extensions can't turn them on.
function chromeSettingDefaults(): Record<string, { base: () => unknown; controllable: boolean }> {
  const fixed = (value: unknown, controllable = true) => ({ base: () => value, controllable });
  return {
    networkPredictionEnabled: fixed(true),
    webRTCIPHandlingPolicy: fixed("default"),
    alternateErrorPagesEnabled: fixed(false, false),
    autofillEnabled: fixed(false, false),
    autofillAddressEnabled: fixed(false, false),
    autofillCreditCardEnabled: fixed(false, false),
    autofillSettings: fixed([], false),
    passwordSavingEnabled: fixed(false, false),
    safeBrowsingEnabled: fixed(false, false),
    safeBrowsingExtendedReportingEnabled: fixed(false, false),
    searchSuggestEnabled: { base: () => userSuggestions() !== SUGGESTIONS_OFF, controllable: true },
    spellingServiceEnabled: fixed(false, false),
    translationServiceEnabled: fixed(false, false),
    thirdPartyCookiesAllowed: fixed(true, false),
    topicsEnabled: fixed(false),
    fledgeEnabled: fixed(false),
    adMeasurementEnabled: fixed(false),
    hyperlinkAuditingEnabled: fixed(true),
    referrersEnabled: fixed(true),
    doNotTrackEnabled: fixed(false),
    animationPolicy: fixed("allowed"),
  };
}

const SETTING_SPECS: Record<string, { spec: ArgSpec; read: string; write: string }> = Object.fromEntries([
  ...Object.entries(PRIVACY_SETTINGS).map(([path, spec]) => [settingKey(path), { spec, read: "privacy", write: "privacy" }]),
  ...Object.entries(ACCESSIBILITY_SETTINGS).map(([key, spec]) => [
    key,
    { spec, read: "accessibilityFeatures.read", write: "accessibilityFeatures.modify" },
  ]),
]);

const PRIVACY_SANDBOX = new Set(["topicsEnabled", "fledgeEnabled", "adMeasurementEnabled"]);

function fits(spec: ArgSpec, value: unknown): boolean {
  switch (spec.type) {
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string" && (!spec.enum || spec.enum.includes(value));
    case "array":
      return Array.isArray(value) && value.every((item) => fits(spec.items ?? {}, item));
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const object = value as Record<string, unknown>;
      const properties = spec.properties ?? {};
      return (
        Object.keys(object).every((key) => key in properties) &&
        Object.entries(properties).every(([key, property]) =>
          object[key] === undefined ? property.optional === true : fits(property, object[key]),
        )
      );
    }
    default:
      return true;
  }
}

let fontList: Promise<{ fontId: string; displayName: string }[]> | null = null;

// The same list and order as Chrome (content/common/font_list_mac.mm).
const FONT_LIST_SCRIPT = `
ObjC.import("AppKit");
ObjC.import("CoreText");
const manager = $.NSFontManager.sharedFontManager;
const families = ObjC.castRefToObject($.CTFontManagerCopyAvailableFontFamilyNames());
const byLocalized = $.NSMutableDictionary.dictionary;
for (let i = 0; i < families.count; i++) {
  const family = families.objectAtIndex(i);
  byLocalized.setObjectForKey(family, manager.localizedNameForFamilyFace(family, $()));
}
const sorted = byLocalized.keysSortedByValueUsingSelector("localizedStandardCompare:");
const out = [];
for (let i = 0; i < sorted.count; i++) {
  const localized = sorted.objectAtIndex(i);
  out.push([ObjC.unwrap(byLocalized.objectForKey(localized)), ObjC.unwrap(localized)]);
}
JSON.stringify(out);
`;

function systemFonts(): Promise<{ fontId: string; displayName: string }[]> {
  fontList ??= new Promise((resolve) => {
    execFile("osascript", ["-l", "JavaScript", "-e", FONT_LIST_SCRIPT], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        fontList = null;
        resolve([]);
        return;
      }
      const pairs = JSON.parse(stdout) as [string, string][];
      resolve(pairs.map(([fontId, displayName]) => ({ fontId, displayName })));
    });
  });
  return fontList;
}

let store: SettingStore | null = null;

// The search suggestion provider to use, given the one the user picked.
export function searchSuggestionProvider(userChoice: string): string {
  if (!store) return userChoice;
  const enabled = store.value("searchSuggestEnabled");
  if (enabled === false) return SUGGESTIONS_OFF;
  if (enabled === true && userChoice === SUGGESTIONS_OFF) return SEARCH_ENGINES[0].suggest!;
  return userChoice;
}

export function createSettingStore(file: string | null): SettingStore {
  const settings = new SettingStore(file);
  for (const [key, definition] of Object.entries(chromeSettingDefaults())) settings.define(key, definition);
  const scripts = API_SCHEMAS.types["fontSettings.ScriptCode"]?.enum ?? [COMMON_SCRIPT];
  for (const family of GENERIC_FONT_FAMILIES) {
    for (const script of scripts) {
      settings.define(fontPref(family, script), { base: () => FONT_DEFAULTS[`${family}.${script}`] ?? "", controllable: true });
    }
  }
  for (const { pref, base } of Object.values(FONT_SIZES)) settings.define(pref, { base: () => base, controllable: true });
  return settings;
}

export function installSettings(service: ExtensionService) {
  const { router } = service;
  const settings = createSettingStore(path.join(app.getPath("userData"), "extension-settings.json"));
  store = settings;

  const syncActive = () =>
    settings.setActive(new Map([...service.loaded.values()].map((extension) => [extension.id, extension.record.installedAt])));
  service.onChange(syncActive);
  service.onUnload(syncActive);
  service.onUninstall((id) => settings.forget(id));
  for (const id of settings.extensions()) if (!getExtension(id)) settings.forget(id);

  const settingFor = (key: unknown) => {
    const found = typeof key === "string" ? SETTING_SPECS[key] : undefined;
    // fixme: placeholder copy
    if (!found) throw new Error("Invalid setting.");
    return { key: key as string, ...found };
  };
  const scopeIsIncognito = (scope: unknown) => scope === "incognito_persistent" || scope === "incognito_session_only";

  router.handle("types.ChromeSetting.get", (caller, key, details) => {
    const setting = settingFor(key);
    if ((details as { incognito?: boolean } | undefined)?.incognito === true) throw new Error(INCOGNITO_ERROR);
    if (!caller.extension.hasApiPermission(setting.read)) throw new Error(permissionError(setting.key));
    return { value: settings.value(setting.key), levelOfControl: settings.levelOfControl(setting.key, caller.extension.id) };
  });

  router.handle("types.ChromeSetting.set", (caller, key, details) => {
    const setting = settingFor(key);
    const { value, scope } = (details ?? {}) as { value?: unknown; scope?: unknown };
    if (scopeIsIncognito(scope)) throw new Error(INCOGNITO_ERROR);
    if (!caller.extension.hasApiPermission(setting.write)) throw new Error(permissionError(setting.key));
    if (!fits(setting.spec, value)) throw new Error("Invalid invocation");
    if (PRIVACY_SANDBOX.has(setting.key) && value === true) throw new Error(SANDBOX_ERROR);
    settings.set(caller.extension.id, setting.key, value);
  });

  router.handle("types.ChromeSetting.clear", (caller, key, details) => {
    const setting = settingFor(key);
    if (!caller.extension.hasApiPermission(setting.write)) throw new Error(permissionError(setting.key));
    if (scopeIsIncognito((details as { scope?: unknown } | undefined)?.scope)) return;
    settings.clear(caller.extension.id, setting.key);
  });

  const permission = "fontSettings";
  const familyPref = (details: unknown) => {
    const { genericFamily, script } = details as { genericFamily: string; script?: string };
    return fontPref(genericFamily, script || COMMON_SCRIPT);
  };
  router.handle(
    "fontSettings.getFont",
    (caller, details) => {
      const pref = familyPref(details);
      return { fontId: settings.value(pref), levelOfControl: settings.levelOfControl(pref, caller.extension.id) };
    },
    { permission },
  );
  router.handle(
    "fontSettings.setFont",
    (caller, details) => settings.set(caller.extension.id, familyPref(details), (details as { fontId: string }).fontId),
    { permission },
  );
  router.handle("fontSettings.clearFont", (caller, details) => settings.clear(caller.extension.id, familyPref(details)), {
    permission,
  });
  router.handle("fontSettings.getFontList", () => systemFonts(), { permission });
  for (const [name, { pref }] of Object.entries(FONT_SIZES)) {
    router.handle(
      `fontSettings.get${name}`,
      (caller) => ({ pixelSize: settings.value(pref), levelOfControl: settings.levelOfControl(pref, caller.extension.id) }),
      { permission },
    );
    router.handle(
      `fontSettings.set${name}`,
      (caller, details) => settings.set(caller.extension.id, pref, (details as { pixelSize: number }).pixelSize),
      { permission },
    );
    router.handle(`fontSettings.clear${name}`, (caller) => settings.clear(caller.extension.id, pref), { permission });
  }

  const announce = (pref: string, value: unknown) => {
    const levelFor = (extension: LoadedExtension) => settings.levelOfControl(pref, extension.id);
    const spec = SETTING_SPECS[pref];
    if (spec) {
      service.broadcast(`types.ChromeSetting.${pref}.onChange`, (extension) =>
        extension.hasApiPermission(spec.read) ? [{ value, levelOfControl: levelFor(extension) }] : null,
      );
      return;
    }
    const withPermission = (details: Record<string, unknown>) => (extension: LoadedExtension) =>
      extension.hasApiPermission(permission) ? [{ ...details, levelOfControl: levelFor(extension) }] : null;
    if (pref.startsWith(FONT_PREFIX)) {
      const [genericFamily, script] = pref.slice(FONT_PREFIX.length).split(".");
      service.broadcast("fontSettings.onFontChanged", withPermission({ fontId: value, genericFamily, script }));
      return;
    }
    const size = Object.entries(FONT_SIZES).find(([, entry]) => entry.pref === pref);
    if (size) service.broadcast(`fontSettings.on${size[0]}Changed`, withPermission({ pixelSize: value }));
  };
  settings.onChange(announce);

  new PageSettings(service, settings).start();
  syncActive();
}

// Applies the settings to pages: per-page renderer preferences on every web
// contents of the extension session, and request edits on its network traffic.
class PageSettings {
  private readonly applied = new Map<string, unknown>();
  private removeRequestHook: (() => void) | null = null;

  constructor(
    private readonly service: ExtensionService,
    private readonly settings: SettingStore,
  ) {}

  start() {
    this.settings.onChange((pref) => {
      if (pref === "webRTCIPHandlingPolicy" || pref === "animationPolicy") this.applyEverywhere(pref);
      if (REQUEST_SETTINGS.has(pref)) this.syncRequestHook();
    });
    app.on("web-contents-created", (_event, contents) => {
      if (contents.session !== this.service.session) return;
      for (const pref of this.applied.keys()) this.apply(contents, pref);
    });
    setWebPreferenceDefaults((partition) => (partition ? {} : this.fontPreferences()));
  }

  private applyEverywhere(pref: string) {
    this.applied.set(pref, this.settings.value(pref));
    for (const contents of allWebContents.getAllWebContents()) {
      if (!contents.isDestroyed() && contents.session === this.service.session) this.apply(contents, pref);
    }
  }

  private apply(contents: WebContents, pref: string) {
    const value = this.settings.value(pref);
    if (pref === "webRTCIPHandlingPolicy") {
      contents.setWebRTCIPHandlingPolicy(value as "default");
    } else if (pref === "animationPolicy") {
      contents.setImageAnimationPolicy(ANIMATION_POLICIES[value as string] ?? "animate");
    }
  }

  private syncRequestHook() {
    const needed = [...REQUEST_SETTINGS].some((pref) => this.settings.value(pref) !== REQUEST_DEFAULTS[pref]);
    if (needed && !this.removeRequestHook) {
      this.removeRequestHook = networkHooks(this.service.session).beforeSendHeaders(this.editRequest);
    } else if (!needed && this.removeRequestHook) {
      this.removeRequestHook();
      this.removeRequestHook = null;
    }
  }

  private readonly editRequest: SendHeadersHook = (details, headers) => {
    const header = (name: string) => Object.keys(headers).find((key) => key.toLowerCase() === name);
    const purpose = header("sec-purpose");
    if (this.settings.value("networkPredictionEnabled") === false && purpose && /prefetch/.test(headers[purpose])) {
      return "cancel";
    }
    const contentType = header("content-type");
    const isAuditingPing = details.resourceType === "ping" && contentType !== undefined && headers[contentType] === "text/ping";
    if (this.settings.value("hyperlinkAuditingEnabled") === false && isAuditingPing) return "cancel";
    if (this.settings.value("doNotTrackEnabled") === true) headers[header("dnt") ?? "DNT"] = "1";
    if (this.settings.value("referrersEnabled") === false) {
      const referer = header("referer");
      if (referer) delete headers[referer];
    }
  };

  private fontPreferences(): Electron.WebPreferences {
    const preferences: Electron.WebPreferences = {};
    const families: Record<string, string> = {};
    for (const family of GENERIC_FONT_FAMILIES) {
      const pref = fontPref(family, COMMON_SCRIPT);
      const value = this.settings.value(pref);
      if (this.settings.isControlled(pref) && typeof value === "string" && value) families[ELECTRON_FAMILIES[family]] = value;
    }
    if (Object.keys(families).length > 0) preferences.defaultFontFamily = families;
    for (const { pref, electron } of Object.values(FONT_SIZES)) {
      if (this.settings.isControlled(pref)) preferences[electron] = this.settings.value(pref) as number;
    }
    return preferences;
  }
}

const REQUEST_DEFAULTS: Record<string, unknown> = {
  networkPredictionEnabled: true,
  hyperlinkAuditingEnabled: true,
  doNotTrackEnabled: false,
  referrersEnabled: true,
};
const REQUEST_SETTINGS = new Set(Object.keys(REQUEST_DEFAULTS));
