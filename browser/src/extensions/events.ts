import { ipcMain, webFrameMain } from "electron";
import type { IpcMainEvent, ServiceWorkerMain, Session } from "electron";

import { addLazyEvent, lazyEvents, removeLazyEvent } from "shared";

import { API_EVENTS, EVENT_CHANNEL, LISTEN_CHANNEL, READY_CHANNEL, UNLISTEN_CHANNEL } from "./protocol";
import { extensionIdFromUrl } from "./ids";
import type { Router } from "./router";

// One context's listeners for one event. Listeners added with a filter (like
// webNavigation's {url: [...]}) are tracked by a key the context picked.
interface Listeners {
  unfiltered: boolean;
  filters: Map<number, unknown>;
}

interface FrameTarget {
  processId: number;
  routingId: number;
  contentsId: number;
  listeners: Listeners;
}

export type EventFilterMatch = (filter: unknown) => boolean;

interface WorkerState {
  worker: ServiceWorkerMain | null;
  ready: boolean;
  // Electron drops messages sent to a worker that is still starting, so a
  // worker is only ready once its script ran and Chromium reports it running.
  scriptRan: boolean;
  running: boolean;
  listening: Map<string, Listeners>;
  stoppedListening: Map<string, Listeners>;
  waking: Promise<void> | null;
  queue: { event: string; args: unknown[]; match?: EventFilterMatch }[];
  onReady?: () => void;
}

const WAKE_TIMEOUT_MS = 10_000;
const EVENT_KEEPALIVE_MS = 30_000;

function frameKey(target: { processId: number; routingId: number }): string {
  return `${target.processId}:${target.routingId}`;
}

function emptyListeners(listeners: Listeners): boolean {
  return !listeners.unfiltered && listeners.filters.size === 0;
}

function updateListeners(listeners: Listeners, add: boolean, key: unknown, filter: unknown) {
  if (typeof key === "number") {
    if (add) listeners.filters.set(key, filter);
    else listeners.filters.delete(key);
  } else {
    listeners.unfiltered = add;
  }
}

// The keys of the filtered listeners an event reaches, or null when it reaches
// no listener at all. Undefined means every listener gets it.
function matchedKeys(listeners: Listeners, match: EventFilterMatch | undefined): number[] | undefined | null {
  if (!match) return undefined;
  const keys = [...listeners.filters].filter(([, filter]) => safeMatch(match, filter)).map(([key]) => key);
  if (keys.length === 0 && !listeners.unfiltered) return null;
  return keys;
}

function safeMatch(match: EventFilterMatch, filter: unknown): boolean {
  try {
    return match(filter);
  } catch {
    return false;
  }
}

// Tracks which extension contexts listen to which events, and delivers events
// to them. A service worker that has gone to sleep is woken up when one of the
// events it listened to fires, and events wait until its script has run.
export class EventHub {
  private readonly frames = new Map<string, Map<string, Map<string, FrameTarget>>>();
  private readonly workers = new Map<string, WorkerState>();
  private readonly lazy = new Map<string, Set<string>>();

  constructor(
    private readonly session: Session,
    private readonly router: Router,
    private readonly isLoaded: (id: string) => boolean,
  ) {
    ipcMain.on(LISTEN_CHANNEL, (event, name: string, key?: number, filter?: unknown) =>
      this.frameListen(event, name, true, key, filter),
    );
    ipcMain.on(UNLISTEN_CHANNEL, (event, name: string, key?: number) => this.frameListen(event, name, false, key));
    session.serviceWorkers.on("running-status-changed", ({ runningStatus, versionId }) => {
      const worker = session.serviceWorkers.getWorkerFromVersionID(versionId);
      const id = worker ? extensionIdFromUrl(worker.scope) : null;
      if (!worker || !id) return;
      if (runningStatus === "starting") this.workerStarting(id, worker);
      if (runningStatus === "running") this.workerRunning(id, worker);
      if (runningStatus === "stopped" || runningStatus === "stopping") this.workerStopped(id, worker);
    });
  }

  extensionLoaded(id: string) {
    this.lazy.set(id, new Set(lazyEvents(id)));
  }

  extensionUnloaded(id: string) {
    this.frames.delete(id);
    this.workers.delete(id);
    this.lazy.delete(id);
  }

  hasListener(id: string, event: string): boolean {
    if (this.lazy.get(id)?.has(event)) return true;
    if (this.workers.get(id)?.listening.has(event)) return true;
    return (this.frames.get(id)?.get(event)?.size ?? 0) > 0;
  }

  // `match` decides which filtered listeners the event reaches.
  dispatch(id: string, event: string, args: unknown[], match?: EventFilterMatch) {
    if (!this.isLoaded(id)) return;
    for (const target of [...(this.frames.get(id)?.get(event)?.values() ?? [])]) {
      const frame = webFrameMain.fromId(target.processId, target.routingId);
      if (!frame || frame.isDestroyed()) {
        this.frames.get(id)?.get(event)?.delete(frameKey(target));
        continue;
      }
      const matched = matchedKeys(target.listeners, match);
      if (matched === null) continue;
      try {
        frame.send(EVENT_CHANNEL, event, args, matched);
      } catch {}
    }
    this.dispatchToWorker(id, event, args, match);
  }

  sendToFrame(frame: { processId: number; routingId: number }, event: string, args: unknown[]): boolean {
    const target = webFrameMain.fromId(frame.processId, frame.routingId);
    if (!target || target.isDestroyed()) return false;
    target.send(EVENT_CHANNEL, event, args);
    return true;
  }

  sendToWorker(worker: ServiceWorkerMain, event: string, args: unknown[]) {
    if (!worker.isDestroyed()) worker.send(EVENT_CHANNEL, event, args);
  }

  async wake(id: string): Promise<ServiceWorkerMain | null> {
    const state = this.workerState(id);
    if (state.worker && state.ready) return state.worker;
    state.waking ??= this.startWorker(id, state).finally(() => {
      state.waking = null;
    });
    await state.waking;
    return state.worker;
  }

  // For events a worker can't have subscribed to before it first ran.
  async dispatchWaking(id: string, event: string, args: unknown[]) {
    const worker = await this.wake(id);
    const state = this.workers.get(id);
    if (worker && state?.ready && state.listening.has(event)) this.deliver(worker, event, args, undefined);
  }

  private dispatchToWorker(id: string, event: string, args: unknown[], match?: EventFilterMatch) {
    const state = this.workers.get(id);
    const live = state?.worker && !state.worker.isDestroyed() && state.ready;
    const listeners = live ? state.listening.get(event) : undefined;
    if (live && listeners) {
      const matched = matchedKeys(listeners, match);
      if (matched !== null) this.deliver(state.worker!, event, args, matched);
      return;
    }
    if (!this.lazy.get(id)?.has(event)) return;
    const previous = state?.stoppedListening.get(event);
    if (previous && matchedKeys(previous, match) === null) return;
    const waiting = this.workerState(id);
    waiting.queue.push({ event, args, match });
    void this.wake(id);
  }

  private deliver(worker: ServiceWorkerMain, event: string, args: unknown[], matched: number[] | undefined) {
    try {
      const task = worker.startTask();
      setTimeout(() => {
        try {
          task.end();
        } catch {}
      }, EVENT_KEEPALIVE_MS).unref();
    } catch {}
    try {
      worker.send(EVENT_CHANNEL, event, args, matched);
    } catch {}
  }

  private workerState(id: string): WorkerState {
    let state = this.workers.get(id);
    if (!state) {
      state = {
        worker: null,
        ready: false,
        scriptRan: false,
        running: false,
        listening: new Map(),
        stoppedListening: new Map(),
        waking: null,
        queue: [],
      };
      this.workers.set(id, state);
    }
    return state;
  }

  private async startWorker(id: string, state: WorkerState) {
    const ready = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, WAKE_TIMEOUT_MS);
      state.onReady = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    // A just-loaded extension's worker may not be registered yet, so retry briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.session.serviceWorkers.startWorkerForScope(`chrome-extension://${id}/`);
        break;
      } catch {
        if (state.worker) break;
        if (attempt >= 20 || !this.isLoaded(id)) {
          state.queue = [];
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    await ready;
  }

  private workerStarting(id: string, worker: ServiceWorkerMain) {
    this.router.wireWorker(worker);
    const state = this.workerState(id);
    if (state.worker === worker) return;
    state.worker = worker;
    state.ready = false;
    state.scriptRan = false;
    state.running = false;
    state.listening = new Map();
    worker.ipc.on(LISTEN_CHANNEL, (_event, name: string, key?: number, filter?: unknown) =>
      this.workerListen(id, worker, name, true, key, filter),
    );
    worker.ipc.on(UNLISTEN_CHANNEL, (_event, name: string, key?: number) => this.workerListen(id, worker, name, false, key));
    worker.ipc.on(READY_CHANNEL, () => this.workerScriptRan(id, worker));
  }

  private workerScriptRan(id: string, worker: ServiceWorkerMain) {
    const state = this.workers.get(id);
    if (!state || state.worker !== worker) return;
    state.scriptRan = true;
    this.workerReady(id, worker);
  }

  private workerRunning(id: string, worker: ServiceWorkerMain) {
    const state = this.workers.get(id);
    if (!state || state.worker !== worker) return;
    state.running = true;
    this.workerReady(id, worker);
  }

  private workerReady(id: string, worker: ServiceWorkerMain) {
    const state = this.workers.get(id);
    if (!state || state.worker !== worker || state.ready || !state.scriptRan || !state.running) return;
    state.ready = true;
    const queued = state.queue.splice(0);
    for (const { event, args, match } of queued) {
      const listeners = state.listening.get(event);
      const matched = listeners ? matchedKeys(listeners, match) : null;
      if (matched !== null) this.deliver(worker, event, args, matched);
    }
    state.onReady?.();
    state.onReady = undefined;
  }

  private workerStopped(id: string, worker: ServiceWorkerMain) {
    const state = this.workers.get(id);
    if (!state || state.worker !== worker) return;
    state.worker = null;
    state.ready = false;
    state.scriptRan = false;
    state.running = false;
    state.stoppedListening = state.listening;
    state.listening = new Map();
  }

  private workerListen(id: string, worker: ServiceWorkerMain, name: string, add: boolean, key?: unknown, filter?: unknown) {
    if (!API_EVENTS.has(name)) return;
    const state = this.workers.get(id);
    if (!state || state.worker !== worker) return;
    const lazy = this.lazy.get(id) ?? new Set<string>();
    this.lazy.set(id, lazy);
    let listeners = state.listening.get(name);
    if (!listeners) {
      if (!add) return;
      listeners = { unfiltered: false, filters: new Map() };
      state.listening.set(name, listeners);
    }
    updateListeners(listeners, add, key, filter);
    if (!emptyListeners(listeners)) {
      if (!lazy.has(name)) {
        lazy.add(name);
        addLazyEvent(id, name);
      }
      return;
    }
    state.listening.delete(name);
    lazy.delete(name);
    removeLazyEvent(id, name);
  }

  private frameListen(event: IpcMainEvent, name: string, add: boolean, key?: unknown, filter?: unknown) {
    if (!API_EVENTS.has(name)) return;
    const caller = this.router.callerForFrame(event.sender, event.senderFrame);
    if (!caller || caller.kind !== "frame") return;
    const id = caller.extension.id;
    let byEvent = this.frames.get(id);
    if (!byEvent) this.frames.set(id, (byEvent = new Map()));
    let targets = byEvent.get(name);
    if (!targets) byEvent.set(name, (targets = new Map()));
    const location = { processId: caller.frame.processId, routingId: caller.frame.routingId };
    let target = targets.get(frameKey(location));
    if (!target) {
      if (!add) return;
      target = { ...location, contentsId: caller.contents.id, listeners: { unfiltered: false, filters: new Map() } };
      targets.set(frameKey(location), target);
    }
    updateListeners(target.listeners, add, key, filter);
    if (emptyListeners(target.listeners)) targets.delete(frameKey(location));
  }
}
