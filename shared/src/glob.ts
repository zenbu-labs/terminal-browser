function isWildcard(char: string): boolean {
  return char === "*" || char === "?";
}

function codePointEnd(text: string, from: number, count: number): number {
  let index = from;
  for (let step = 0; step < count && index < text.length; step++) {
    index += (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
  }
  return index;
}

// Chromium's base::MatchPattern: `*` matches any run, `?` zero or one character,
// `\` escapes. Like Chromium it commits to each literal run's leftmost match.
export function matchesGlob(text: string, pattern: string): boolean {
  let p = 0;
  let t = 0;
  do {
    let anyLength = false;
    let maxSkip = 0;
    while (p < pattern.length && isWildcard(pattern[p])) {
      if (pattern[p] === "*") anyLength = true;
      else maxSkip++;
      p++;
    }
    let literal = "";
    while (p < pattern.length && !isWildcard(pattern[p])) {
      if (pattern[p] === "\\") p++;
      if (p < pattern.length) literal += pattern[p++];
    }
    const atEnd = p === pattern.length;
    const latest = anyLength ? text.length : codePointEnd(text, t, maxSkip);
    let found: number;
    if (atEnd) {
      found = text.length - literal.length;
      if (found < t || found > latest || !text.endsWith(literal)) return false;
    } else {
      found = text.indexOf(literal, t);
      if (found < 0 || found > latest) return false;
    }
    t = found + literal.length;
  } while (p < pattern.length);
  return true;
}

// Chromium's URLPattern::MatchesPath: only `*` is a wildcard, and "/foo/*" also
// matches "/foo".
export function matchesUrlPatternPath(path: string, patternPath: string): boolean {
  const escaped = patternPath.replaceAll("\\", "\\\\").replaceAll("?", "\\?");
  if (escaped.length === path.length + 2 && escaped.startsWith(path) && escaped.endsWith("/*")) return true;
  return matchesGlob(path, escaped);
}
