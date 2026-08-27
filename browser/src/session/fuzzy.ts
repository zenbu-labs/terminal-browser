export function fuzzyScore(query: string, target: string): number {
  const q = query.trim().toLowerCase();
  const t = target.toLowerCase();
  if (!q || !t) return 0;
  if (t.startsWith(q)) return 3;
  if (t.split(/[\s-]+/).some((word) => word.startsWith(q))) return 2.5;
  if (t.includes(q)) return 2;
  let at = 0;
  for (const char of q) {
    at = t.indexOf(char, at);
    if (at < 0) return 0;
    at++;
  }
  return 1;
}
