import { ipcMain } from "electron";
import type { IpcMainInvokeEvent, IpcMainServiceWorkerInvokeEvent, ServiceWorkerMain, Session, WebContents, WebFrameMain } from "electron";

import type { LoadedExtension } from "./loaded";
import { extensionIdFromOrigin, extensionIdFromUrl } from "./ids";
import { API_METHODS, channelFor } from "./protocol";

export type Caller =
  | { kind: "worker"; extension: LoadedExtension; worker: ServiceWorkerMain }
  | { kind: "frame"; extension: LoadedExtension; contents: WebContents; frame: WebFrameMain };

export type Handler = (caller: Caller, ...args: unknown[]) => unknown;

export interface HandlerOptions {
  permission?: string;
}

export class ApiError extends Error {}

// Extension pages only run code after the user opened them, so their calls
// count as user gestures; service workers need a recent click on the extension.
export function hasUserGesture(caller: Caller): boolean {
  return caller.kind === "frame" || caller.extension.hadRecentUserGesture();
}

// Every privileged call is answered here. The calling extension is always
// derived from the sender's own origin or worker scope, never from arguments.
export class Router {
  private readonly handlers = new Map<string, { run: Handler; options: HandlerOptions }>();
  private readonly wiredWorkers = new WeakSet<ServiceWorkerMain>();

  constructor(
    private readonly session: Session,
    private readonly extension: (id: string) => LoadedExtension | null,
  ) {
    for (const method of API_METHODS) {
      ipcMain.handle(channelFor(method), (event, ...args) => this.fromFrame(method, event, args));
    }
  }

  handle(method: string, run: Handler, options: HandlerOptions = {}) {
    if (!API_METHODS.has(method)) throw new Error(`${method} is missing from the API spec`);
    this.handlers.set(method, { run, options });
  }

  wireWorker(worker: ServiceWorkerMain) {
    if (this.wiredWorkers.has(worker)) return;
    this.wiredWorkers.add(worker);
    for (const method of API_METHODS) {
      worker.ipc.handle(channelFor(method), (event, ...args) => this.fromWorker(method, event, args));
    }
  }

  callerForFrame(contents: WebContents, frame: WebFrameMain | null): Caller | null {
    if (!frame || contents.session !== this.session) return null;
    const id = extensionIdFromOrigin(frame.origin);
    const extension = id ? this.extension(id) : null;
    if (!extension) return null;
    return { kind: "frame", extension, contents, frame };
  }

  callerForWorker(worker: ServiceWorkerMain): Caller | null {
    const id = extensionIdFromUrl(worker.scope);
    const extension = id ? this.extension(id) : null;
    if (!extension) return null;
    return { kind: "worker", extension, worker };
  }

  private fromFrame(method: string, event: IpcMainInvokeEvent, args: unknown[]) {
    const caller = this.callerForFrame(event.sender, event.senderFrame);
    if (!caller) throw new Error(`${method} is only available to extensions`);
    return this.run(method, caller, args);
  }

  private fromWorker(method: string, event: IpcMainServiceWorkerInvokeEvent, args: unknown[]) {
    if (event.session !== this.session) throw new Error(`${method} is only available to extensions`);
    const caller = this.callerForWorker(event.serviceWorker);
    if (!caller) throw new Error(`${method} is only available to extensions`);
    return this.run(method, caller, args);
  }

  private async run(method: string, caller: Caller, args: unknown[]) {
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`chrome.${method} is not supported in terminal-browser`);
    const { permission } = handler.options;
    if (permission && !caller.extension.hasApiPermission(permission)) {
      throw new Error(`'${permission}' permission is required to use chrome.${method}`);
    }
    try {
      return await handler.run(caller, ...args);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }
}
