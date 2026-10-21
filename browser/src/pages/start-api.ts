import { SEARCH_ENGINES, parseSuggestions } from "shared";

export type StartRoute =
  | { kind: "page"; variant: "home" | "dev" }
  | { kind: "data" }
  | { kind: "suggest"; query: string }
  | { kind: "page-css" }
  | { kind: "page-icon" }
  | { kind: "not-found" };

export function startVariant(url: URL): "home" | "dev" {
  return url.host === "dev" ? "dev" : "home";
}

export function routeStartApi(method: string, url: URL): StartRoute {
  const pathname = url.pathname === "" ? "/" : url.pathname;
  if (method === "GET") {
    if (pathname === "/api/data" || url.searchParams.has("data")) return { kind: "data" };
    if (pathname === "/api/suggest") return { kind: "suggest", query: url.searchParams.get("q") ?? "" };
    if (pathname === "/page.css") return { kind: "page-css" };
    if (pathname === "/icon.png") return { kind: "page-icon" };
    if (pathname === "/") return { kind: "page", variant: startVariant(url) };
    return { kind: "not-found" };
  }
  return { kind: "not-found" };
}

export function resolveSearchEngine(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : SEARCH_ENGINES[0].search;
}

const HAS_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCHEMES_WITHOUT_HOST = /^(?:data|mailto|tel|about|blob|chrome|view-source):/i;
const HOST_PORT_PATH = /^[\w.-]+(?::\d+)?(?:\/.*)?$/;
const HOST_COLON_PORT = /^[\w-]+:\d+(\/.*)?$/;

// Mirrors the searchOrUrl -> normalizeUrl pipeline without local files:
// the page has no fs/cwd, so bare hosts and schemes resolve to web only.
export function resolveSearchInput(input: string, template: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "about:blank";
  if (HAS_AUTHORITY.test(trimmed) || SCHEMES_WITHOUT_HOST.test(trimmed)) {
    try {
      return new URL(trimmed).toString();
    } catch {
    }
  } else if ((!trimmed.includes(" ") && trimmed.includes(".")) || HOST_COLON_PORT.test(trimmed)) {
    if (HOST_PORT_PATH.test(trimmed)) {
      const host = trimmed.split(/[:/]/)[0].toLowerCase();
      const scheme = host === "localhost" || host === "127.0.0.1" ? "http" : "https";
      try {
        return new URL(`${scheme}://${trimmed}`).toString();
      } catch {
      }
    }
  }
  const encoded = encodeURIComponent(trimmed);
  return template.includes("%s") ? template.split("%s").join(encoded) : `${template}${encoded}`;
}

// Null template means no suggestion endpoint, so callers hide the dropdown.
export function suggestUrl(suggest: string | null, query: string): string | null {
  if (!suggest) return null;
  const encoded = encodeURIComponent(query.trim());
  return suggest.includes("%s") ? suggest.split("%s").join(encoded) : `${suggest}${encoded}`;
}

export function parseSuggestResponse(body: string): string[] {
  return parseSuggestions(body);
}
