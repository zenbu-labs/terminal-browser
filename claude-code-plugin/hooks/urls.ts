export function normalizeUrl(raw: string): string {
  const text = raw.trim()
  if (/^localhost(:\d+)?(\/|$)/.test(text) || /^\d+\.\d+\.\d+\.\d+/.test(text)) return `http://${text}`
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text
  return `https://${text}`
}

// The address is handed to another program on its command line, where it may come from the agent
// rather than the user, so only web and browser schemes pass, without characters no url may hold.
export function paneUrl(raw: string): string | null {
  const url = normalizeUrl(raw)
  if (!/^(https?|file|terminal-browser):/i.test(url)) return null
  if (/[\s"<>^`|\\{}]/.test(url) || /[\x00-\x1f\x7f]/.test(url)) return null
  if (/%(?![0-9a-f]{2})/i.test(url)) return null
  return url
}
