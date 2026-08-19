import { browserUserAgent } from "../user-agent";

export async function fetchSuggestions(query: string, limit = 6): Promise<string[]> {
  const url = `https://suggestqueries.google.com/complete/search?client=chrome&q=${encodeURIComponent(query)}`;
  const response = await fetch(url, { headers: { "User-Agent": browserUserAgent() } });
  const body = await response.text();
  const parsed = JSON.parse(body) as unknown[];
  const list = Array.isArray(parsed[1]) ? (parsed[1] as unknown[]) : [];
  return list.filter((item): item is string => typeof item === "string").slice(0, limit);
}
