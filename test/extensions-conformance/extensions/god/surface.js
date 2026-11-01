// Lists every namespace, method, event and property reachable from chrome.*.
const SKIP = new Set(["constructor", "__proto__", "prototype", "caller", "arguments", "length", "name", "toString"]);

function keysOf(obj) {
  const keys = new Set();
  for (let o = obj; o && o !== Object.prototype && o !== Function.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) if (!SKIP.has(k)) keys.add(k);
  }
  return [...keys];
}

function isEvent(v) {
  return v && typeof v === "object" && typeof v.addListener === "function" && typeof v.hasListener === "function";
}

function isEnum(v) {
  const values = Object.values(v);
  return values.length > 0 && values.every((x) => typeof x === "string" || typeof x === "number");
}

function surface(root = globalThis.chrome, prefix = "", out = {}, depth = 0) {
  if (!root || depth > 3) return out;
  for (const key of keysOf(root).sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    let value;
    try {
      value = root[key];
    } catch (error) {
      out[path] = "throws";
      continue;
    }
    if (typeof value === "function") {
      out[path] = /^[A-Z]/.test(key) ? "class" : "method";
    } else if (isEvent(value)) {
      out[path] = "event";
    } else if (value && typeof value === "object") {
      if (depth > 0 && isEnum(value)) {
        out[path] = "enum";
      } else {
        out[path] = depth === 0 ? "namespace" : "object";
        surface(value, path, out, depth + 1);
      }
    } else if (value !== undefined) {
      out[path] = `property:${typeof value}`;
    }
  }
  return out;
}

globalThis.godSurface = surface;
