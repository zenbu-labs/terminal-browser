import { parseSuggestions } from "shared";
import { searchUrlFor } from "../url";

export async function fetchSuggestions(template: string, query: string, limit = 6): Promise<string[]> {
  const body = await (await fetch(searchUrlFor(template)(query))).text();
  return parseSuggestions(body).slice(0, limit);
}
