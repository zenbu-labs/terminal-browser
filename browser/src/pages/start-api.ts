import { SEARCH_ENGINES } from "shared";

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

export function suggestUrl(suggest: string | null, query: string): string | null {
  if (!suggest) return null;
  const encoded = encodeURIComponent(query.trim());
  return suggest.includes("%s") ? suggest.split("%s").join(encoded) : `${suggest}${encoded}`;
}
