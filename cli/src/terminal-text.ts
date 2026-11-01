const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[ -/]*[0-~]?)|\x9b[0-?]*[ -/]*[@-~]|[\x9d\x90\x98\x9e\x9f][^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?/g;
const CONTROL = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// Extension names, warnings and errors come from manifests other people wrote,
// so they must not be able to move the cursor, recolour or reorder what we print.
export function terminalSafe(text: string): string {
  return text.replace(ESCAPE_SEQUENCE, "").replace(CONTROL, "");
}

const UNESCAPED_BY_JSON = /[\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// Like JSON.stringify, but also escapes the controls and direction overrides
// it leaves raw, so the output stays lossless and safe to print.
export function terminalSafeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(UNESCAPED_BY_JSON, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
