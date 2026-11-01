import type { WebContents } from "electron";

import type { LoadedExtension } from "../loaded";
import { createNativeDebugger, nativeDebuggerTargets } from "../native";
import type { ExtensionService } from "../service";

const permission = "debugger";

interface Attachment {
  extensionId: string;
  tabId: number;
  client: Electron.Debugger;
  stop: () => void;
}

interface Debuggee {
  tabId?: number;
  extensionId?: string;
  targetId?: string;
  sessionId?: string;
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
    if (attachment.client.isAttached()) attachment.client.detach();
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
      if (attachments.has(key(extension.id, tabId))) throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
      const client = createNativeDebugger(service.session, extension.id, contents);
      if (!client) throw new Error("Cannot attach to this target.");
      client.attach(String(version));
      const onMessage = (_event: unknown, method: string, params: unknown, sessionId?: string) => {
        const source: Debuggee = sessionId ? { tabId, sessionId } : { tabId };
        service.dispatch(extension.id, "debugger.onEvent", [source, method, params ?? {}]);
      };
      const onDetach = () => detach(attachment, "target_closed");
      client.on("message", onMessage);
      client.on("detach", onDetach);
      const attachment: Attachment = {
        extensionId: extension.id,
        tabId,
        client,
        stop: () => {
          client.off("message", onMessage);
          client.off("detach", onDetach);
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
      const target = (value ?? {}) as Debuggee;
      const attachment = attached(extension, target);
      try {
        return (await attachment.client.sendCommand(String(method), (params ?? {}) as Record<string, unknown>, target.sessionId)) ?? {};
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
    },
    { permission },
  );

  router.handle(
    "debugger.getTargets",
    (caller) => [
      ...service.allTabs().map((ref) => {
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
      // Chromium's other targets: extension pages outside tabs, workers and the rest.
      ...nativeDebuggerTargets(service.session).filter((target) => target.tabId === undefined),
    ],
    { permission },
  );

  service.onUnload((id) => {
    for (const attachment of [...attachments.values()]) if (attachment.extensionId === id) detach(attachment, null);
  });
}
