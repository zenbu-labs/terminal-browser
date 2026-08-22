const Module = require("node:module");

/**
 * The browser sources import electron and the native/sqlite packages at module load, and none of
 * those exist under `node --test`. One interceptor for the whole suite, so the swap is written
 * down once instead of once per test file.
 */
const stubs = new Map();

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (stubs.has(request)) return stubs.get(request);
  return realLoad.call(this, request, parent, isMain);
};

/** Must be called before the module under test is required. */
function stubModule(request, exports) {
  stubs.set(request, exports);
  return exports;
}

module.exports = { stubModule };
