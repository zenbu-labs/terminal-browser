export interface SearchEngineDefinition {
  id: string;
  name: string;
  searchUrl: string;
  suggestUrl?: string;
}

const SEARCH_ENGINES: Record<string, SearchEngineDefinition> = {
  brave: {
    id: "brave",
    name: "Brave Search",
    searchUrl: "https://search.brave.com/search?q={searchTerms}",
    suggestUrl: "https://search.brave.com/api/suggest?q={searchTerms}",
  },
  google: {
    id: "google",
    name: "Google",
    searchUrl: "https://www.google.com/search?q={searchTerms}",
    suggestUrl:
      "https://suggestqueries.google.com/complete/search?client=chrome&q={searchTerms}",
  },
  duckduckgo: {
    id: "duckduckgo",
    name: "DuckDuckGo",
    searchUrl: "https://duckduckgo.com/?q={searchTerms}",
    suggestUrl: "https://duckduckgo.com/ac/?type=list&q={searchTerms}",
  },
  bing: {
    id: "bing",
    name: "Bing",
    searchUrl: "https://www.bing.com/search?q={searchTerms}",
    suggestUrl: "https://api.bing.com/osjson.aspx?query={searchTerms}",
  },
  kagi: {
    id: "kagi",
    name: "Kagi",
    searchUrl: "https://kagi.com/search?q={searchTerms}",
  },
  startpage: {
    id: "startpage",
    name: "Startpage",
    searchUrl: "https://www.startpage.com/sp/search?query={searchTerms}",
  },
  ecosia: {
    id: "ecosia",
    name: "Ecosia",
    searchUrl: "https://www.ecosia.org/search?q={searchTerms}",
  },
};

export function listSearchEngines(): SearchEngineDefinition[] {
  return Object.values(SEARCH_ENGINES).map((engine) => ({ ...engine }));
}

export function searchEngine(id: string): SearchEngineDefinition | null {
  const engine = SEARCH_ENGINES[id.toLowerCase()];
  return engine ? { ...engine } : null;
}

export function searchEngineFromTemplate(
  name: string,
  searchUrl: string,
  suggestUrl?: string,
): SearchEngineDefinition | null {
  const host = templateHost(searchUrl);
  const known = listSearchEngines().find((engine) => templateHost(engine.searchUrl) === host);
  if (known) return known;
  if (!validTemplate(searchUrl)) return null;
  return {
    id: "custom",
    name: name || host || "Custom",
    searchUrl,
    ...(suggestUrl && validTemplate(suggestUrl) ? { suggestUrl } : {}),
  };
}

export function renderSearchTemplate(template: string, query: string): string {
  const rendered = template
    .replaceAll("{searchTerms}", encodeURIComponent(query))
    .replaceAll("{searchTerms?}", encodeURIComponent(query))
    .replace(/\{[^{}]+\?\}/g, "");
  if (/\{[^{}]+\}/.test(rendered)) throw new Error("search engine uses unsupported URL fields");
  return rendered;
}

function validTemplate(template: string): boolean {
  if (!template.includes("{searchTerms")) return false;
  try {
    return new URL(
      template
        .replace("{google:baseURL}", "https://www.google.com/")
        .replaceAll("{searchTerms}", "query")
        .replaceAll("{searchTerms?}", "query")
        .replace(/\{[^{}]+\?\}/g, ""),
    ).protocol === "https:";
  } catch {
    return false;
  }
}

function templateHost(template: string): string | null {
  try {
    return new URL(
      template
        .replace("{google:baseURL}", "https://www.google.com/")
        .replace(/\{[^{}]+\}/g, "query"),
    ).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
