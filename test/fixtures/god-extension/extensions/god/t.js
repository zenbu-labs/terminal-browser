// Tiny test runner shared by every context of the God extension. Each test
// returns a short "signature" describing what it observed; the harness compares
// signatures between Chrome and terminal-browser.
(() => {
  const g = globalThis;
  if (g.god) return;
  const tests = [];
  const results = [];
  g.godJson = (value) => JSON.stringify(value, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
  const listeners = new Set();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class AssertionError extends Error {}

  function fail(message) {
    throw new AssertionError(message);
  }

  const sorted = (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);

  function describe(value) {
    try {
      return JSON.stringify(value, sorted)?.slice(0, 200);
    } catch {
      return String(value);
    }
  }

  function typeOf(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
  }

  function errorText(error) {
    return String(error?.message ?? error).slice(0, 240);
  }

  const t = {
    sleep,
    fail,
    ok(cond, message = "expected truthy") {
      if (!cond) fail(message);
    },
    eq(actual, expected, message = "") {
      const a = describe(actual), e = describe(expected);
      if (a !== e) fail(`${message ? message + ": " : ""}expected ${e}, got ${a}`);
    },
    type(value, expected, message = "") {
      const actual = typeOf(value);
      if (actual !== expected) fail(`${message ? message + ": " : ""}expected ${expected}, got ${actual} ${describe(value)}`);
    },
    // Checks that `value` has each key with the given type ("string?" = optional).
    shape(value, spec, message = "") {
      if (typeOf(value) !== "object") fail(`${message} expected object, got ${typeOf(value)} ${describe(value)}`);
      for (const [key, want] of Object.entries(spec)) {
        const optional = want.endsWith("?");
        const type = want.replace(/\?$/, "");
        if (!(key in value) || value[key] === undefined) {
          if (!optional) fail(`${message} missing ${key} in ${describe(value)}`);
          continue;
        }
        const actual = typeOf(value[key]);
        if (type !== "any" && !type.split("|").includes(actual)) fail(`${message} ${key}: expected ${type}, got ${actual} ${describe(value[key])}`);
      }
      return Object.keys(spec).filter((k) => !spec[k].endsWith("?")).join(",");
    },
    async rejects(fnOrPromise, pattern, message = "") {
      try {
        await (typeof fnOrPromise === "function" ? fnOrPromise() : fnOrPromise);
      } catch (error) {
        const text = errorText(error);
        if (pattern && !pattern.test(text)) fail(`${message} rejected with unexpected error: ${text}`);
        return `rejects: ${text}`;
      }
      fail(`${message} expected rejection`);
    },
    // Resolves with the listener args of the first matching event fired while/after `trigger` runs.
    event(evt, trigger, { filter = () => true, timeout = 6000, extra } = {}) {
      if (!evt || typeof evt.addListener !== "function") fail("event missing");
      let triggered = Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          evt.removeListener(listener);
          reject(new AssertionError("event did not fire"));
        }, timeout);
        function listener(...args) {
          if (!filter(...args)) return;
          clearTimeout(timer);
          evt.removeListener(listener);
          resolve(args);
        }
        if (extra === undefined) evt.addListener(listener);
        else evt.addListener(listener, ...extra);
        triggered = Promise.resolve()
          .then(() => trigger?.())
          .catch((error) => {
            clearTimeout(timer);
            evt.removeListener(listener);
            reject(error);
          });
      }).then(async (args) => {
        await triggered;
        return args;
      });
    },
    // Describes how a call settled, for calls whose outcome Chrome defines rather than the docs.
    async outcome(fnOrPromise, timeout = 8000) {
      try {
        const value = await Promise.race([typeof fnOrPromise === "function" ? fnOrPromise() : fnOrPromise, sleep(timeout).then(() => "__pending")]);
        if (value === "__pending") return "pending";
        return `resolved: ${describe(value) ?? "undefined"}`;
      } catch (error) {
        return `rejects: ${errorText(error)}`;
      }
    },
    async noEvent(evt, trigger, ms = 1500) {
      let fired = null;
      const listener = (...args) => (fired = args);
      evt.addListener(listener);
      try {
        await trigger?.();
        await sleep(ms);
      } finally {
        evt.removeListener(listener);
      }
      if (fired) fail(`event fired unexpectedly: ${describe(fired)}`);
      return "no event";
    },
    // Calls a callback-style API and returns { value, lastError }.
    callback(fn) {
      return new Promise((resolve) => {
        fn((value) => resolve({ value, lastError: chrome.runtime.lastError?.message ?? null }));
      });
    },
    exists(path) {
      let o = globalThis;
      for (const part of path.split(".")) {
        if (o == null) return false;
        o = o[part];
      }
      return o !== undefined;
    },
    keys(obj) {
      return Object.keys(obj ?? {}).sort().join(",");
    },
  };

  async function runOne(test, ctx, config) {
    const started = Date.now();
    const crasher = config?.crashers?.find(([pattern]) => new RegExp(pattern).test(test.id));
    if (crasher) {
      const result = { id: test.id, ctx, ok: false, sig: `${crasher[2] ?? "crashes"}: ${crasher[1]}`, note: `not run: ${crasher[1]}`, ms: 0 };
      results.push(result);
      for (const l of listeners) l(result);
      return result;
    }
    let ok = true, sig = "ok", note = "";
    try {
      const value = await Promise.race([
        test.fn(t, config),
        sleep(test.timeout ?? 10000).then(() => {
          throw new AssertionError("timeout");
        }),
      ]);
      if (value !== undefined) sig = typeof value === "string" ? value : describe(value);
    } catch (error) {
      ok = false;
      note = errorText(error);
      sig = error instanceof AssertionError ? `assert: ${note}` : `throws: ${note}`;
    }
    const result = { id: test.id, ctx, ok, sig: String(sig).slice(0, 300), note, ms: Date.now() - started };
    results.push(result);
    for (const l of listeners) l(result);
    return result;
  }

  g.god = {
    t,
    tests,
    results,
    config: null,
    done: false,
    onResult(listener) {
      listeners.add(listener);
    },
    // ctx: which context this is ("sw", "page", "cs", ...). opts.ctx on a test lists where it runs.
    test(id, fn, opts = {}) {
      tests.push({ id, fn, ...opts, ctx: opts.ctx ?? ["sw"] });
    },
    async run(ctx, config, { only } = {}) {
      g.god.config = config;
      g.god.done = false;
      for (const test of tests) {
        if (!test.ctx.includes(ctx)) continue;
        if (only && !only.test(test.id)) continue;
        await runOne(test, ctx, config);
      }
      g.god.done = true;
      return results;
    },
  };
})();
