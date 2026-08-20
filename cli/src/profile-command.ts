import {
  effectiveSearchEngine,
  findProfile,
  listSearchEngines,
  listProfiles,
  profileSettings,
  removeProfile,
  saveProfile,
  searchEngine,
  setDefaultProfile,
  setDefaultSource,
  setProfileSearchEngine,
} from "pixel-store";
import type { ProfilePreferences, ProfileSource, SearchEngineDefinition } from "pixel-store";

import {
  browserName,
  discoverBrowserProfiles,
  importBrowserProfile,
  namedProfileName,
  resolveProfileSource,
} from "./profile";
import type { DiscoveredBrowserProfile, ImportResult, ProfileImportResult } from "./profile";

export interface ProfileCommandOperations {
  importCookies(file: string, partition: string, replace: boolean): Promise<ImportResult>;
  removePartition(partition: string): Promise<boolean>;
}

interface ProfileSourceRequest {
  browserPath?: string;
  sourceDir?: string;
  sourceProfile?: string;
}

export type ProfileRequest =
  | { action: "ls"; json: boolean }
  | { action: "default"; json: boolean; name?: string; reset: boolean }
  | ({
      action: "default-source";
      browser?: string;
      clear: boolean;
      json: boolean;
    } & ProfileSourceRequest)
  | { action: "search-engines"; json: boolean }
  | { action: "settings"; json: boolean; name: string; searchEngine?: string }
  | { action: "create"; empty: boolean; name: string }
  | { action: "sources"; json: boolean }
  | { action: "sync"; name: string; replace: boolean }
  | { action: "remove"; name: string }
  | ({
      action: "import";
      browser: string;
      name: string;
      replace: boolean;
    } & ProfileSourceRequest);

export async function profileCommand(
  request: ProfileRequest,
  operations: ProfileCommandOperations,
): Promise<number> {
  if (request.action === "ls") {
    const profiles = listedProfiles();
    if (request.json) print(profiles);
    else printProfiles(profiles);
    return 0;
  }
  if (request.action === "default") {
    if (request.reset && request.name) {
      profileError("profile default accepts a name or --reset, not both");
    }
    if (request.json && (request.reset || request.name)) {
      profileError("--json only applies when showing the default profile");
    }
    if (request.reset || request.name === "default") {
      setDefaultProfile(null);
      process.stdout.write("default profile: default\n");
      return 0;
    }
    if (request.name) {
      const name = namedProfileName(request.name);
      if (!findProfile(name)) profileError(`no profile named ${name}`);
      setDefaultProfile(name);
      process.stdout.write(`default profile: ${name}\n`);
      return 0;
    }
    const name = profileSettings().defaultProfile ?? "default";
    if (request.json) print({ name });
    else process.stdout.write(`default profile: ${name}\n`);
    return 0;
  }
  if (request.action === "default-source") {
    const hasSourceOptions =
      request.browserPath !== undefined ||
      request.sourceDir !== undefined ||
      request.sourceProfile !== undefined;
    if (request.clear && request.browser) {
      profileError("profile default-source accepts a browser or --clear, not both");
    }
    if (!request.browser && hasSourceOptions) {
      profileError("profile default-source source options require a browser");
    }
    if (request.json && (request.clear || request.browser)) {
      profileError("--json only applies when showing the default source");
    }
    if (request.clear) {
      setDefaultSource(null);
      process.stdout.write("default profile source cleared\n");
      return 0;
    }
    if (request.browser) {
      const source = resolveProfileSource(browserName(request.browser), {
        browserPath: request.browserPath,
        sourceDir: request.sourceDir,
        sourceProfile: request.sourceProfile,
      });
      setDefaultSource(source);
      printDefaultSource(source);
      return 0;
    }
    const source = profileSettings().defaultSource;
    if (request.json) print(source);
    else if (source) printDefaultSource(source);
    else process.stdout.write("no default profile source\n");
    return 0;
  }
  if (request.action === "search-engines") {
    const engines = listSearchEngines();
    if (request.json) print(engines);
    else printSearchEngines(engines);
    return 0;
  }
  if (request.action === "settings") {
    const name = request.name === "default" ? "default" : namedProfileName(request.name);
    if (name !== "default" && !findProfile(name)) profileError(`no profile named ${name}`);
    if (request.json && request.searchEngine) {
      profileError("--json only applies when showing profile settings");
    }
    if (request.searchEngine) {
      if (request.searchEngine !== "inherit" && !searchEngine(request.searchEngine)) {
        profileError(
          `unknown search engine ${request.searchEngine} (${listSearchEngines()
            .map((engine) => engine.id)
            .join(", ")}, inherit)`,
        );
      }
      setProfileSearchEngine(
        name,
        request.searchEngine === "inherit" ? null : request.searchEngine,
      );
    }
    const settings = displayedSearchEngine(name);
    if (request.json) print({ name, searchEngine: settings });
    else printProfileSettings(name, settings);
    return 0;
  }
  if (request.action === "create") {
    const name = namedProfileName(request.name);
    if (findProfile(name)) profileError(`profile ${name} already exists`);
    const source = request.empty ? null : profileSettings().defaultSource;
    if (!source) {
      saveProfile({ createdAt: new Date().toISOString(), name });
      process.stdout.write(`created empty profile ${name}\n`);
      return 0;
    }
    const result = await importBrowserProfile(browserName(source.browser), {
      browserPath: source.browserPath,
      sourceDir: source.sourceDir,
      sourceProfile: source.sourceProfile,
      replace: false,
      targetProfile: name,
      importCookies: operations.importCookies,
    });
    saveProfile({
      createdAt: new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
      name,
      preferences: importedPreferences(undefined, result.searchEngine),
      source: result.source,
    });
    printImportResult(name, result);
    return 0;
  }
  if (request.action === "sources") {
    const sources = discoverBrowserProfiles();
    if (request.json) print(sources);
    else printProfileSources(sources);
    return 0;
  }
  if (request.action === "sync") {
    const name = namedProfileName(request.name);
    const profile = findProfile(name);
    if (!profile) profileError(`no profile named ${name}`);
    if (!profile.source) profileError(`profile ${name} was not imported and has no source to sync`);
    const result = await importBrowserProfile(browserName(profile.source.browser), {
      browserPath: profile.source.browserPath,
      sourceDir: profile.source.sourceDir,
      sourceProfile: profile.source.sourceProfile,
      replace: request.replace,
      targetProfile: name,
      importCookies: operations.importCookies,
    });
    saveProfile({
      ...profile,
      lastSyncedAt: new Date().toISOString(),
      preferences: importedPreferences(profile.preferences, result.searchEngine),
      source: result.source,
    });
    printImportResult(name, result);
    return 0;
  }
  if (request.action === "remove") {
    if (request.name === "default") profileError("the built-in default profile cannot be removed");
    const name = namedProfileName(request.name);
    if (profileSettings().defaultProfile === name) {
      profileError(`profile ${name} is the default; select another default before removing it`);
    }
    const removedData = await operations.removePartition(name);
    const removedRecord = removeProfile(name);
    process.stdout.write(
      removedData || removedRecord ? `removed profile ${name}\n` : `no profile named ${name}\n`,
    );
    return 0;
  }
  const options = {
    browserPath: request.browserPath,
    sourceDir: request.sourceDir,
    sourceProfile: request.sourceProfile,
    replace: request.replace,
    targetProfile: namedProfileName(request.name),
    importCookies: operations.importCookies,
  };
  const result = await importBrowserProfile(browserName(request.browser), options);
  const existing = findProfile(options.targetProfile);
  saveProfile({
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastSyncedAt: new Date().toISOString(),
    name: options.targetProfile,
    preferences: importedPreferences(existing?.preferences, result.searchEngine),
    source: result.source,
  });
  printImportResult(options.targetProfile, result);
  return 0;
}

function profileError(message: string): never {
  throw new Error(message);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printImportResult(name: string, result: ProfileImportResult): void {
  process.stdout.write(
    `imported ${result.imported} cookies into profile ${name}\n` +
      `imported search engine: ${result.searchEngine.name}\n` +
      (result.skippedSession ? `skipped ${result.skippedSession} session-only cookies\n` : "") +
      (result.skippedPartitioned ? `skipped ${result.skippedPartitioned} partitioned cookies\n` : "") +
      (result.skippedInvalid ? `skipped ${result.skippedInvalid} invalid cookies\n` : ""),
  );
}

interface ListedProfile {
  builtIn: boolean;
  createdAt: string | null;
  isDefault: boolean;
  lastSyncedAt: string | null;
  name: string;
  searchEngine: ReturnType<typeof displayedSearchEngine>;
  source: ProfileSource | null;
}

function listedProfiles(): ListedProfile[] {
  const selected = profileSettings().defaultProfile ?? "default";
  return [
    {
      builtIn: true,
      createdAt: null,
      isDefault: selected === "default",
      lastSyncedAt: null,
      name: "default",
      searchEngine: displayedSearchEngine("default"),
      source: null,
    },
    ...listProfiles().map((profile) => ({
      builtIn: false,
      createdAt: profile.createdAt,
      isDefault: selected === profile.name,
      lastSyncedAt: profile.lastSyncedAt ?? null,
      name: profile.name,
      searchEngine: displayedSearchEngine(profile.name),
      source: profile.source ?? null,
    })),
  ];
}

function printProfiles(profiles: ListedProfile[]): void {
  printTable(
    ["NAME", "DEFAULT", "SOURCE", "SEARCH ENGINE", "LAST SYNC"],
    profiles.map((profile) => [
      profile.name,
      profile.isDefault ? "yes" : "",
      profile.builtIn
        ? "built-in"
        : profile.source
          ? `${profile.source.browser}/${profile.source.sourceProfile}`
          : "—",
      profile.searchEngine.effective.name,
      profile.lastSyncedAt ?? "—",
    ]),
  );
}

function importedPreferences(
  preferences: ProfilePreferences | undefined,
  imported: SearchEngineDefinition,
): ProfilePreferences {
  return {
    ...preferences,
    searchEngine: {
      ...preferences?.searchEngine,
      imported,
    },
  };
}

function displayedSearchEngine(name: string) {
  const setting = effectiveSearchEngine(name);
  return {
    effective: setting.engine,
    imported: setting.imported,
    origin: setting.origin,
    override: setting.override,
  };
}

function printProfileSettings(name: string, setting: ReturnType<typeof displayedSearchEngine>): void {
  process.stdout.write(
    `profile: ${name}\n` +
      `search engine: ${setting.effective.name} (${setting.effective.id})\n` +
      `origin: ${setting.origin}\n` +
      `imported: ${setting.imported ? `${setting.imported.name} (${setting.imported.id})` : "—"}\n` +
      `override: ${setting.override ?? "—"}\n`,
  );
}

function printSearchEngines(engines: SearchEngineDefinition[]): void {
  printTable(
    ["ID", "NAME", "SUGGESTIONS"],
    engines.map((engine) => [engine.id, engine.name, engine.suggestUrl ? "yes" : "no"]),
  );
}

function printDefaultSource(source: ProfileSource): void {
  process.stdout.write(
    `default profile source: ${source.browser}/${source.sourceProfile} (${source.sourceDir})\n`,
  );
}

function printProfileSources(sources: DiscoveredBrowserProfile[]): void {
  if (sources.length === 0) {
    process.stdout.write("no importable browser profiles found\n");
    return;
  }
  printTable(
    ["BROWSER", "PROFILE", "DISPLAY NAME", "STATUS", "SOURCE DIR"],
    sources.map((source) => [
      source.browser,
      source.sourceProfile,
      source.displayName,
      source.lastUsed ? "last used" : "",
      source.sourceDir,
    ]),
  );
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column].length)),
  );
  const line = (row: string[]) =>
    row.map((value, column) => value.padEnd(widths[column])).join("  ").trimEnd();
  process.stdout.write(`${line(headers)}\n${rows.map(line).join("\n")}\n`);
}
