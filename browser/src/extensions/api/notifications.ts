import crypto from "node:crypto";
import fs from "node:fs";

import { Notification, nativeImage } from "electron";
import type { NativeImage } from "electron";

import type { LoadedExtension } from "../loaded";
import { resolveExtensionPath } from "../manifest";
import type { ExtensionService } from "../service";

const permission = "notifications";
const ID_LIMIT = 500;

interface NotificationOptions {
  type?: string;
  iconUrl?: string;
  title?: string;
  message?: string;
  contextMessage?: string;
  priority?: number;
  buttons?: { title: string; iconUrl?: string }[];
  requireInteraction?: boolean;
  silent?: boolean;
  imageUrl?: string;
  items?: { title: string; message: string }[];
  progress?: number;
}

interface Shown {
  options: NotificationOptions;
  native: Notification | null;
}

export type NotificationDelivery = "native" | "toast";

// How the last notification reached the user, for diagnosing a daemon that
// can't post to the macOS notification center.
export const delivery = { last: null as NotificationDelivery | null, error: null as string | null };

export function installNotifications(service: ExtensionService) {
  const { router } = service;
  const shown = new Map<string, Map<string, Shown>>();

  const of = (extensionId: string) => {
    let map = shown.get(extensionId);
    if (!map) shown.set(extensionId, (map = new Map()));
    return map;
  };

  const loadImage = async (extension: LoadedExtension, raw: string): Promise<NativeImage> => {
    const url = new URL(raw, extension.baseUrl);
    let image: NativeImage | null = null;
    if (url.protocol === "data:") {
      image = nativeImage.createFromDataURL(url.href);
    } else if (url.href.startsWith(extension.baseUrl)) {
      const file = resolveExtensionPath(extension.path, decodeURIComponent(url.pathname));
      if (file && fs.existsSync(file)) image = nativeImage.createFromPath(file);
    } else if (url.protocol === "http:" || url.protocol === "https:") {
      const response = await service.session.fetch(url.href).catch(() => null);
      if (response?.ok) image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()));
    }
    if (!image || image.isEmpty()) throw new Error("Unable to download all specified images.");
    return image;
  };

  const validate = (options: NotificationOptions) => {
    if (options.priority !== undefined && options.priority < 0) throw new Error("Low-priority notifications are deprecated on this platform.");
    if (options.progress !== undefined && options.type !== "progress") {
      throw new Error("The progress value should not be specified for non-progress notification");
    }
    if (options.progress !== undefined && (options.progress < 0 || options.progress > 100)) {
      throw new Error("The progress value should range from 0 to 100");
    }
    if (options.items !== undefined && options.type !== "list") throw new Error("List items provided for notification type != list");
    if (options.imageUrl !== undefined && options.type !== "image") throw new Error("Image resource provided for notification type != image");
  };

  const close = (extensionId: string, id: string, byUser: boolean, announce: boolean) => {
    const entry = shown.get(extensionId)?.get(id);
    if (!entry) return false;
    shown.get(extensionId)!.delete(id);
    if (entry.native) {
      entry.native.removeAllListeners();
      entry.native.close();
    }
    if (announce) service.dispatch(extensionId, "notifications.onClosed", [id, byUser]);
    return true;
  };

  const toast = (extension: LoadedExtension, options: NotificationOptions) => {
    const window = service.lastFocusedWindow();
    window?.host.toast(`${extension.name}: ${options.title ?? ""}`);
    delivery.last = "toast";
  };

  const show = async (extension: LoadedExtension, id: string, options: NotificationOptions) => {
    const icon = await loadImage(extension, options.iconUrl!);
    if (options.imageUrl) await loadImage(extension, options.imageUrl);
    const entry: Shown = { options, native: null };
    of(extension.id).set(id, entry);
    const body = options.type === "progress" ? `${options.message ?? ""} ${options.progress ?? 0}%`.trim() : options.message;
    const list = options.type === "list" ? (options.items ?? []).map((item) => `${item.title} ${item.message}`).join("\n") : "";
    if (!Notification.isSupported()) {
      delivery.error = "notifications are not supported";
      toast(extension, options);
      return;
    }
    const native = new Notification({
      title: options.title ?? "",
      subtitle: options.contextMessage,
      body: [body, list].filter(Boolean).join("\n"),
      icon,
      silent: options.silent ?? false,
      timeoutType: options.requireInteraction ? "never" : "default",
      actions: (options.buttons ?? []).slice(0, 2).map((button) => ({ type: "button" as const, text: button.title })),
    });
    entry.native = native;
    native.on("show", () => {
      delivery.last = "native";
      delivery.error = null;
    });
    native.on("failed", (_event, error) => {
      delivery.error = error;
      entry.native = null;
      toast(extension, options);
    });
    native.on("click", () => service.dispatch(extension.id, "notifications.onClicked", [id]));
    native.on("action", (_event, index) => service.dispatch(extension.id, "notifications.onButtonClicked", [id, index]));
    native.on("close", () => {
      if (shown.get(extension.id)?.get(id) !== entry) return;
      shown.get(extension.id)!.delete(id);
      service.dispatch(extension.id, "notifications.onClosed", [id, true]);
    });
    native.show();
  };

  const split = (args: unknown[]): { id: string | undefined; options: NotificationOptions } => {
    if (typeof args[0] === "string" || args[0] === undefined || args[0] === null) {
      return { id: (args[0] as string | undefined) ?? undefined, options: (args[1] ?? {}) as NotificationOptions };
    }
    return { id: undefined, options: (args[0] ?? {}) as NotificationOptions };
  };

  router.handle(
    "notifications.create",
    async (caller, ...args) => {
      const { id: requested, options } = split(args);
      if (!options.type || !options.iconUrl || options.title === undefined || options.message === undefined) {
        throw new Error("Some of the required properties are missing: type, iconUrl, title and message.");
      }
      validate(options);
      const id = requested || crypto.randomUUID();
      if (id.length > ID_LIMIT) throw new Error(`The notification's ID should be ${ID_LIMIT} characters or less`);
      close(caller.extension.id, id, false, false);
      await show(caller.extension, id, options);
      return id;
    },
    { permission },
  );

  router.handle(
    "notifications.update",
    async (caller, id, value) => {
      const entry = shown.get(caller.extension.id)?.get(String(id));
      if (!entry) return false;
      const options = { ...entry.options, ...((value ?? {}) as NotificationOptions) };
      validate(options);
      close(caller.extension.id, String(id), false, false);
      await show(caller.extension, String(id), options);
      return true;
    },
    { permission },
  );

  router.handle("notifications.clear", (caller, id) => close(caller.extension.id, String(id), false, true), { permission });
  router.handle(
    "notifications.getAll",
    (caller) => Object.fromEntries([...(shown.get(caller.extension.id)?.keys() ?? [])].map((id) => [id, true])),
    { permission },
  );
  router.handle("notifications.getPermissionLevel", () => "granted", { permission });

  service.onUnload((extensionId) => {
    for (const id of [...(shown.get(extensionId)?.keys() ?? [])]) close(extensionId, id, false, false);
    shown.delete(extensionId);
  });
}
