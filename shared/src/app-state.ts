import crypto from "node:crypto";

import { store } from "./client";
import type { RequestedPermissions } from "./manifest";

// why are we using raw sql here?
function getAppState(key: string): string | null {
  const row = store()
    .sqlite.prepare("SELECT value FROM app_state WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function deleteAppState(key: string): void {
  store().sqlite.prepare("DELETE FROM app_state WHERE key = ?").run(key);
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

export function extensionsDeveloperMode(): boolean {
  return getAppState("extensions-developer-mode") === "on";
}

export function setExtensionsDeveloperMode(on: boolean): void {
  setAppState("extensions-developer-mode", on ? "on" : "off");
}

export function extensionErrorCollection(id: string): boolean | null {
  const value = getAppState(`extension-error-collection:${id}`);
  return value === null ? null : value === "on";
}

export function setExtensionErrorCollection(id: string, on: boolean | null): void {
  if (on === null) deleteAppState(`extension-error-collection:${id}`);
  else setAppState(`extension-error-collection:${id}`, on ? "on" : "off");
}

// The voices a ttsEngine extension last set with chrome.ttsEngine.updateVoices.
export function extensionTtsVoices(id: string): unknown[] | null {
  const value = getAppState(`extension-tts-voices:${id}`);
  return value === null ? null : (JSON.parse(value) as unknown[]);
}

export function setExtensionTtsVoices(id: string, voices: unknown[] | null): void {
  if (voices === null) deleteAppState(`extension-tts-voices:${id}`);
  else setAppState(`extension-tts-voices:${id}`, JSON.stringify(voices));
}

// What the user had accepted before an extension asked for more, so the
// approval prompt can show only what is new.
export function extensionAcceptedPermissions(id: string): RequestedPermissions | null {
  const value = getAppState(`extension-accepted-permissions:${id}`);
  return value === null ? null : (JSON.parse(value) as RequestedPermissions);
}

export function setExtensionAcceptedPermissions(id: string, accepted: RequestedPermissions | null): void {
  if (accepted === null) deleteAppState(`extension-accepted-permissions:${id}`);
  else setAppState(`extension-accepted-permissions:${id}`, JSON.stringify(accepted));
}
