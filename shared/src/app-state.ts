import crypto from "node:crypto";

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

export function anonymousId(): string {
  const existing = getAppState("anonymous-id");
  if (existing) return existing;
  const id = crypto.randomUUID();
  setAppState("anonymous-id", id);
  return id;
}

export function lastSeenVersion(): string | null {
  return getAppState("last-seen-version");
}

export function setLastSeenVersion(version: string): void {
  setAppState("last-seen-version", version);
}

export function lastLaunchDay(): string | null {
  return getAppState("last-launch-day");
}

export function setLastLaunchDay(day: string): void {
  setAppState("last-launch-day", day);
}

export function lastActiveDay(): string | null {
  return getAppState("last-active-day");
}

export function setLastActiveDay(day: string): void {
  setAppState("last-active-day", day);
}
