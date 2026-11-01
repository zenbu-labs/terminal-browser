import type { ServiceWorkerMain } from "electron";
import type { Caller } from "./router";
import type { ExtensionService } from "./service";

type Subscriber =
  | { extensionId: string; kind: "worker"; worker: ServiceWorkerMain }
  | { extensionId: string; kind: "frame"; processId: number; routingId: number };

// Electron fills `sender.tab` itself with windowId 0, index 0 and active false.
// Extension contexts keep this per-tab copy of what chrome.tabs.query would
// return them, so the preload can hand listeners the real tab.
export class SenderTabs {
  private readonly subscribers = new Map<string, Subscriber>();
  private pending = false;

  constructor(private readonly service: ExtensionService) {
    service.router.handle("runtime.watchSenderTabs", (caller) => this.watch(caller));
    service.onUnload((id) => {
      for (const [key, subscriber] of this.subscribers) if (subscriber.extensionId === id) this.subscribers.delete(key);
    });
  }

  changed() {
    if (this.pending || this.subscribers.size === 0) return;
    this.pending = true;
    setImmediate(() => {
      this.pending = false;
      this.push();
    });
  }

  private watch(caller: Caller) {
    const extensionId = caller.extension.id;
    const subscriber: Subscriber =
      caller.kind === "worker"
        ? { extensionId, kind: "worker", worker: caller.worker }
        : { extensionId, kind: "frame", processId: caller.frame.processId, routingId: caller.frame.routingId };
    const key =
      subscriber.kind === "worker"
        ? `${extensionId}:worker:${subscriber.worker.versionId}`
        : `${extensionId}:frame:${subscriber.processId}:${subscriber.routingId}`;
    this.subscribers.set(key, subscriber);
    return this.snapshot(extensionId);
  }

  private snapshot(extensionId: string): chrome.tabs.Tab[] {
    const extension = this.service.get(extensionId);
    if (!extension) return [];
    return this.service.allTabs().map((ref) => this.service.tabInfo(extension, ref));
  }

  private push() {
    const snapshots = new Map<string, chrome.tabs.Tab[]>();
    for (const [key, subscriber] of this.subscribers) {
      let tabs = snapshots.get(subscriber.extensionId);
      if (!tabs) snapshots.set(subscriber.extensionId, (tabs = this.snapshot(subscriber.extensionId)));
      if (subscriber.kind === "worker") {
        if (subscriber.worker.isDestroyed()) this.subscribers.delete(key);
        else this.service.events.sendToWorker(subscriber.worker, "runtime.senderTabs", [tabs]);
      } else if (!this.service.events.sendToFrame(subscriber, "runtime.senderTabs", [tabs])) {
        this.subscribers.delete(key);
      }
    }
  }
}
