const errorEl = document.getElementById("error");
const quitEl = document.getElementById("quit");
const windowId = new URLSearchParams(location.search).get("window");
let focusBeforeQuit = null;

function report(stage, detail) {
  fetch(`/window/${windowId}/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stage, detail: detail ?? "" }),
  }).catch(() => {});
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function askToQuit() {
  if (!quitEl.hidden) return;
  focusBeforeQuit = document.activeElement;
  quitEl.hidden = false;
  document.getElementById("quit-confirm").focus();
}

function closeQuitPrompt() {
  quitEl.hidden = true;
  focusBeforeQuit?.focus();
}

function confirmQuit() {
  quitEl.hidden = true;
  report("stopped", "quit");
}

document.getElementById("quit-confirm").addEventListener("click", confirmQuit);
document.getElementById("quit-cancel").addEventListener("click", closeQuitPrompt);
window.addEventListener(
  "keydown",
  (event) => {
    if (quitEl.hidden) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === "Enter") confirmQuit();
    else if (event.key === "Escape" || (event.ctrlKey && event.key === "c")) closeQuitPrompt();
  },
  true,
);

async function fetchConnect() {
  const response = await fetch(`/window/${windowId}/connect`, { cache: "no-store" });
  if (!response.ok) throw { code: "stopped", message: `connect: HTTP ${response.status}` };
  return response.json();
}

const host = {
  bootProgress(stage, detail) {
    if (stage === "stopped" && detail === "quit") return askToQuit();
    if (stage === "ready") {
      errorEl.hidden = true;
      report(stage, detail);
    } else if (stage === "stopped" || stage === "failed") {
      showError(`${stage}: ${detail}`);
      report(stage, detail);
    }
  },
  async refreshConnectInfo() {
    return (await fetchConnect()).connect;
  },
  async saveDocument(kind, json) {
    const response = await fetch(`/config/${kind}`, { method: "PUT", body: json });
    if (!response.ok) throw new Error(`saving ${kind}: HTTP ${response.status}`);
  },
  reportError(kind, message, stack) {
    console.error("[zed]", kind, message, stack);
  },
  onLifecycle() {},
  updateAction() {},
  async downloadProject() {
    throw new Error("project download is not supported here");
  },
  async connectDebugAdapter() {
    throw new Error("debugging is not supported here");
  },
  async connectKernel() {
    throw new Error("notebook kernels are not supported here");
  },
};

async function main() {
  const info = await fetchConnect();
  const base = new URL(`/editor/${info.buildId}/`, location.href);
  globalThis.__zsBindgenShimUrl = new URL("zed_web.js", base).href;

  const [module, assets] = await Promise.all([
    import(new URL("zed_web.js", base).href),
    fetch(new URL("zed-assets.tar", base)).then(async (response) => {
      if (!response.ok) throw new Error(`zed-assets.tar: HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    }),
  ]);
  const { default: init, start, flush_client_state, set_hidden } = module;
  const wasm = await init({ module_or_path: new URL("zed_web_bg.wasm", base) });
  if (typeof globalThis.__zsCallCtors === "function") globalThis.__zsCallCtors();
  else if (typeof wasm.__wasm_call_ctors === "function") wasm.__wasm_call_ctors();

  document.addEventListener("visibilitychange", () => {
    set_hidden(document.hidden);
    if (document.hidden) flush_client_state().catch(() => {});
  });
  window.addEventListener("pagehide", () => flush_client_state().catch(() => {}));

  const hostOs = navigator.platform.startsWith("Mac") ? "mac" : "linux";
  await start(JSON.stringify({ ...info, backend: "auto", hostOs }), assets, host);
}

main().catch((error) => {
  const message = error?.code ? `${error.code}: ${error.message}` : String(error?.message ?? error);
  showError(message);
  report("failed", message);
});
