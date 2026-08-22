import {
  DEFAULT_PROFILE,
  liveInstanceProfiles,
  matchProfiles,
  profileRegistry,
  setStoredLastUsedProfile,
  setStoredProfiles,
  sortProfiles,
  storedLastUsedProfile,
} from "pixel-store";
import type { RegistryProfile } from "pixel-store";

import { browserSession } from "./page/browser-session";

/** The store composes and matches the list, so the cli can read it without a browser running. */
export type BrowserProfile = RegistryProfile;

/** One process owns every pane and nothing else writes the list, so it is loaded once. */
let profiles: BrowserProfile[] | null = null;

function load(): BrowserProfile[] {
  profiles ??= profileRegistry();
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
  return DEFAULT_PROFILE;
}

/**
 * Accepts a slug or a display name, case-insensitively. Throws naming the input when unknown, and
 * throws naming both candidates when a display name is ambiguous.
 */
export function resolveProfile(selector: string): BrowserProfile {
  const matches = matchProfiles(load(), selector);
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

export async function deleteProfile(slug: string): Promise<void> {
  const profile = findSlug(slug);
  if (profile.builtIn) throw new Error("the default browser profile cannot be deleted");
  const panes = liveInstanceProfiles().filter((row) => row.profile === slug).length;
  if (panes > 0) {
    throw new Error(`cannot delete browser profile ${slug} while ${panes} pane(s) are using it`);
  }
  // Forgotten only once the storage is gone: a failed wipe must leave the profile on the list,
  // because a profile named the same later would reach that storage through the same slug.
  await wipe(slug);
  persist(load().filter((known) => known.slug !== slug));
  if (storedLastUsedProfile() === slug) setStoredLastUsedProfile(DEFAULT_PROFILE.slug);
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
  return slug === DEFAULT_PROFILE.slug ? null : `profile-${slug}`;
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
  return load().find((profile) => profile.slug === slug) ?? DEFAULT_PROFILE;
}

/**
 * What was asked for, else what the pane it split from is on, else the last one used, else the
 * default. A request that names no profile, or more than one, throws: opening signed in as
 * somebody else is worse than not opening.
 */
export function profileForNewPane(
  requested: string | null,
  parentTty: string | null,
): BrowserProfile {
  if (requested) return resolveProfile(requested);
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
