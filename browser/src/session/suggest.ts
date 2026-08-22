import { renderSearchTemplate } from "pixel-store";
import type { SearchEngineDefinition } from "pixel-store";

export async function fetchSuggestions(
  query: string,
  engine: SearchEngineDefinition,
  limit = 6,
): Promise<string[]> {
  if (!engine.suggestUrl) return [];
  const url = renderSearchTemplate(engine.suggestUrl, query);
  const body = await (await fetch(url)).text();
  const parsed = JSON.parse(body) as unknown[];
  const list = Array.isArray(parsed[1]) ? (parsed[1] as unknown[]) : [];
  return list.filter((item): item is string => typeof item === "string").slice(0, limit);
}
