// Commands a client of the relay may not send. Each would let a web page get a CDP
// connection of its own, open a network listener, or get permissions the user never
// gave it; the last group would carry commands past these checks.
const DENIED = new Set([
  "Target.exposeDevToolsProtocol",
  "Target.setRemoteLocations",
  "Tethering.bind",
  "Browser.grantPermissions",
  "Browser.setPermission",
  "Target.sendMessageToTarget",
]);

// Only flat sessions, whose commands and events each pass through the relay as their own message.
const ATTACHING = new Set(["Target.attachToTarget", "Target.setAutoAttach", "Target.autoAttachRelated"]);

// fixme: placeholder copy
const REFUSED = "not available through terminal-browser's CDP socket";

// Why `method` with `params` is refused, or null when it may go to the browser.
export function refusal(method: string, params: Record<string, unknown> | undefined): string | null {
  if (DENIED.has(method)) return `${method} is ${REFUSED}`;
  // fixme: placeholder copy
  if (ATTACHING.has(method) && params?.flatten !== true) return `${method} needs flatten: true through terminal-browser's CDP socket`;
  return null;
}

const SECRET_HEADERS = new Set(["proxy-authorization"]);

function withoutSecretHeaders(headers: unknown): unknown {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return headers;
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !SECRET_HEADERS.has(name.toLowerCase())));
}

function withoutSecretLines(text: unknown): unknown {
  return typeof text === "string" ? text.replace(/^proxy-authorization:.*\r?\n/gim, "") : text;
}

// The --ssh proxy's password rides on every proxied request; CDP clients never see it.
export function scrubEvent<T extends { method?: string; params?: Record<string, unknown> }>(message: T): T {
  const method = message.method;
  if (!method || !(method.startsWith("Network.") || method.startsWith("Fetch.")) || !message.params) return message;
  const params = { ...message.params };
  if ("headers" in params) params.headers = withoutSecretHeaders(params.headers);
  for (const key of ["request", "response", "redirectResponse"]) {
    const nested = params[key];
    if (!nested || typeof nested !== "object") continue;
    const copy = { ...(nested as Record<string, unknown>) };
    for (const field of ["headers", "requestHeaders"]) if (field in copy) copy[field] = withoutSecretHeaders(copy[field]);
    if ("requestHeadersText" in copy) copy.requestHeadersText = withoutSecretLines(copy.requestHeadersText);
    params[key] = copy;
  }
  return { ...message, params };
}
