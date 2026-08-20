import {
  findProfile,
  listProfiles,
  profileSettings,
  removeProfile,
  saveProfile,
  setDefaultProfile,
  setDefaultSource,
} from "pixel-store";
import type { ProfileSource } from "pixel-store";

import {
  browserName,
  discoverBrowserProfiles,
  importBrowserProfile,
  namedProfileName,
  resolveProfileSource,
} from "./profile";
import type { DiscoveredBrowserProfile, ImportResult } from "./profile";

export interface ProfileCommandOperations {
  importCookies(file: string, partition: string, replace: boolean): Promise<ImportResult>;
  removePartition(partition: string): Promise<boolean>;
}

export async function profileCommand(
  args: string[],
  operations: ProfileCommandOperations,
): Promise<number> {
  const action = args.shift();
  if (action === "ls") {
    const json = takeBoolFlag(args, "--json");
    unexpected(args);
    const profiles = listedProfiles();
    if (json) print(profiles);
    else printProfiles(profiles);
    return 0;
  }
  if (action === "default") {
    const reset = takeBoolFlag(args, "--reset");
    const json = takeBoolFlag(args, "--json");
    const requested = args.shift();
    unexpected(args);
    if (reset && requested) profileError("profile default accepts a name or --reset, not both");
    if (json && (reset || requested)) {
      profileError("--json only applies when showing the default profile");
    }
    if (reset || requested === "default") {
      setDefaultProfile(null);
      process.stdout.write("default profile: default\n");
      return 0;
    }
    if (requested) {
      const name = namedProfileName(requested);
      if (!findProfile(name)) profileError(`no profile named ${name}`);
      setDefaultProfile(name);
      process.stdout.write(`default profile: ${name}\n`);
      return 0;
    }
    const name = profileSettings().defaultProfile ?? "default";
    if (json) print({ name });
    else process.stdout.write(`default profile: ${name}\n`);
    return 0;
  }
  if (action === "default-source") {
    const clear = takeBoolFlag(args, "--clear");
    const json = takeBoolFlag(args, "--json");
    const requested = args.shift();
    if (clear && requested) {
      profileError("profile default-source accepts a browser or --clear, not both");
    }
    if (json && (clear || requested)) {
      profileError("--json only applies when showing the default source");
    }
    if (clear) {
      unexpected(args);
      setDefaultSource(null);
      process.stdout.write("default profile source cleared\n");
      return 0;
    }
    if (requested) {
      const source = resolveProfileSource(browserName(requested), takeProfileSourceOptions(args));
      unexpected(args);
      setDefaultSource(source);
      printDefaultSource(source);
      return 0;
    }
    unexpected(args);
    const source = profileSettings().defaultSource;
    if (json) print(source);
    else if (source) printDefaultSource(source);
    else process.stdout.write("no default profile source\n");
    return 0;
  }
  if (action === "create") {
    const rawName = args.shift();
    if (!rawName) profileError("profile create requires a profile name");
    const name = namedProfileName(rawName);
    const empty = takeBoolFlag(args, "--empty");
    unexpected(args);
    if (findProfile(name)) profileError(`profile ${name} already exists`);
    const source = empty ? null : profileSettings().defaultSource;
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
      source: result.source,
    });
    printImportResult(name, result);
    return 0;
  }
  if (action === "sources") {
    const json = takeBoolFlag(args, "--json");
    unexpected(args);
    const sources = discoverBrowserProfiles();
    if (json) print(sources);
    else printProfileSources(sources);
    return 0;
  }
  if (action === "sync") {
    const rawName = args.shift();
    if (!rawName) profileError("profile sync requires a profile name");
    const name = namedProfileName(rawName);
    const replace = takeBoolFlag(args, "--replace");
    unexpected(args);
    const profile = findProfile(name);
    if (!profile) profileError(`no profile named ${name}`);
    if (!profile.source) profileError(`profile ${name} was not imported and has no source to sync`);
    const result = await importBrowserProfile(browserName(profile.source.browser), {
      browserPath: profile.source.browserPath,
      sourceDir: profile.source.sourceDir,
      sourceProfile: profile.source.sourceProfile,
      replace,
      targetProfile: name,
      importCookies: operations.importCookies,
    });
    saveProfile({ ...profile, lastSyncedAt: new Date().toISOString(), source: result.source });
    printImportResult(name, result);
    return 0;
  }
  if (action === "remove") {
    const rawName = args.shift();
    if (!rawName) profileError("profile remove requires a profile name");
    if (rawName === "default") profileError("the built-in default profile cannot be removed");
    const name = namedProfileName(rawName);
    unexpected(args);
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
  if (action !== "import") {
    profileError(
      "profile supports: ls, default, default-source, create, sources, import, sync, remove",
    );
  }
  const source = args.shift();
  if (!source) profileError("profile import requires a browser (brave, chrome, chromium)");
  const targetProfile = takeFlag(args, "--name");
  if (!targetProfile) profileError("profile import requires --name <name>");
  const options = {
    ...takeProfileSourceOptions(args),
    replace: takeBoolFlag(args, "--replace"),
    targetProfile: namedProfileName(targetProfile),
    importCookies: operations.importCookies,
  };
  unexpected(args);
  const result = await importBrowserProfile(browserName(source), options);
  const existing = findProfile(options.targetProfile);
  saveProfile({
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastSyncedAt: new Date().toISOString(),
    name: options.targetProfile,
    source: result.source,
  });
  printImportResult(options.targetProfile, result);
  return 0;
}

function takeFlag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at >= 0) {
    const value = args[at + 1];
    if (value === undefined) profileError(`${name} requires a value`);
    args.splice(at, 2);
    return value;
  }
  const inline = args.findIndex((arg) => arg.startsWith(`${name}=`));
  if (inline < 0) return undefined;
  const value = args[inline].slice(name.length + 1);
  if (!value) profileError(`${name} requires a value`);
  args.splice(inline, 1);
  return value;
}

function takeBoolFlag(args: string[], name: string): boolean {
  const at = args.indexOf(name);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
}

function unexpected(args: string[]): void {
  if (args.length > 0) profileError(`unexpected ${args[0]} (terminal-browser profile --help)`);
}

function profileError(message: string): never {
  throw new Error(message);
}

function takeProfileSourceOptions(args: string[]) {
  return {
    browserPath: takeFlag(args, "--browser-path"),
    sourceDir: takeFlag(args, "--source-dir"),
    sourceProfile: takeFlag(args, "--source-profile"),
  };
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printImportResult(name: string, result: ImportResult): void {
  process.stdout.write(
    `imported ${result.imported} cookies into profile ${name}\n` +
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
      source: null,
    },
    ...listProfiles().map((profile) => ({
      builtIn: false,
      createdAt: profile.createdAt,
      isDefault: selected === profile.name,
      lastSyncedAt: profile.lastSyncedAt ?? null,
      name: profile.name,
      source: profile.source ?? null,
    })),
  ];
}

function printProfiles(profiles: ListedProfile[]): void {
  printTable(
    ["NAME", "DEFAULT", "SOURCE", "LAST SYNC"],
    profiles.map((profile) => [
      profile.name,
      profile.isDefault ? "yes" : "",
      profile.builtIn
        ? "built-in"
        : profile.source
          ? `${profile.source.browser}/${profile.source.sourceProfile}`
          : "—",
      profile.lastSyncedAt ?? "—",
    ]),
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
