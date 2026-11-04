const { EventEmitter } = require("node:events");
const Module = require("node:module");

// Keeps the one listener Electron allows per webRequest event, so a test can call it.
class FakeWebRequest {
  beforeRequest = null;
  beforeRequestUrls = [];
  beforeRedirect = null;
  sendHeaders = null;
  headersReceived = null;

  onBeforeRequest(filter, listener) {
    this.beforeRequest = listener ?? (typeof filter === "function" ? filter : null);
    this.beforeRequestUrls = filter?.urls ?? [];
  }

  onBeforeRedirect(listener) {
    this.beforeRedirect = listener;
  }

  onBeforeSendHeaders(listener) {
    this.sendHeaders = listener;
  }

  onHeadersReceived(listener) {
    this.headersReceived = listener;
  }
}

// A stand-in for the parts of Electron the main-process modules under test touch.
class FakeSession extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.preloads = [];
    this.protocols = new Map();
    this.serviceWorkers = new EventEmitter();
    this.cookies = new EventEmitter();
    this.extensions = new EventEmitter();
    this.protocol = { handle: (scheme, handler) => this.protocols.set(scheme, handler) };
    this.webRequest = new FakeWebRequest();
  }

  registerPreloadScript(script) {
    this.preloads.push(script);
  }

  getPreloadScripts() {
    return this.preloads;
  }
}

const invokeHandlers = new Map();
const ipcMain = Object.assign(new EventEmitter(), {
  handle(channel, handler) {
    if (invokeHandlers.has(channel)) throw new Error(`second handler for ${channel}`);
    invokeHandlers.set(channel, handler);
  },
});

const defaultSession = new FakeSession("default");
const partitions = new Map();
const app = new EventEmitter();
app.getPath = () => require("node:os").tmpdir();
app.whenReady = () => Promise.resolve();

const electron = {
  app,
  ipcMain,
  invokeHandlers,
  FakeSession,
  FakeWebRequest,
  session: {
    defaultSession,
    fromPartition(name) {
      if (!partitions.has(name)) {
        const created = new FakeSession(name);
        partitions.set(name, created);
        app.emit("session-created", created);
      }
      return partitions.get(name);
    },
  },
  webContents: { getAllWebContents: () => [] },
  webFrameMain: { fromId: () => null },
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  shell: {},
  clipboard: {},
  nativeImage: {},
  screen: new EventEmitter(),
};

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return electron;
  return load.call(this, request, ...rest);
};

module.exports = electron;
