// The privileged calls each terminal-browser:// page may make. A page only
// gets the methods listed under its own host.
export const INTERNAL_API = {
  start: ["data"],
  newtab: ["data"],
  history: ["list", "remove", "open"],
  downloads: ["list", "open", "show", "cancel", "pause", "resume", "remove", "clear", "openUrl"],
  bookmarks: ["tree", "add", "addFolder", "remove", "open"],
  settings: ["get", "set", "reset", "clearData"],
} as const satisfies Record<string, readonly string[]>;

export type InternalHost = keyof typeof INTERNAL_API;

export const INTERNAL_CHANGED_CHANNEL = "tb-internal:changed";

export function internalChannel(host: string, method: string): string {
  return `tb-internal:${host}.${method}`;
}

export function isInternalHost(host: string): host is InternalHost {
  return Object.prototype.hasOwnProperty.call(INTERNAL_API, host);
}
