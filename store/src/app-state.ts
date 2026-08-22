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

export function adblockEnabled(): boolean {
  return getAppState("adblock-enabled") !== "0";
}

export function setAdblockEnabled(enabled: boolean): void {
  setAppState("adblock-enabled", enabled ? "1" : "0");
}

export function adblockAllowlist(): string[] {
  const raw = getAppState("adblock-allowlist");
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((host): host is string => typeof host === "string");
  } catch {
    return [];
  }
}

export function setAdblockAllowlist(hosts: string[]): void {
  setAppState("adblock-allowlist", JSON.stringify(hosts));
}
