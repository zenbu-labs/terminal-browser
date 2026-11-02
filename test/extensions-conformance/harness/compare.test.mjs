import assert from "node:assert/strict";
import test from "node:test";
import { compareRun } from "./compare.mjs";
import { buildReference, normalize } from "./reference.mjs";

const run = (results, surfaces = {}) => ({ results, surfaces: { sw: { x: "method" }, page: { x: "method" }, cs: { x: "method" }, ...surfaces }, extras: {} });
const reference = buildReference([run([
  { id: "tabs.get", ctx: "sw", ok: true, sig: `{"tabId":1834567890}` },
  { id: "tts.speak", ctx: "sw", ok: true, sig: "ok" },
  { id: "gating.tabs.query-scrubbed", ctx: "noperm", ok: true, sig: "scrubbed" },
  { id: "alarms.create", ctx: "sw", ok: true, sig: "ok" },
], { sw: { "alarms.create": "function" } })], "156");

const keys = (list) => list.map((r) => r.key).sort();

test("volatile ids and ports normalize away", () => {
  assert.equal(normalize(`{"tabId":3} chrome-extension://hgiikgalddcijbhlkbmbemmpbohkocaj/x localhost:51234`), `{"tabId":N} EXT/x localhost:PORT`);
});

test("a run matching Chrome has no regressions", () => {
  const tb = run([
    { id: "tabs.get", ctx: "sw", ok: true, sig: `{"tabId":7}` },
    { id: "tts.speak", ctx: "sw", ok: true, sig: "ok" },
    { id: "gating.tabs.query-scrubbed", ctx: "noperm", ok: true, sig: "scrubbed" },
    { id: "alarms.create", ctx: "sw", ok: true, sig: "ok" },
  ], { sw: { "alarms.create": "function" } });
  const result = compareRun({ reference, tb, expectations: {} });
  assert.deepEqual(result.regressions, []);
});

test("differences, missing checks, missing members and crashes are regressions", () => {
  const tb = run([{ id: "tabs.get", ctx: "sw", ok: true, sig: "other" }], { sw: {} });
  tb.extras.crash = "Received signal 11 SEGV";
  const result = compareRun({ reference, tb, expectations: {} });
  assert.deepEqual(keys(result.regressions), ["harness|browser.crash", "noperm|gating.tabs.query-scrubbed", "surface:sw|alarms.create", "sw|alarms.create", "sw|tabs.get", "sw|tts.speak"]);
});

test("expectations cover unsupported namespaces but never security checks", () => {
  const tb = run([
    { id: "tabs.get", ctx: "sw", ok: true, sig: `{"tabId":7}` },
    { id: "tts.speak", ctx: "sw", ok: false, sig: "throws: chrome.tts is undefined" },
    { id: "gating.tabs.query-scrubbed", ctx: "noperm", ok: false, sig: "leaked" },
    { id: "alarms.create", ctx: "sw", ok: true, sig: "ok" },
  ], { sw: { "alarms.create": "function" } });
  const expectations = { unsupported: { tts: "no speech engine", gating: "not allowed" } };
  const result = compareRun({ reference, tb, expectations });
  assert.deepEqual(keys(result.regressions), ["noperm|gating.tabs.query-scrubbed"]);
});

test("known differences that pass again are reported as stale", () => {
  const tb = run([
    { id: "tabs.get", ctx: "sw", ok: true, sig: `{"tabId":7}` },
    { id: "tts.speak", ctx: "sw", ok: true, sig: "ok" },
    { id: "gating.tabs.query-scrubbed", ctx: "noperm", ok: true, sig: "scrubbed" },
    { id: "alarms.create", ctx: "sw", ok: true, sig: "ok" },
  ], { sw: { "alarms.create": "function" } });
  const result = compareRun({ reference, tb, expectations: { knownDiffers: { "sw|tabs.get": "bug" } } });
  assert.deepEqual(result.stale, ["sw|tabs.get"]);
});

test("Chrome's slow runs don't loosen the reference", () => {
  const ref = buildReference([run([{ id: "a", ctx: "sw", ok: false, sig: "assert: timeout" }, { id: "b", ctx: "sw", ok: true, sig: "pending" }]), run([{ id: "a", ctx: "sw", ok: true, sig: "number" }, { id: "b", ctx: "sw", ok: true, sig: "resolved: undefined" }])], "156");
  assert.deepEqual(ref.checks["sw|a"], [{ ok: true, sig: "number" }]);
  assert.deepEqual(ref.checks["sw|b"], [{ ok: true, sig: "resolved: undefined" }]);
});
