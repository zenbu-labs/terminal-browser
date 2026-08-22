import { store } from "./client";

// why are we using raw sql here?
function getAppState(key: string): string | null {
  const row = store()
    .sqlite.prepare("SELECT value FROM app_state WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setAppState(key: string, value: string): void {
  store()
    .sqlite.prepare(
      "INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

export function lastUrl(): string | null {
  return getAppState("last-url");
}

export function setLastUrl(url: string): void {
  setAppState("last-url", url);
}

export interface StoredProfile {
  slug: string;
  name: string;
  createdAt: number;
}

export function storedProfiles(): StoredProfile[] {
  const raw = getAppState("browser-profiles-v1");
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const profiles: StoredProfile[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const { slug, name, createdAt } = entry as Partial<StoredProfile>;
    if (typeof slug !== "string" || !slug || typeof name !== "string") continue;
    profiles.push({ slug, name, createdAt: typeof createdAt === "number" ? createdAt : 0 });
  }
  return profiles;
}

export function setStoredProfiles(profiles: StoredProfile[]): void {
  setAppState("browser-profiles-v1", JSON.stringify(profiles));
}

export function storedLastUsedProfile(): string | null {
  return getAppState("browser-profiles-last-used");
}

export function setStoredLastUsedProfile(slug: string): void {
  setAppState("browser-profiles-last-used", slug);
}

export interface RegistryProfile extends StoredProfile {
  /** true only for the default profile */
  builtIn: boolean;
}

/** Never persisted: this one is the storage the browser already had before profiles existed. */
export const DEFAULT_PROFILE: RegistryProfile = {
  slug: "default",
  name: "Default",
  createdAt: 0,
  builtIn: true,
};

export function sortProfiles(unsorted: RegistryProfile[]): RegistryProfile[] {
  return unsorted.sort((a, b) => {
    if (a.builtIn !== b.builtIn) return a.builtIn ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** The default plus what is stored. Lives here so the browser and the cli see one same list. */
export function profileRegistry(): RegistryProfile[] {
  return sortProfiles([
    DEFAULT_PROFILE,
    ...storedProfiles()
      .filter((profile) => profile.slug !== DEFAULT_PROFILE.slug)
      .map((profile) => ({ ...profile, builtIn: false })),
  ]);
}

/**
 * Slug first, then display name, ignoring case and surrounding space. Duplicate names are allowed,
 * so a name can match several: every caller refuses rather than pick one.
 */
export function matchProfiles<T extends { slug: string; name: string }>(
  known: T[],
  selector: string,
): T[] {
  const wanted = selector.trim().toLowerCase();
  if (!wanted) return [];
  const bySlug = known.find((profile) => profile.slug.toLowerCase() === wanted);
  if (bySlug) return [bySlug];
  return known.filter((profile) => profile.name.trim().toLowerCase() === wanted);
}
