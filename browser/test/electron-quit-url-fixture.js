const http = require("node:http");

const { app, BrowserWindow, webContents } = require("electron");
const {
  QUIT_URL,
  QuitUrlPolicy,
  registerQuitUrlNavigationHandlers,
} = require("../dist/page/quit-url.js");

const server = http.createServer((request, response) => {
  if (request.url === "/redirect") {
    response.writeHead(302, { location: QUIT_URL });
    response.end();
    return;
  }
  response.setHeader("content-type", "text/html");
  if (request.url === "/frame") {
    response.end("<!doctype html><title>frame</title>");
    return;
  }
  response.end('<!doctype html><iframe src="/frame"></iframe>');
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function waitForResult(run) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("quit URL event timed out")), 3000);
    run((result) => {
      clearTimeout(timeout);
      resolve(result);
    });
  });
}

function policyHandler(policy, requester, rawUrl, resolve, reportProvenance = false) {
  let closeAttempts = 0;
  return {
    decide(eventUrl, request, targetContentsId = requester.id, initiatorContentsId) {
      const action = policy.request(
        eventUrl,
        targetContentsId,
        request,
        initiatorContentsId,
      );
      if (action === "close") closeAttempts++;
      if (eventUrl.startsWith("terminal-browser:")) {
        resolve({
          rawUrl,
          eventUrl,
          request,
          action,
          closeAttempts,
          ...(reportProvenance ? { targetContentsId, initiatorContentsId } : {}),
        });
      }
      return action;
    },
  };
}

async function popupToOwnerCase(
  port,
  { allowed = true, popupHost = "127.0.0.1", nested = false, expression },
) {
  const owner = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  const ownerPolicy = new QuitUrlPolicy(allowed, owner.webContents.id);
  owner.webContents.setWindowOpenHandler(() => ({ action: "allow" }));
  await owner.loadURL(`http://127.0.0.1:${port}/page`);
  await owner.webContents.executeJavaScript('window.name = "owner-target"');

  const popupPromise = nextChild(owner.webContents);
  await owner.webContents.executeJavaScript(
    `void window.open("http://${popupHost}:${port}/popup")`,
  );
  const popup = await popupPromise;
  let source = popup;
  let nestedPopup;
  if (nested) {
    popup.webContents.setWindowOpenHandler(() => ({ action: "allow" }));
    const nestedPromise = nextChild(popup.webContents);
    await popup.webContents.executeJavaScript(
      `void window.open("http://127.0.0.1:${port}/nested")`,
    );
    nestedPopup = await nestedPromise;
    source = nestedPopup;
  }

  const ownerContentsId = owner.webContents.id;
  const sourceContentsId = source.webContents.id;
  const result = await waitForResult(async (resolve) => {
    register(
      owner.webContents,
      policyHandler(ownerPolicy, owner.webContents, QUIT_URL, resolve, true),
    );
    await source.webContents.executeJavaScript(expression).catch(() => undefined);
  });
  nestedPopup?.destroy();
  popup.destroy();
  owner.destroy();
  return { ...result, ownerContentsId, sourceContentsId };
}

function register(contents, handler) {
  registerQuitUrlNavigationHandlers(
    contents,
    (frame) => webContents.fromFrame(frame),
    (eventUrl, request, targetContentsId, initiatorContentsId) =>
      handler.decide(eventUrl, request, targetContentsId, initiatorContentsId) !== "ignore",
  );
  contents.setWindowOpenHandler((details) => {
    handler.decide(details.url, "window-open", contents.id);
    return { action: "deny" };
  });
}

async function frameOf(window) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const frame = window.webContents.mainFrame.frames.find((candidate) => candidate !== window.webContents.mainFrame);
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("iframe was not created");
}

async function primaryCase(port, { rawUrl, allowed, request }) {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  const result = await waitForResult(async (resolve) => {
    const policy = new QuitUrlPolicy(allowed, window.webContents.id);
    register(window.webContents, policyHandler(policy, window.webContents, rawUrl, resolve));
    await window.loadURL(`http://127.0.0.1:${port}/page`);
    const frame = await frameOf(window);
    const expression =
      request === "navigation"
        ? `top.location.href = ${JSON.stringify(rawUrl)}`
        : `void window.open(${JSON.stringify(rawUrl)})`;
    await frame.executeJavaScript(expression).catch(() => undefined);
  });
  window.destroy();
  return result;
}

async function redirectCase(port) {
  const rawUrl = `http://127.0.0.1:${port}/redirect`;
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  const result = await waitForResult(async (resolve) => {
    const policy = new QuitUrlPolicy(true, window.webContents.id);
    register(window.webContents, policyHandler(policy, window.webContents, rawUrl, resolve));
    await window.loadURL(`http://127.0.0.1:${port}/page`);
    const frame = await frameOf(window);
    await frame.executeJavaScript(`top.location.href = ${JSON.stringify(rawUrl)}`).catch(() => undefined);
  });
  window.destroy();
  return result;
}

function nextChild(contents) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("popup was not created")), 3000);
    contents.once("did-create-window", (child) => {
      clearTimeout(timeout);
      resolve(child);
    });
  });
}

async function popupCases(port) {
  const owner = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  const ownerPolicy = new QuitUrlPolicy(true, owner.webContents.id);
  owner.webContents.setWindowOpenHandler(() => ({ action: "allow" }));
  await owner.loadURL(`http://127.0.0.1:${port}/page`);

  const popupPromise = nextChild(owner.webContents);
  await owner.webContents.executeJavaScript(`void window.open("http://127.0.0.1:${port}/popup")`);
  const popup = await popupPromise;

  async function request(contents, kind) {
    return waitForResult(async (resolve) => {
      register(contents, policyHandler(ownerPolicy, contents, QUIT_URL, resolve));
      const expression =
        kind === "navigation"
          ? `location.href = ${JSON.stringify(QUIT_URL)}`
          : `void window.open(${JSON.stringify(QUIT_URL)})`;
      await contents.executeJavaScript(expression).catch(() => undefined);
    });
  }

  const popupNavigation = await request(popup.webContents, "navigation");
  const popupWindowOpen = await request(popup.webContents, "window-open");

  popup.webContents.setWindowOpenHandler(() => ({ action: "allow" }));
  const nestedPromise = nextChild(popup.webContents);
  await popup.webContents.executeJavaScript(`void window.open("http://127.0.0.1:${port}/nested")`);
  const nested = await nestedPromise;
  const nestedPopupNavigation = await request(nested.webContents, "navigation");
  const nestedPopupWindowOpen = await request(nested.webContents, "window-open");

  nested.destroy();
  popup.destroy();
  owner.destroy();
  return { popupNavigation, popupWindowOpen, nestedPopupNavigation, nestedPopupWindowOpen };
}

async function foreignCase(port, allowed, ownerPolicy) {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  const result = await waitForResult(async (resolve) => {
    const policy = ownerPolicy ?? new QuitUrlPolicy(allowed, window.webContents.id);
    register(window.webContents, policyHandler(policy, window.webContents, QUIT_URL, resolve));
    await window.loadURL(`http://127.0.0.1:${port}/page`);
    const frame = await frameOf(window);
    await frame.executeJavaScript(`top.location.href = ${JSON.stringify(QUIT_URL)}`).catch(() => undefined);
  });
  window.destroy();
  return result;
}

app.on("window-all-closed", (event) => event.preventDefault());

app.whenReady().then(async () => {
  const port = await listen(server);
  const output = {
    defaultUpperNavigation: await primaryCase(port, {
      rawUrl: "Terminal-browser://quit",
      allowed: false,
      request: "navigation",
    }),
    defaultUpperWindowOpen: await primaryCase(port, {
      rawUrl: "Terminal-browser://quit",
      allowed: false,
      request: "window-open",
    }),
    optInUpperNavigation: await primaryCase(port, {
      rawUrl: "Terminal-browser://quit",
      allowed: true,
      request: "navigation",
    }),
    optInUpperWindowOpen: await primaryCase(port, {
      rawUrl: "Terminal-browser://quit",
      allowed: true,
      request: "window-open",
    }),
    variants: {},
  };

  for (const [name, rawUrl] of Object.entries({
    hostCase: "terminal-browser://QUIT",
    encodedHost: "terminal-browser://qu%69t",
    slash: "terminal-browser://quit/",
    path: "terminal-browser://quit/path",
    query: "terminal-browser://quit?now",
    fragment: "terminal-browser://quit#now",
  })) {
    output.variants[name] = await primaryCase(port, { rawUrl, allowed: true, request: "navigation" });
  }

  output.redirect = await redirectCase(port);
  Object.assign(output, await popupCases(port));
  output.crossOriginPopup = {
    location: await popupToOwnerCase(port, {
      popupHost: "localhost",
      expression: `opener.location = ${JSON.stringify(QUIT_URL)}`,
    }),
    href: await popupToOwnerCase(port, {
      popupHost: "localhost",
      expression: `opener.location.href = ${JSON.stringify(QUIT_URL)}`,
    }),
    replace: await popupToOwnerCase(port, {
      popupHost: "localhost",
      expression: `opener.location.replace(${JSON.stringify(QUIT_URL)})`,
    }),
    namedTarget: await popupToOwnerCase(port, {
      popupHost: "localhost",
      expression: `void window.open(${JSON.stringify(QUIT_URL)}, "owner-target")`,
    }),
  };
  output.sameOriginPopup = {
    location: await popupToOwnerCase(port, {
      expression: `opener.location = ${JSON.stringify(QUIT_URL)}`,
    }),
    replace: await popupToOwnerCase(port, {
      expression: `opener.location.replace(${JSON.stringify(QUIT_URL)})`,
    }),
    namedTarget: await popupToOwnerCase(port, {
      expression: `void window.open(${JSON.stringify(QUIT_URL)}, "owner-target")`,
    }),
    openerOpenNamed: await popupToOwnerCase(port, {
      expression: `void opener.open(${JSON.stringify(QUIT_URL)}, "owner-target")`,
    }),
  };
  output.nestedPopup = {
    openerChain: await popupToOwnerCase(port, {
      nested: true,
      expression: `opener.opener.location = ${JSON.stringify(QUIT_URL)}`,
    }),
    namedTarget: await popupToOwnerCase(port, {
      nested: true,
      expression: `void window.open(${JSON.stringify(QUIT_URL)}, "owner-target")`,
    }),
  };
  output.ownerRealm = {
    navigationDefault: await popupToOwnerCase(port, {
      allowed: false,
      expression: `opener.eval(${JSON.stringify(`location = ${JSON.stringify(QUIT_URL)}`)})`,
    }),
    navigationOptIn: await popupToOwnerCase(port, {
      expression: `opener.eval(${JSON.stringify(`location = ${JSON.stringify(QUIT_URL)}`)})`,
    }),
    windowOpenDefault: await popupToOwnerCase(port, {
      allowed: false,
      expression: `opener.eval(${JSON.stringify(`void window.open(${JSON.stringify(QUIT_URL)})`)})`,
    }),
    windowOpenOptIn: await popupToOwnerCase(port, {
      expression: `opener.eval(${JSON.stringify(`void window.open(${JSON.stringify(QUIT_URL)})`)})`,
    }),
  };

  const owner = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  const ownerPolicy = new QuitUrlPolicy(true, owner.webContents.id);
  output.foreignNavigation = await foreignCase(port, true, ownerPolicy);
  owner.destroy();
  output.otherSessionNavigation = await foreignCase(port, false);

  process.stdout.write(`${JSON.stringify(output)}\n`);
  server.close(() => app.quit());
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  server.close(() => app.exit(1));
});
