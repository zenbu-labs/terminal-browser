import fs from "node:fs";
import path from "node:path";

import { PROFILES_FILE } from "./paths";
import { searchEngine } from "./search-engines";
import type { SearchEngineDefinition } from "./search-engines";

export interface ProfileSource {
  browser: string;
  browserPath: string;
  sourceDir: string;
  sourceProfile: string;
}

export interface ProfileRecord {
  createdAt: string;
  lastSyncedAt?: string;
  name: string;
  preferences?: ProfilePreferences;
  source?: ProfileSource;
}

export interface ProfilePreferences {
  searchEngine?: {
    imported?: SearchEngineDefinition;
    override?: string;
  };
}

export interface EffectiveSearchEngine {
  engine: SearchEngineDefinition;
  imported: SearchEngineDefinition | null;
  origin: "fallback" | "imported" | "override";
  override: string | null;
}

export interface ProfileSettings {
  defaultProfile: string | null;
  defaultSource: ProfileSource | null;
}

interface ProfileRegistry {
  builtInPreferences?: ProfilePreferences;
  defaultProfile?: string;
  defaultSource?: ProfileSource;
  profiles: ProfileRecord[];
  version: 1;
}

export function listProfiles(file: string = PROFILES_FILE): ProfileRecord[] {
  return readRegistry(file).profiles.sort((a, b) => a.name.localeCompare(b.name));
}

export function findProfile(name: string, file: string = PROFILES_FILE): ProfileRecord | null {
  return listProfiles(file).find((profile) => profile.name === name) ?? null;
}

export function profileSettings(file: string = PROFILES_FILE): ProfileSettings {
  const registry = readRegistry(file);
  return {
    defaultProfile: registry.defaultProfile ?? null,
    defaultSource: registry.defaultSource ?? null,
  };
}

export function profilePreferences(
  name: string,
  file: string = PROFILES_FILE,
): ProfilePreferences {
  const registry = readRegistry(file);
  if (name === "default") return registry.builtInPreferences ?? {};
  return registry.profiles.find((profile) => profile.name === name)?.preferences ?? {};
}

export function effectiveSearchEngine(
  name: string,
  file: string = PROFILES_FILE,
): EffectiveSearchEngine {
  const settings = profilePreferences(name, file).searchEngine;
  const overridden = settings?.override ? searchEngine(settings.override) : null;
  if (overridden) {
    return {
      engine: overridden,
      imported: settings?.imported ?? null,
      origin: "override",
      override: settings?.override ?? null,
    };
  }
  if (settings?.imported) {
    return {
      engine: settings.imported,
      imported: settings.imported,
      origin: "imported",
      override: null,
    };
  }
  return {
    engine: searchEngine("google")!,
    imported: null,
    origin: "fallback",
    override: null,
  };
}

export function setProfileSearchEngine(
  name: string,
  override: string | null,
  file: string = PROFILES_FILE,
): void {
  if (override !== null && !searchEngine(override)) {
    throw new Error(`unknown search engine ${override}`);
  }
  const registry = readRegistry(file);
  if (name === "default") {
    registry.builtInPreferences = withSearchEngineOverride(
      registry.builtInPreferences,
      override,
    );
    writeRegistry(file, registry);
    return;
  }
  const at = registry.profiles.findIndex((profile) => profile.name === name);
  if (at === -1) throw new Error(`no profile named ${name}`);
  registry.profiles[at] = {
    ...registry.profiles[at],
    preferences: withSearchEngineOverride(registry.profiles[at].preferences, override),
  };
  writeRegistry(file, registry);
}

export function setDefaultProfile(name: string | null, file: string = PROFILES_FILE): void {
  const registry = readRegistry(file);
  if (name === null) delete registry.defaultProfile;
  else registry.defaultProfile = name;
  writeRegistry(file, registry);
}

export function setDefaultSource(source: ProfileSource | null, file: string = PROFILES_FILE): void {
  const registry = readRegistry(file);
  if (source === null) delete registry.defaultSource;
  else registry.defaultSource = source;
  writeRegistry(file, registry);
}

export function saveProfile(profile: ProfileRecord, file: string = PROFILES_FILE): void {
  const registry = readRegistry(file);
  const at = registry.profiles.findIndex((candidate) => candidate.name === profile.name);
  if (at === -1) registry.profiles.push(profile);
  else registry.profiles[at] = profile;
  writeRegistry(file, registry);
}

export function removeProfile(name: string, file: string = PROFILES_FILE): boolean {
  const registry = readRegistry(file);
  if (registry.defaultProfile === name) {
    throw new Error(`profile ${name} is the default; select another default before removing it`);
  }
  const profiles = registry.profiles.filter((profile) => profile.name !== name);
  if (profiles.length === registry.profiles.length) return false;
  writeRegistry(file, { ...registry, profiles });
  return true;
}

function readRegistry(file: string): ProfileRegistry {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ProfileRegistry>;
    const validDefaultProfile =
      parsed.defaultProfile === undefined || typeof parsed.defaultProfile === "string";
    const validDefaultSource =
      parsed.defaultSource === undefined ||
      (typeof parsed.defaultSource === "object" && parsed.defaultSource !== null);
    const validBuiltInPreferences =
      parsed.builtInPreferences === undefined ||
      (typeof parsed.builtInPreferences === "object" && parsed.builtInPreferences !== null);
    if (
      parsed.version === 1 &&
      Array.isArray(parsed.profiles) &&
      validDefaultProfile &&
      validDefaultSource &&
      validBuiltInPreferences
    ) {
      return {
        version: 1,
        profiles: parsed.profiles,
        ...(parsed.builtInPreferences === undefined
          ? {}
          : { builtInPreferences: parsed.builtInPreferences }),
        ...(parsed.defaultProfile === undefined ? {} : { defaultProfile: parsed.defaultProfile }),
        ...(parsed.defaultSource === undefined ? {} : { defaultSource: parsed.defaultSource }),
      };
    }
    throw new Error(`unsupported profile registry format in ${file}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, profiles: [] };
    }
    if (error instanceof SyntaxError) {
      throw new Error(`invalid profile registry in ${file}: ${error.message}`);
    }
    throw error;
  }
}

function withSearchEngineOverride(
  preferences: ProfilePreferences | undefined,
  override: string | null,
): ProfilePreferences {
  const search = { ...preferences?.searchEngine };
  if (override === null) delete search.override;
  else search.override = override;
  return { ...preferences, searchEngine: search };
}

function writeRegistry(file: string, registry: ProfileRegistry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}
