import {
  liveInstanceProfiles,
  setStoredLastUsedProfile,
  setStoredProfiles,
  storedLastUsedProfile,
  storedProfiles,
} from "pixel-store";

import { browserSession } from "./page/browser-session";

export interface BrowserProfile {
  /** stable id, url-safe; the built-in default is "default" */
  slug: string;
  /** display name */
  name: string;
  /** epoch ms */
  createdAt: number;
  /** true only for the default profile */
  builtIn: boolean;
}

const DEFAULT_SLUG = "default";
const DEFAULT_NAME = "Default";

/** Never persisted: this one is the storage the browser already had before profiles existed. */
const BUILT_IN: BrowserProfile = {
  slug: DEFAULT_SLUG,
  name: DEFAULT_NAME,
  createdAt: 0,
  builtIn: true,
};

/** One process owns every pane and nothing else writes the list, so it is loaded once. */
let profiles: BrowserProfile[] | null = null;

function sortProfiles(unsorted: BrowserProfile[]): BrowserProfile[] {
  return unsorted.sort((a, b) => {
    if (a.builtIn !== b.builtIn) return a.builtIn ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function load(): BrowserProfile[] {
  profiles ??= sortProfiles([
    BUILT_IN,
    ...storedProfiles()
      .filter((stored) => stored.slug !== DEFAULT_SLUG)
      .map((stored) => ({ ...stored, builtIn: false })),
  ]);
  return profiles;
}

function persist(next: BrowserProfile[]): void {
  profiles = sortProfiles(next);
  setStoredProfiles(
    profiles
      .filter((profile) => !profile.builtIn)
      .map(({ slug, name, createdAt }) => ({ slug, name, createdAt })),
  );
}

/** Slug first, then display name. Duplicate names are allowed, so a name can match several. */
function candidates(selector: string): BrowserProfile[] {
  const wanted = selector.trim().toLowerCase();
  if (!wanted) return [];
  const known = load();
  const bySlug = known.find((profile) => profile.slug.toLowerCase() === wanted);
  if (bySlug) return [bySlug];
  return known.filter((profile) => profile.name.trim().toLowerCase() === wanted);
}

function mintSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const taken = new Set(load().map((profile) => profile.slug));
  if (base && !taken.has(base)) return base;
  // Storage is keyed by the slug, so reusing one would hand a new profile the old one's cookies.
  const root = base || "profile";
  for (let suffix = 2; ; suffix++) {
    const candidate = `${root}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function findSlug(slug: string): BrowserProfile {
  const profile = load().find((known) => known.slug === slug);
  if (!profile) throw new Error(`no browser profile ${slug}`);
  return profile;
}

export function listProfiles(): BrowserProfile[] {
  return [...load()];
}

export function defaultProfile(): BrowserProfile {
  return BUILT_IN;
}

/**
 * Accepts a slug or a display name, case-insensitively. Throws naming the input when unknown, and
 * throws naming both candidates when a display name is ambiguous.
 */
export function resolveProfile(selector: string): BrowserProfile {
  const matches = candidates(selector);
  if (matches.length === 1) return matches[0];
  const wanted = selector.trim();
  if (matches.length === 0) throw new Error(`no browser profile matches "${wanted}"`);
  throw new Error(
    `"${wanted}" matches more than one browser profile: ${matches
      .map((profile) => profile.slug)
      .join(", ")}`,
  );
}

export function createProfile(name: string): BrowserProfile {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("a browser profile needs a name");
  const profile: BrowserProfile = {
    slug: mintSlug(trimmed),
    name: trimmed,
    createdAt: Date.now(),
    builtIn: false,
  };
  persist([...load(), profile]);
  noteProfileUsed(profile.slug);
  return profile;
}

export function renameProfile(slug: string, name: string): BrowserProfile {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("a browser profile needs a name");
  const profile = findSlug(slug);
  if (profile.builtIn) throw new Error("the default browser profile cannot be renamed");
  const renamed = { ...profile, name: trimmed };
  persist(load().map((known) => (known.slug === slug ? renamed : known)));
  return renamed;
}

export function deleteProfile(slug: string): void {
  const profile = findSlug(slug);
  if (profile.builtIn) throw new Error("the default browser profile cannot be deleted");
  const panes = liveInstanceProfiles().filter((row) => row.profile === slug).length;
  if (panes > 0) {
    throw new Error(`cannot delete browser profile ${slug} while ${panes} pane(s) are using it`);
  }
  // Wiped before it is forgotten: afterwards nothing knows this storage is unowned, and a profile
  // named the same later would reach it through the same slug.
  const wiped = wipe(slug);
  persist(load().filter((known) => known.slug !== slug));
  if (storedLastUsedProfile() === slug) setStoredLastUsedProfile(DEFAULT_SLUG);
  void wiped.catch(() => {});
}

export function clearProfileData(slug: string): Promise<void> {
  findSlug(slug);
  return wipe(slug);
}

/**
 * The `--partition` value for a profile, or null for the built-in default, which uses
 * defaultSession so existing logins survive this feature landing.
 */
export function partitionFor(slug: string): string | null {
  return slug === DEFAULT_SLUG ? null : `profile-${slug}`;
}

/** Records the profile a pane opened on or switched to; unknown slugs are ignored. */
export function noteProfileUsed(slug: string): void {
  if (!load().some((profile) => profile.slug === slug)) return;
  if (storedLastUsedProfile() === slug) return;
  setStoredLastUsedProfile(slug);
}

/** The last-used profile while it still exists, else the built-in default. */
export function lastUsedProfile(): BrowserProfile {
  const slug = storedLastUsedProfile();
  return load().find((profile) => profile.slug === slug) ?? BUILT_IN;
}

/**
 * What was asked for, else what the pane it split from is on, else the last one used, else the
 * default. An unresolvable request falls through rather than failing the launch.
 */
export function profileForNewPane(
  requested: string | null,
  parentTty: string | null,
): BrowserProfile {
  if (requested) {
    const matches = candidates(requested);
    if (matches.length === 1) return matches[0];
  }
  if (parentTty) {
    const parent = liveInstanceProfiles().find((row) => row.tty === parentTty && row.profile);
    const inherited = load().find((profile) => profile.slug === parent?.profile);
    if (inherited) return inherited;
  }
  return lastUsedProfile();
}

function wipe(slug: string): Promise<void> {
  // clearData is the thorough one - cookies, storage, cache - so nothing stays signed in.
  return browserSession(partitionFor(slug)).clearData();
}
