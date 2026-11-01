import type { WebContents } from "electron";

import type { LoadedExtension } from "../loaded";
import type { ExtensionService } from "../service";

const permission = "debugger";
const RESTRICTED_SCHEMES = ["chrome:", "chrome-untrusted:", "devtools:", "terminal-browser:", "file:", "view-source:", "javascript:"];

// Methods that would reach past the attached tab (other targets, the browser,
// downloads, local files or every site's cookies). Chrome scopes these by
// client permissions we can't express on a shared connection, so they're refused.
const BLOCKED_DOMAINS = ["Target.", "Browser.", "SystemInfo.", "Tethering.", "IO.", "Storage.", "Extensions.", "PWA.", "BluetoothEmulation."];
const BLOCKED_METHODS = [
  "Page.setDownloadBehavior",
  "DOM.setFileInputFiles",
  "Network.getAllCookies",
  "Network.clearBrowserCookies",
  "Network.clearBrowserCache",
  "Network.setCookies",
  "Network.deleteCookies",
  "Page.addCompilationCache",
  "Runtime.getIsolateId",
];
const NAVIGATING_METHODS = ["Page.navigate"];

interface Attachment {
  extensionId: string;
  tabId: number;
  contents: WebContents;
  sessionId: string | undefined;
  stop: () => void;
}

interface Debuggee {
  tabId?: number;
  extensionId?: string;
  targetId?: string;
}

function protocolError(message: string): Error {
  return new Error(JSON.stringify({ code: -32000, message }));
}

export function mayDebugUrl(extension: LoadedExtension, url: string): boolean {
  if (!url || url === "about:blank") return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (RESTRICTED_SCHEMES.includes(parsed.protocol)) return false;
  if (parsed.protocol === "chrome-extension:") return parsed.host === extension.id;
  return extension.hasHostAccess(url);
}

function supportedVersion(version: unknown): boolean {
  const match = /^(\d+)\.(\d+)$/.exec(String(version ?? ""));
  return match !== null && Number(match[1]) === 1 && Number(match[2]) <= 3;
}

export function installDebugger(service: ExtensionService) {
  const { router } = service;
  const attachments = new Map<string, Attachment>();
  const key = (extensionId: string, tabId: number) => `${extensionId}:${tabId}`;

  const updateDebugging = () => {
    service.debugging.clear();
    for (const attachment of attachments.values()) {
      const set = service.debugging.get(attachment.tabId) ?? new Set<string>();
      set.add(attachment.extensionId);
      service.debugging.set(attachment.tabId, set);
    }
    service.changed();
  };

  const detach = (attachment: Attachment, reason: "target_closed" | "canceled_by_user" | null) => {
    if (attachments.get(key(attachment.extensionId, attachment.tabId)) !== attachment) return;
    attachments.delete(key(attachment.extensionId, attachment.tabId));
    attachment.stop();
    if (attachment.sessionId && !attachment.contents.isDestroyed()) {
      void attachment.contents.debugger.sendCommand("Target.detachFromTarget", { sessionId: attachment.sessionId }).catch(() => {});
    }
    updateDebugging();
    if (reason) service.dispatch(attachment.extensionId, "debugger.onDetach", [{ tabId: attachment.tabId }, reason]);
  };

  const tabOf = (target: Debuggee): { tabId: number; contents: WebContents } => {
    if (target.extensionId !== undefined) throw new Error("Cannot attach to this target.");
    let tabId = target.tabId;
    if (tabId === undefined && target.targetId !== undefined) {
      tabId = service.allTabs().find(({ tab }) => tab.targetId === target.targetId)?.tab.contentsId ?? undefined;
      if (tabId === undefined) throw new Error(`No target with given id ${target.targetId}.`);
    }
    if (tabId === undefined) throw new Error("Either tab id or extension id must be specified.");
    const ref = service.tabRef(tabId);
    const contents = ref ? service.contentsOf(ref.tab) : null;
    if (!contents) throw new Error(`No tab with given id ${tabId}.`);
    return { tabId, contents };
  };

  const attached = (extension: LoadedExtension, target: Debuggee): Attachment => {
    let tabId = target.tabId;
    if (tabId === undefined && target.targetId !== undefined) {
      tabId = service.allTabs().find(({ tab }) => tab.targetId === target.targetId)?.tab.contentsId ?? undefined;
    }
    const attachment = tabId !== undefined ? attachments.get(key(extension.id, tabId)) : undefined;
    if (!attachment) throw new Error(`Debugger is not attached to the tab with id: ${tabId ?? target.targetId}.`);
    return attachment;
  };

  router.handle(
    "debugger.attach",
    async (caller, value, version) => {
      const extension = caller.extension;
      const target = (value ?? {}) as Debuggee;
      if (!supportedVersion(version)) throw new Error(`Requested protocol version is not supported: ${version}.`);
      const { tabId, contents } = tabOf(target);
      if (!mayDebugUrl(extension, contents.getURL())) throw new Error("Cannot attach to this target.");
      if (attachments.has(key(extension.id, tabId))) throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
      const cdp = contents.debugger;
      if (!cdp.isAttached()) cdp.attach("1.3");
      let sessionId: string | undefined;
      try {
        const info = (await cdp.sendCommand("Target.getTargetInfo")) as { targetInfo: { targetId: string } };
        const result = (await cdp.sendCommand("Target.attachToTarget", { targetId: info.targetInfo.targetId, flatten: true })) as {
          sessionId: string;
        };
        sessionId = result.sessionId;
      } catch {
        throw new Error("Cannot attach to this target.");
      }
      const onMessage = (_event: unknown, method: string, params: unknown, fromSession?: string) => {
        if (fromSession !== sessionId) return;
        service.dispatch(extension.id, "debugger.onEvent", [{ tabId }, method, params ?? {}]);
      };
      const onDestroyed = () => detach(attachment, "target_closed");
      const onNavigate = (_event: unknown, url: string) => {
        if (!mayDebugUrl(extension, url)) detach(attachment, "target_closed");
      };
      cdp.on("message", onMessage);
      contents.once("destroyed", onDestroyed);
      contents.on("did-navigate", onNavigate);
      const attachment: Attachment = {
        extensionId: extension.id,
        tabId,
        contents,
        sessionId,
        stop: () => {
          cdp.off("message", onMessage);
          if (contents.isDestroyed()) return;
          contents.off("destroyed", onDestroyed);
          contents.off("did-navigate", onNavigate);
        },
      };
      attachments.set(key(extension.id, tabId), attachment);
      updateDebugging();
    },
    { permission },
  );

  router.handle(
    "debugger.detach",
    (caller, value) => {
      detach(attached(caller.extension, (value ?? {}) as Debuggee), null);
    },
    { permission },
  );

  router.handle(
    "debugger.sendCommand",
    async (caller, value, method, params) => {
      const extension = caller.extension;
      const attachment = attached(extension, (value ?? {}) as Debuggee);
      const name = String(method);
      if (BLOCKED_DOMAINS.some((domain) => name.startsWith(domain)) || BLOCKED_METHODS.includes(name)) throw protocolError("Not allowed");
      if (NAVIGATING_METHODS.includes(name)) {
        const url = String((params as { url?: string } | undefined)?.url ?? "");
        if (!mayDebugUrl(extension, url)) throw protocolError("Navigating to this URL is not allowed");
      }
      try {
        return (await attachment.contents.debugger.sendCommand(name, (params ?? {}) as Record<string, unknown>, attachment.sessionId)) ?? {};
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw message.startsWith("{") ? new Error(message) : protocolError(message);
      }
    },
    { permission },
  );

  router.handle(
    "debugger.getTargets",
    (caller) =>
      service.allTabs().map((ref) => {
        const info = service.tabInfo(caller.extension, ref);
        const tabId = ref.tab.contentsId!;
        const target: Record<string, unknown> = {
          type: "page",
          id: ref.tab.targetId ?? String(tabId),
          attached: [...attachments.values()].some((attachment) => attachment.tabId === tabId),
          tabId,
          title: info.title ?? "",
          url: info.url ?? "",
        };
        if (info.favIconUrl) target.faviconUrl = info.favIconUrl;
        return target;
      }),
    { permission },
  );

  service.onUnload((id) => {
    for (const attachment of [...attachments.values()]) if (attachment.extensionId === id) detach(attachment, null);
  });
}
