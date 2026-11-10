const FALLBACK: Record<string, number> = {
  "zenbu-labs/terminal-browser": 3919,
  "zenbu-labs/terminal-code": 2149,
};

export async function starCount(repo: string): Promise<string> {
  let count = FALLBACK[repo] ?? 0;
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}`, { next: { revalidate: 3600 } });
    if (response.ok) count = ((await response.json()) as { stargazers_count: number }).stargazers_count;
  } catch {}
  return count >= 1000 ? `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${count}`;
}
