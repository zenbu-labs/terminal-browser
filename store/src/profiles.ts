import fs from "node:fs";
import path from "node:path";

import { PROFILES_FILE } from "./paths";

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
  source?: ProfileSource;
}

export interface ProfileSettings {
  defaultProfile: string | null;
  defaultSource: ProfileSource | null;
}

interface ProfileRegistry {
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
    if (
      parsed.version === 1 &&
      Array.isArray(parsed.profiles) &&
      validDefaultProfile &&
      validDefaultSource
    ) {
      return {
        version: 1,
        profiles: parsed.profiles,
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

function writeRegistry(file: string, registry: ProfileRegistry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}
