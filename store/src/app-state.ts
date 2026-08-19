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
