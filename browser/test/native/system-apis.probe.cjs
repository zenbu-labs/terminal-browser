// system.storage (patch 0022), system.display (0023) and ChromeOS-only permissions (0019) work, or fail like Chrome,
// without taking the browser down.
require("./harness.cjs").run("system-apis", async ({ ses, port, waitReport, writeExtension, eq }) => {
  const dir = writeExtension("system", port, {
    "manifest.json": {
      manifest_version: 3,
      name: "system",
      version: "1",
      permissions: ["system.storage", "system.display", "loginState", "printing", "printingMetrics"],
      background: { service_worker: "sw.js" },
    },
    "sw.js": `importScripts("report.js");
      const outcome = (p) => p.then((v) => ({ ok: v }), (e) => ({ error: e.message }));
      (async () => {
        const storage = await outcome(chrome.system.storage.getInfo());
        const capacity = await outcome(chrome.system.storage.getAvailableCapacity("not-a-device"));
        const eject = await outcome(chrome.system.storage.ejectDevice("not-a-device"));
        const displays = await outcome(chrome.system.display.getInfo());
        const layout = await outcome(chrome.system.display.getDisplayLayout());
        report("system", {
          storage: Array.isArray(storage.ok),
          capacity,
          eject,
          displays: Array.isArray(displays.ok) && displays.ok.length > 0 && typeof displays.ok[0].bounds,
          layout,
          loginState: typeof chrome.loginState,
        });
      })();`,
  });
  await ses.extensions.loadExtension(dir);
  const result = await waitReport("system");
  eq(result, {
    storage: true,
    capacity: { error: "Error occurred when querying available capacity." },
    eject: { ok: "no_such_device" },
    displays: "object",
    layout: { error: "Function available only on ChromeOS." },
    loginState: "undefined",
  }, "system APIs");
});
