// declarativeNetRequest static rulesets across unpacked reloads of the same version (patch 0009): a ruleset enabled
// at runtime picks up edits to its JSON, and rulesets removed from the manifest leave nothing behind in the prefs.
const fs = require("node:fs");
const path = require("node:path");

const rule = (id, path) => [{ id, priority: 1, action: { type: "block" }, condition: { urlFilter: path, resourceTypes: ["xmlhttprequest"] } }];
const ruleset = (id) => ({ id, enabled: id === "r1", path: `${id}.json` });

function manifest(rulesets) {
  return {
    manifest_version: 3,
    name: "dnr",
    version: "1",
    permissions: ["declarativeNetRequest", "declarativeNetRequestFeedback"],
    background: { service_worker: "sw.js" },
    declarative_net_request: { rule_resources: rulesets.map(ruleset) },
  };
}

const sw = `importScripts("report.js", "config.js");
  const matches = async (url) =>
    (await chrome.declarativeNetRequest.testMatchOutcome({ url, type: "xmlhttprequest" })).matchedRules.map((r) => r.rulesetId);
  (async () => {
    if (self.step === "enable") await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ["r2", "r3"] });
    const enabled = (await chrome.declarativeNetRequest.getEnabledRulesets()).sort();
    const out = { enabled };
    for (const p of ["/b-old", "/b-new", "/c"]) out[p] = await matches("http://example.com" + p);
    report(self.step, out);
  })();`;

require("./harness.cjs").run("dnr-reload", async ({ ses, port, phase, waitReport, writeExtension, eq, check }) => {
  if (phase === 2) {
    const prefs = JSON.parse(fs.readFileSync(path.join(process.env.PROBE_PROFILE, "Preferences"), "utf8"));
    const settings = Object.values(prefs.extensions?.settings ?? {}).find((s) => s.dnr_static_ruleset);
    check(settings, "no dnr_static_ruleset pref was written");
    eq(Object.keys(settings?.dnr_static_ruleset ?? {}).sort(), ["1", "2"], "ruleset checksums kept in the prefs");
    eq([...(settings?.dnr_enabled_ruleset_ids ?? [])].sort(), [1, 2], "runtime-enabled ruleset ids kept in the prefs");
    return;
  }
  const write = (step, rulesets, r2Path) =>
    writeExtension("dnr", port, {
      "manifest.json": manifest(rulesets),
      "sw.js": sw,
      "config.js": `self.step = ${JSON.stringify(step)};`,
      "r1.json": rule(1, "/a"),
      "r2.json": rule(2, r2Path),
      "r3.json": rule(3, "/c"),
    });
  const reload = async (dir) => {
    for (const e of ses.extensions.getAllExtensions()) ses.extensions.removeExtension(e.id);
    return ses.extensions.loadExtension(dir);
  };

  await reload(write("enable", ["r1", "r2", "r3"], "/b-old"));
  eq(await waitReport("enable"), { enabled: ["r1", "r2", "r3"], "/b-old": ["r2"], "/b-new": [], "/c": ["r3"] }, "after enabling r2 and r3");

  await reload(write("edited", ["r1", "r2", "r3"], "/b-new"));
  eq(await waitReport("edited"), { enabled: ["r1", "r2", "r3"], "/b-old": [], "/b-new": ["r2"], "/c": ["r3"] }, "after editing r2.json and reloading");

  await reload(write("removed", ["r1", "r2"], "/b-new"));
  eq(await waitReport("removed"), { enabled: ["r1", "r2"], "/b-old": [], "/b-new": ["r2"], "/c": [] }, "after removing r3 and reloading");
  return "next";
});
