// chrome.proxy.settings (patch 0028): get/set/clear with levelOfControl, onChange, applied to the session's proxy, kept across
// an unpacked reload and withdrawn when the extension is removed.
require("./harness.cjs").run("proxy-settings", async ({ ses, port, waitReport, writeExtension, eq, sleep }) => {
  const dir = writeExtension("proxy", port, {
    "manifest.json": { manifest_version: 3, name: "proxy", version: "1", permissions: ["proxy", "storage"], background: { service_worker: "sw.js" } },
    "sw.js": `importScripts("report.js");
      (async () => {
        if ((await chrome.storage.local.get("ran")).ran) {
          await report("reloaded", (await chrome.proxy.settings.get({})).levelOfControl);
          await new Promise((resolve) => setTimeout(resolve, 1500));
          await chrome.proxy.settings.clear({ scope: "regular" });
          return report("cleared", (await chrome.proxy.settings.get({})).levelOfControl);
        }
        await chrome.storage.local.set({ ran: true });
        const before = await chrome.proxy.settings.get({});
        const changed = new Promise((resolve) => chrome.proxy.settings.onChange.addListener(resolve));
        await chrome.proxy.settings.set({ value: { mode: "fixed_servers", rules: { singleProxy: { host: "127.0.0.1", port: 9 } } }, scope: "regular" });
        const change = await changed;
        const after = await chrome.proxy.settings.get({});
        report("set", { before, change: { mode: change.value.mode, levelOfControl: change.levelOfControl }, after: after.levelOfControl });
      })();`,
  });
  eq(await ses.resolveProxy("http://example.com/"), "DIRECT", "proxy before");
  let extension = await ses.extensions.loadExtension(dir);
  const set = await waitReport("set");
  eq(set.before, { levelOfControl: "controllable_by_this_extension", value: { mode: "system" } }, "get before set");
  eq(set.change, { mode: "fixed_servers", levelOfControl: "controlled_by_this_extension" }, "onChange");
  eq(set.after, "controlled_by_this_extension", "levelOfControl after set");
  eq(await ses.resolveProxy("http://example.com/"), "PROXY 127.0.0.1:9", "proxy after set");

  ses.extensions.removeExtension(extension.id);
  await sleep(300);
  eq(await ses.resolveProxy("http://example.com/"), "DIRECT", "proxy after removal");

  extension = await ses.extensions.loadExtension(dir);
  eq(await waitReport("reloaded"), "controlled_by_this_extension", "levelOfControl after reload");
  eq(await ses.resolveProxy("http://example.com/"), "PROXY 127.0.0.1:9", "proxy after reload");
  eq(await waitReport("cleared"), "controllable_by_this_extension", "levelOfControl after clear");
  eq(await ses.resolveProxy("http://example.com/"), "DIRECT", "proxy after clear");
});
