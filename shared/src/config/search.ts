import { z } from "zod";

import { jsonText } from "./json";

export interface SearchEngine {
  id: string;
  name: string;
  logo: string;
  search: string;
  suggest: string | null;
}

export const SUGGESTIONS_OFF = "off";

export const SEARCH_ENGINES: SearchEngine[] = [
  {
    id: "google",
    name: "Google",
    logo: "search/google.png",
    search: "https://www.google.com/search?q=%s",
    suggest: "https://suggestqueries.google.com/complete/search?client=firefox&q=%s",
  },
  {
    id: "duckduckgo",
    name: "DuckDuckGo",
    logo: "search/duckduckgo.png",
    search: "https://duckduckgo.com/?q=%s",
    suggest: "https://duckduckgo.com/ac/?q=%s&type=list",
  },
  {
    id: "bing",
    name: "Bing",
    logo: "search/bing.png",
    search: "https://www.bing.com/search?q=%s",
    suggest: "https://api.bing.com/osjson.aspx?query=%s",
  },
  {
    id: "brave",
    name: "Brave",
    logo: "search/brave.png",
    search: "https://search.brave.com/search?q=%s",
    suggest: "https://search.brave.com/api/suggest?q=%s",
  },
  {
    id: "kagi",
    name: "Kagi",
    logo: "search/kagi.png",
    search: "https://kagi.com/search?q=%s",
    suggest: "https://kagi.com/api/autosuggest?q=%s",
  },
  {
    id: "ecosia",
    name: "Ecosia",
    logo: "search/ecosia.png",
    search: "https://www.ecosia.org/search?q=%s",
    suggest: "https://ac.ecosia.org/?q=%s",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    logo: "search/perplexity.png",
    search: "https://www.perplexity.ai/search?q=%s",
    suggest: null,
  },
];

export function engineBySearch(template: string): SearchEngine | null {
  return SEARCH_ENGINES.find((engine) => engine.search === template) ?? null;
}

export function engineBySuggest(template: string): SearchEngine | null {
  return SEARCH_ENGINES.find((engine) => engine.suggest === template) ?? null;
}

const strings = z
  .array(z.unknown())
  .transform((items) => items.filter((item): item is string => typeof item === "string"));

// Most engines return the OpenSearch shape `[query, [suggestions], ...]`; Ecosia
// returns `{ suggestions: [...] }`.
const openSearchFeed = z.tuple([z.unknown(), strings]).rest(z.unknown()).transform(([, list]) => list);
const ecosiaFeed = z.object({ suggestions: strings }).transform((feed) => feed.suggestions);
const suggestionFeed = jsonText.pipe(z.union([openSearchFeed, ecosiaFeed]));

export function parseSuggestions(body: string): string[] {
  const parsed = suggestionFeed.safeParse(body);
  return parsed.success ? parsed.data : [];
}
