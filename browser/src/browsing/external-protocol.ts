// Chrome's ExternalProtocolHandler: schemes it never hands to another app, and its anti-flood rule, where a page gets
// one request to open another app per user interaction (or typed navigation) and the rest are refused unseen.
const DENIED_SCHEMES = new Set([
  "afp",
  "applescript",
  "data",
  "disk",
  "disks",
  "file",
  "hcp",
  "ie.http",
  "javascript",
  "mk",
  "ms-help",
  "nntp",
  "res",
  "shell",
  "vbscript",
  "view-source",
  "vnd.ms.radio",
]);

let acceptRequests = true;

export function permitExternalLaunch() {
  acceptRequests = true;
}

function schemeOf(url: string): string {
  return /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)?.[1]?.toLowerCase() ?? "";
}

// Whether a request to open `url` in another app may go on to ask the user; each request uses up the interaction.
export function takeExternalLaunch(url: string | null): boolean {
  const scheme = url ? schemeOf(url) : "";
  if (!acceptRequests || scheme.length <= 1 || DENIED_SCHEMES.has(scheme)) return false;
  acceptRequests = false;
  return true;
}

// Chrome's EscapeExternalHandlerValue: what the other app gets can't carry characters a URL may not hold.
export function escapeExternalUrl(url: string): string {
  return url.replace(/[^!#$%&'()*+,\-./0-9:;=?@A-Z[\]_a-z~]/gu, (char) => encodeURIComponent(char));
}

// Chrome's ExternalProtocolObserver: any click, tap or key press in a page counts as an interaction, a scroll doesn't.
export const EXTERNAL_LAUNCH_INPUT = new Set(["mouseDown", "rawKeyDown", "keyDown", "touchStart"]);
