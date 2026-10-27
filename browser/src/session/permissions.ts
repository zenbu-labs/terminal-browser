import type { PermissionCheck, PermissionCheckAnswer, PermissionRequest } from "@zenbu-labs/pixel";
import { setSitePermission, sitePermission } from "shared";

import type { IconName } from "../ui/icons";
import type { PermissionDecision, PermissionPromptView } from "../ui/types";

interface PendingPrompt {
  tabId: number;
  kinds: string[];
  request: PermissionRequest;
  resolve(allowed: boolean): void;
}

const NEVER_PROMPTED = new Set(["display-capture", "geolocation", "geolocation-approximate"]);

const NEVER_REMEMBERED = new Set(["openExternal"]);

export type MediaDevice = "camera" | "microphone";

export interface PermissionHost {
  requestRender(): void;
  deviceAccess(device: MediaDevice): Promise<boolean>;
}

export class PermissionPrompts {
  private pending: PendingPrompt[] = [];

  constructor(private readonly host: PermissionHost) {}

  async request(tabId: number, request: PermissionRequest): Promise<boolean> {
    if (NEVER_PROMPTED.has(request.permission)) return false;
    const kinds = kindsOf(request);
    const known = this.recall(request, kinds);
    if (known === "blocked") return false;
    const allowed =
      known === "allowed" ||
      (await new Promise<boolean>((resolve) => {
        const prompt: PendingPrompt = { tabId, kinds, request, resolve };
        this.pending.push(prompt);
        request.signal.addEventListener("abort", () => this.drop((candidate) => candidate === prompt));
        this.host.requestRender();
      }));
    if (!allowed) return false;
    for (const device of devicesOf(kinds)) {
      if (!(await this.host.deviceAccess(device))) return false;
    }
    return true;
  }

  check(check: PermissionCheck): PermissionCheckAnswer {
    if (NEVER_PROMPTED.has(check.permission)) return false;
    const known = this.recall(check, kindsOf(check));
    if (known === "blocked") return false;
    if (known === "allowed") return true;
    return "prompt";
  }

  hasPending(tabId: number): boolean {
    return this.current(tabId) !== null;
  }

  view(tabId: number): PermissionPromptView | null {
    const prompt = this.current(tabId);
    if (!prompt) return null;
    return {
      host: hostOf(prompt.request.origin) || null,
      items: prompt.kinds.map((kind) => describe(kind, prompt.request.externalURL)),
    };
  }

  decide(tabId: number, decision: PermissionDecision) {
    const prompt = this.current(tabId);
    if (!prompt) return;
    if (decision !== "dismiss" && rememberable(prompt.request)) {
      for (const kind of prompt.kinds) {
        setSitePermission({
          origin: prompt.request.origin,
          embedder: prompt.request.embedder,
          kind,
          allowed: decision === "allow",
        });
      }
    }
    const sameQuestion = (candidate: PendingPrompt) =>
      candidate === prompt ||
      (rememberable(candidate.request) &&
        candidate.request.origin === prompt.request.origin &&
        candidate.request.embedder === prompt.request.embedder &&
        candidate.kinds.join() === prompt.kinds.join());
    const answered = this.pending.filter(sameQuestion);
    this.pending = this.pending.filter((candidate) => !sameQuestion(candidate));
    for (const candidate of answered) candidate.resolve(decision === "allow");
    this.host.requestRender();
  }

  closed(tabId: number) {
    this.drop((prompt) => prompt.tabId === tabId);
  }

  private current(tabId: number): PendingPrompt | null {
    return this.pending.find((prompt) => prompt.tabId === tabId) ?? null;
  }

  private recall(check: PermissionCheck, kinds: string[]): "allowed" | "blocked" | "unknown" {
    if (!rememberable(check)) return "unknown";
    const answers = kinds.map((kind) => sitePermission(check.origin, check.embedder, kind));
    if (answers.some((answer) => answer === false)) return "blocked";
    if (answers.every((answer) => answer === true)) return "allowed";
    return "unknown";
  }

  private drop(matches: (prompt: PendingPrompt) => boolean) {
    const dropped = this.pending.filter(matches);
    if (dropped.length === 0) return;
    this.pending = this.pending.filter((prompt) => !matches(prompt));
    for (const prompt of dropped) prompt.resolve(false);
    this.host.requestRender();
  }
}

function rememberable(check: PermissionCheck): boolean {
  return (
    !NEVER_REMEMBERED.has(check.permission) &&
    isTupleOrigin(check.origin) &&
    isTupleOrigin(check.embedder)
  );
}

function isTupleOrigin(origin: string): boolean {
  return origin !== "" && origin !== "null";
}

function devicesOf(kinds: string[]): MediaDevice[] {
  const devices: MediaDevice[] = [];
  if (kinds.includes("media:video") || kinds.includes("media")) devices.push("camera");
  if (kinds.includes("media:audio") || kinds.includes("media")) devices.push("microphone");
  return devices;
}

function kindsOf(check: PermissionCheck): string[] {
  if (check.permission !== "media") return [check.permission];
  if (check.mediaTypes.length === 0) return ["media"];
  return check.mediaTypes.map((type) => `media:${type}`);
}

function describe(kind: string, externalURL: string | null): { icon: IconName; label: string } {
  switch (kind) {
    case "media:video":
      return { icon: "camera", label: "Use your camera" };
    case "media:audio":
      return { icon: "mic", label: "Use your microphone" };
    case "media":
      return { icon: "camera", label: "Use your camera and microphone" };
    case "geolocation":
    case "geolocation-approximate":
      return { icon: "pin", label: "Know your location" };
    case "notifications":
      return { icon: "bell", label: "Show notifications" };
    case "clipboard-read":
    case "deprecated-sync-clipboard-read":
      return { icon: "clipboard", label: "See text and images copied to the clipboard" };
    case "midiSysex":
      return { icon: "shield", label: "Use your MIDI devices" };
    case "idle-detection":
      return { icon: "shield", label: "Know when you're actively using this device" };
    case "openExternal":
      return { icon: "arrow", label: externalOpenLabel(externalURL) };
    case "window-management":
      return { icon: "monitor", label: "Manage windows on all your displays" };
    case "speaker-selection":
      return { icon: "shield", label: "Use your speakers" };
    case "local-fonts":
      return { icon: "text", label: "Use fonts installed on your device" };
    case "fileSystem":
      return { icon: "shield", label: "Edit files on your device" };
    default:
      return { icon: "shield", label: `Use ${kind}` };
  }
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return "";
  }
}

function externalOpenLabel(externalURL: string | null): string {
  const scheme = externalURL ? externalURL.split(":")[0] : "";
  return scheme ? `Open a ${scheme}: link in another app` : "Open another app";
}
