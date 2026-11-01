const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");

const cleared = [];
const VICTIM = "b".repeat(32);
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return {};
  if (request === "shared") return { listExtensions: () => [{ id: VICTIM }] };
  if (request === "../../browsing") return { browsing: () => ({ history: {}, downloads: { list: () => [] } }) };
  if (request === "../../session/browsing-data") return { clearBrowsingData: async () => {} };
  if (request === "../native") return { clearSessionData: async (_session, options) => cleared.push(options) };
  return load.call(this, request, ...rest);
};

const { installBrowsingData } = require("../dist/extensions/api/browsingData.js");

const handlers = new Map();
installBrowsingData({ session: {}, router: { handle: (name, run) => handlers.set(name, run) } });
const remove = (options, types) => handlers.get("browsingData.remove")({ kind: "worker" }, options, types);
const STORAGE = { localStorage: true, indexedDB: true, serviceWorkers: true, cacheStorage: true };

test("an origins list can't reach another extension's storage unless originTypes.extension is set, like Chrome", async () => {
  cleared.length = 0;
  await remove({ origins: [`chrome-extension://${VICTIM}`] }, STORAGE);
  assert.deepEqual(cleared, []);
  await remove({ origins: [`chrome-extension://${VICTIM}`, "https://a.test"] }, STORAGE);
  assert.ok(cleared.length > 0);
  for (const options of cleared) assert.deepEqual(options.origins, ["https://a.test"]);
  cleared.length = 0;
  await remove({ origins: [`chrome-extension://${VICTIM}`], originTypes: { extension: true } }, STORAGE);
  assert.ok(cleared.every((options) => options.origins[0] === `chrome-extension://${VICTIM}`));
  assert.ok(cleared.length > 0);
});

test("another extension's origin is kept whatever its spelling, since Chromium reads them all as the same origin", async () => {
  for (const spelling of [
    `CHROME-EXTENSION://${VICTIM}/`,
    `Chrome-Extension://${VICTIM.toUpperCase()}`,
    `chrome-extension:\\\\${VICTIM}`,
    `chrome-extension:${VICTIM}`,
    ` chrome-extension://${VICTIM}`,
    `filesystem:chrome-extension://${VICTIM}/temporary/`,
    `blob:CHROME-EXTENSION://${VICTIM}/0b4d`,
  ]) {
    cleared.length = 0;
    await remove({ origins: [spelling] }, STORAGE);
    assert.deepEqual(cleared, [], spelling);
    await remove({ origins: [spelling, "HTTPS://A.test/page"] }, STORAGE);
    assert.ok(cleared.length > 0, spelling);
    for (const options of cleared) assert.deepEqual(options.origins, ["https://a.test"], spelling);
  }
});

test("origins reach Electron as canonical origins, and an invalid one gets Chrome's error", async () => {
  cleared.length = 0;
  await remove({ excludeOrigins: ["HTTPS://Keep.Test/x"] }, STORAGE);
  assert.ok(cleared.length > 0);
  for (const options of cleared) assert.deepEqual(options.excludeOrigins, ["https://keep.test", `chrome-extension://${VICTIM}`]);
  cleared.length = 0;
  await assert.rejects(remove({ origins: ["foo"] }, STORAGE), { message: "'foo' is not a valid origin." });
  await assert.rejects(remove({ excludeOrigins: ["data:text/plain,x"] }, STORAGE), { message: "'data:text/plain,x' is not a valid origin." });
  assert.deepEqual(cleared, []);
});
