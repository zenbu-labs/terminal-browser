"""Writes src/extensions/api-schemas.ts: the argument signatures of the chrome.*
methods terminal-browser implements itself (API_SPEC), taken from Chromium's
own extension API schemas so calls are validated exactly like in Chrome.

usage (after building browser/): python3 scripts/extension-schemas.py <chromium src>
"""
import glob
import json
import os
import subprocess
import sys

SRC = sys.argv[1]
BROWSER = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BROWSER, "src/extensions/api-schemas.ts")
sys.path.insert(0, os.path.join(SRC, "tools/json_schema_compiler"))
sys.path.insert(0, os.path.join(SRC, "third_party"))
from schema_loader import SchemaLoader  # noqa: E402

DIRS = ["chrome/common/extensions/api", "extensions/common/api"]
loader = SchemaLoader(SRC)
namespaces = {}
for d in DIRS:
    for path in sorted(glob.glob(os.path.join(SRC, d, "*"))):
        if not path.endswith((".json", ".idl", ".webidl")) or os.path.basename(path).startswith("_"):
            continue
        try:
            for ns in loader.LoadSchema(os.path.relpath(path, SRC)):
                if isinstance(ns, dict) and "namespace" in ns:
                    namespaces.setdefault(ns["namespace"], ns)
        except Exception as error:  # some schema files aren't API namespaces
            print("skip", path, error, file=sys.stderr)

protocol = os.path.join(BROWSER, "dist/extensions/protocol.js")
spec = json.loads(subprocess.check_output(
    ["node", "-e", "process.stdout.write(JSON.stringify(require(process.argv[1]).API_SPEC))", protocol]))
KEEP = ["type", "$ref", "choices", "properties", "additionalProperties", "ignoreAdditionalProperties", "items",
        "enum", "optional", "name", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems",
        "isInstanceOf", "preserveNull"]

types = {}
pending = []


def qualify(ref, ns):
    return ref if "." in ref else "%s.%s" % (ns, ref)


def clean(node, ns):
    if isinstance(node, list):
        return [clean(item, ns) for item in node]
    if not isinstance(node, dict):
        return node
    out = {}
    for key in KEEP:
        if key not in node:
            continue
        value = node[key]
        if key == "$ref":
            value = qualify(value, ns)
            pending.append(value)
        elif key == "enum":
            value = [e if isinstance(e, str) else e["name"] for e in value]
        elif key == "properties":
            value = {k: clean(v, ns) for k, v in value.items()}
        elif key in ("choices",):
            value = [clean(v, ns) for v in value]
        elif key in ("items", "additionalProperties"):
            value = clean(value, ns)
        out[key] = value
    if node.get("type") == "function" and "type" not in out:
        out["type"] = "function"
    return out


def signature(fn, ns):
    params = [clean(p, ns) for p in fn.get("parameters", [])]
    returns_async = fn.get("returns_async")
    if returns_async is not None:
        supports_promises = "does_not_support_promises" not in returns_async
        params.append({"type": "function", "name": "callback",
                       "optional": True if supports_promises else bool(returns_async.get("optional", False))})
    return params


# Events with rules (declarativeContent.onPageChanged) are flattened into namespace methods in API_SPEC.
# Chromium checks them with events.Event's signatures, minus the event name and webview id it fills in,
# and a Rule whose conditions and actions are the event's own types (declarative_event.cc).
RULE_METHODS = ("addRules", "getRules", "removeRules")
EVENT_FUNCTIONS = {fn["name"]: fn for fn in next(t for t in namespaces["events"]["types"] if t["id"] == "Event")["functions"]}


def rule_signature(method, event, ns):
    params = signature(dict(EVENT_FUNCTIONS[method], parameters=EVENT_FUNCTIONS[method]["parameters"][2:]), "events")
    if method != "addRules":
        return params
    rule = "%s.%s.Rule" % (ns, event["name"])
    choices = lambda refs: {"choices": [{"$ref": ref} for ref in refs]}
    types[rule] = {"type": "object", "properties": {
        "id": {"type": "string", "optional": True},
        "tags": {"type": "array", "items": {"type": "string"}, "optional": True},
        "conditions": {"type": "array", "items": choices(event["options"]["conditions"])},
        "actions": {"type": "array", "items": choices(event["options"]["actions"])},
        "priority": {"type": "integer", "optional": True},
    }}
    pending.extend(event["options"]["conditions"] + event["options"]["actions"])
    params[0] = {"name": "rules", "type": "array", "items": {"$ref": rule}}
    return params


functions = {}
for name, api in spec.items():
    ns = namespaces.get(name)
    if not ns:
        print("no schema for", name, file=sys.stderr)
        continue
    by_name = {fn["name"]: fn for fn in ns.get("functions", [])}
    # Methods of a type's objects (contentSettings.javascript.get is contentSettings.ContentSetting.get).
    on_types = {fn["name"]: (t["id"], fn) for t in ns.get("types", []) for fn in t.get("functions", [])}
    for prop in ns.get("properties", {}).values():
        values = prop.get("value") if isinstance(prop.get("value"), list) else []
        pending.extend(qualify(item["$ref"], name) for item in values if isinstance(item, dict) and "$ref" in item)
    rule_events = [e for e in ns.get("events", []) if e.get("options", {}).get("supportsRules")]
    for method in api["methods"]:
        fn = by_name.get(method)
        if fn is None and "." in method:
            type_name, type_method = method.split(".", 1)
            owner = next((t for t in ns.get("types", []) if t.get("id") == type_name), {})
            fn = next((f for f in owner.get("functions", []) if f["name"] == type_method), None)
        if fn is None and rule_events and method in RULE_METHODS:
            functions["%s.%s" % (name, method)] = rule_signature(method, rule_events[0], name)
            continue
        if fn is None and method in on_types:
            type_id, type_fn = on_types[method]
            functions["%s.%s.%s" % (name, type_id, method)] = signature(type_fn, name)
            continue
        if fn is None:
            print("no schema for %s.%s" % (name, method), file=sys.stderr)
            continue
        functions["%s.%s" % (name, method)] = signature(fn, name)

while pending:
    ref = pending.pop()
    if ref in types:
        continue
    ns_name, type_name = ref.rsplit(".", 1)
    ns = namespaces.get(ns_name)
    found = next((t for t in (ns or {}).get("types", []) if t.get("id") == type_name), None)
    if found is None:
        print("unresolved ref", ref, file=sys.stderr)
        types[ref] = {"type": "any"}
        continue
    types[ref] = clean(found, ns_name)

HEADER = """// Generated by scripts/extension-schemas.py from Chromium's extension API
// schemas; regenerate instead of editing.
import type { ApiSchemas } from "./validate";

export const API_SCHEMAS: ApiSchemas = """
with open(OUT, "w") as out:
    out.write(HEADER)
    out.write(json.dumps({"functions": functions, "types": types}, indent=2, sort_keys=True))
    out.write(";\n")
print("functions", len(functions), "types", len(types), file=sys.stderr)
