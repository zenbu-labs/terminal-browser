import type { PermissionRequest } from "@zenbu-labs/pixel";
import { listSitePermissions, setSitePermission } from "shared";

import type { IconName } from "../ui/icons";
import type { PermissionDecision, PermissionPromptView } from "../ui/types";

interface PendingPrompt {
  tabId: number;
  embedder: string;
  kinds: string[];
  request: PermissionRequest;
  resolve(allowed: boolean): void;
}

const NEVER_PROMPTED = new Set(["display-capture", "geolocation", "geolocation-approximate"]);

const CHECK_DENIED_UNTIL_ASKED = new Set(["notifications"]);

export type MediaDevice = "camera" | "microphone";

export interface PermissionHost {
  requestRender(): void;
  deviceAccess(device: MediaDevice): Promise<boolean>;
}

export class PermissionPrompts {
  private readonly remembered = new Map<string, boolean>();
  private pending: PendingPrompt[] = [];

  constructor(private readonly host: PermissionHost) {
    for (const row of listSitePermissions()) {
      this.remembered.set(rememberKey(row.origin, row.embedder, row.kind), row.allowed);
    }
  }

  async request(tabId: number, pageUrl: string, request: PermissionRequest): Promise<boolean> {
    if (NEVER_PROMPTED.has(request.permission)) return false;
    const kinds = kindsOf(request);
    const embedder = originOf(pageUrl);
    const known = this.recall(request.origin, embedder, kinds);
    if (known === "blocked") return false;
    const allowed =
      known === "allowed" ||
      (await new Promise<boolean>((resolve) => {
        this.pending.push({ tabId, embedder, kinds, request, resolve });
        this.host.requestRender();
      }));
    if (!allowed) return false;
    for (const device of devicesOf(kinds)) {
      if (!(await this.host.deviceAccess(device))) return false;
    }
    return true;
  }

  check(pageUrl: string, request: PermissionRequest): boolean {
    if (NEVER_PROMPTED.has(request.permission)) return false;
    const known = this.recall(request.origin, originOf(pageUrl), kindsOf(request));
    if (known === "blocked") return false;
    if (known === "allowed") return true;
    return !CHECK_DENIED_UNTIL_ASKED.has(request.permission);
  }

  hasPending(tabId: number): boolean {
    return this.current(tabId) !== null;
  }

  view(tabId: number): PermissionPromptView | null {
    const prompt = this.current(tabId);
    if (!prompt) return null;
    return {
      host: hostOf(prompt.request.origin) || null,
      items: prompt.kinds.map(describe),
    };
  }

  decide(tabId: number, decision: PermissionDecision) {
    const prompt = this.current(tabId);
    if (!prompt) return;
    if (decision !== "dismiss") {
      for (const kind of prompt.kinds) {
        this.remember(prompt.request.origin, prompt.embedder, kind, decision === "allow");
      }
    }
    const sameQuestion = (candidate: PendingPrompt) =>
      candidate.request.origin === prompt.request.origin &&
      candidate.embedder === prompt.embedder &&
      candidate.kinds.join() === prompt.kinds.join();
    const answered = this.pending.filter(sameQuestion);
    this.pending = this.pending.filter((candidate) => !sameQuestion(candidate));
    for (const candidate of answered) candidate.resolve(decision === "allow");
    this.host.requestRender();
  }

  private remember(origin: string, embedder: string, kind: string, allowed: boolean) {
    this.remembered.set(rememberKey(origin, embedder, kind), allowed);
    setSitePermission({ origin, embedder, kind, allowed });
  }

  navigated(tabId: number, url: string) {
    const embedder = originOf(url);
    this.drop((prompt) => prompt.tabId === tabId && prompt.embedder !== embedder);
  }

  closed(tabId: number) {
    this.drop((prompt) => prompt.tabId === tabId);
  }

  private current(tabId: number): PendingPrompt | null {
    return this.pending.find((prompt) => prompt.tabId === tabId) ?? null;
  }

  private recall(
    origin: string,
    embedder: string,
    kinds: string[],
  ): "allowed" | "blocked" | "unknown" {
    const answers = kinds.map((kind) => this.remembered.get(rememberKey(origin, embedder, kind)));
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

function devicesOf(kinds: string[]): MediaDevice[] {
  const devices: MediaDevice[] = [];
  if (kinds.includes("media:video") || kinds.includes("media")) devices.push("camera");
  if (kinds.includes("media:audio") || kinds.includes("media")) devices.push("microphone");
  return devices;
}

function kindsOf(request: PermissionRequest): string[] {
  if (request.permission !== "media") return [request.permission];
  if (request.mediaTypes.length === 0) return ["media"];
  return request.mediaTypes.map((type) => `media:${type}`);
}

function rememberKey(origin: string, embedder: string, kind: string): string {
  return `${origin}\n${embedder}\n${kind}`;
}

function describe(kind: string): { icon: IconName; label: string } {
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
      return { icon: "arrow", label: "Open an external application" };
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

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return "";
  }
}
