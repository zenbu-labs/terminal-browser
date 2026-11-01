import { BrowserWindow } from "electron";
import type { WebContents } from "electron";

import type { LoadedExtension } from "../loaded";
import type { Caller } from "../router";
import type { ExtensionService } from "../service";

const permission = "identity";
const NON_INTERACTIVE_MAX_MS = 60_000;
const ABORTED = -3;

const USER_REJECTED = "The user did not approve access.";
const INTERACTION_REQUIRED =
  "User interaction required. Try setting `abortOnLoadForNonInteractive` and `timeoutMsForNonInteractive` if multiple navigations are required, or if the authorization page requires user interaction.";
const PAGE_LOAD_FAILURE = "Authorization page could not be loaded.";
const PAGE_LOAD_TIMED_OUT = "Authorization page load timed out.";

interface WebAuthFlowDetails {
  url?: string;
  interactive?: boolean;
  abortOnLoadForNonInteractive?: boolean;
  timeoutMsForNonInteractive?: number;
}

function redirectPrefix(extension: LoadedExtension): string {
  return `https://${extension.id}.chromiumapp.org/`;
}

// Resolves with the URL once the auth page sends the browser to the extension's
// chromiumapp.org redirect, and stops that request from going out.
function watchForRedirect(contents: WebContents, prefix: string, finish: (result: { url?: string; error?: string }) => void) {
  const check = (event: { preventDefault(): void }, url: string) => {
    if (!url.startsWith(prefix)) return false;
    event.preventDefault();
    finish({ url });
    return true;
  };
  contents.on("will-redirect", (event) => {
    check(event, event.url);
  });
  contents.on("will-navigate", (event) => {
    check(event, event.url);
  });
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && details.url.startsWith(prefix)) finish({ url: details.url });
  });
  contents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
    if (!isMainFrame || code === ABORTED || url.startsWith(prefix)) return;
    finish({ error: PAGE_LOAD_FAILURE });
  });
}

export function installIdentity(service: ExtensionService) {
  const { router } = service;
  const interactiveFlows = new Set<string>();

  const interactiveFlow = async (caller: Caller, url: string) => {
    const extension = caller.extension;
    if (interactiveFlows.has(extension.id)) throw new Error("Only one web auth flow is allowed at a time.");
    const window = service.currentWindow(caller);
    if (!window) throw new Error("Couldn't create a browser window to display an authorization page.");
    interactiveFlows.add(extension.id);
    const windowId = service.reservePopupWindowId();
    try {
      const contents = await window.host.openPopupWindow({ windowId, extensionId: extension.id, url: "about:blank", width: null, height: null });
      return await new Promise<string>((resolve, reject) => {
        let done = false;
        const finish = (result: { url?: string; error?: string }) => {
          if (done) return;
          done = true;
          window.host.closePopupWindow(windowId);
          if (result.url) resolve(result.url);
          else reject(new Error(result.error ?? USER_REJECTED));
        };
        watchForRedirect(contents, redirectPrefix(extension), finish);
        contents.once("destroyed", () => finish({ error: USER_REJECTED }));
        const unload = service.onUnload((id) => {
          if (id === extension.id) finish({ error: USER_REJECTED });
        });
        contents.once("destroyed", unload);
        void contents.loadURL(url).catch(() => {});
      });
    } finally {
      interactiveFlows.delete(extension.id);
    }
  };

  const silentFlow = (extension: LoadedExtension, url: string, details: WebAuthFlowDetails) =>
    new Promise<string>((resolve, reject) => {
      const hidden = new BrowserWindow({ show: false, webPreferences: { session: service.session, offscreen: true, sandbox: true } });
      const contents = hidden.webContents;
      let done = false;
      const abortOnLoad = details.abortOnLoadForNonInteractive ?? true;
      const timeout = Math.max(0, Math.min(details.timeoutMsForNonInteractive ?? NON_INTERACTIVE_MAX_MS, NON_INTERACTIVE_MAX_MS));
      const timer = setTimeout(() => finish({ error: abortOnLoad ? PAGE_LOAD_TIMED_OUT : INTERACTION_REQUIRED }), timeout);
      const finish = (result: { url?: string; error?: string }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (!hidden.isDestroyed()) hidden.destroy();
        if (result.url) resolve(result.url);
        else reject(new Error(result.error ?? INTERACTION_REQUIRED));
      };
      watchForRedirect(contents, redirectPrefix(extension), finish);
      contents.on("did-finish-load", () => {
        if (abortOnLoad) finish({ error: INTERACTION_REQUIRED });
      });
      void contents.loadURL(url).catch(() => {});
    });

  router.handle(
    "identity.launchWebAuthFlow",
    async (caller, value) => {
      const details = (value ?? {}) as WebAuthFlowDetails;
      let url: URL;
      try {
        url = new URL(String(details.url));
      } catch {
        throw new Error("The auth url has an invalid scheme. Only http:// and https:// schemes are allowed.");
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("The auth url has an invalid scheme. Only http:// and https:// schemes are allowed.");
      }
      if (details.interactive) return interactiveFlow(caller, url.href);
      return silentFlow(caller.extension, url.href, details);
    },
    { permission },
  );

  // Chrome sign-in doesn't exist in terminal-browser, so these answer like a
  // signed-out Chrome.
  router.handle(
    "identity.getAuthToken",
    (caller, value) => {
      const oauth2 = (caller.extension.manifest as { oauth2?: { client_id?: string; scopes?: string[] } }).oauth2;
      if (!oauth2?.client_id) throw new Error("Invalid OAuth2 Client ID.");
      const scopes = (value as { scopes?: string[] } | undefined)?.scopes ?? oauth2.scopes ?? [];
      if (scopes.length === 0) throw new Error("Invalid OAuth2 scopes.");
      throw new Error("The user is not signed in.");
    },
    { permission },
  );
  router.handle("identity.getProfileUserInfo", () => ({ email: "", id: "" }), { permission });
  router.handle("identity.getAccounts", () => [], { permission });
  router.handle("identity.removeCachedAuthToken", () => undefined, { permission });
  router.handle("identity.clearAllCachedAuthTokens", () => undefined, { permission });
}
