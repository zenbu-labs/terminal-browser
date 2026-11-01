export function extensionIdFromOrigin(origin: string | undefined | null): string | null {
  const match = /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(origin ?? "");
  return match ? match[1] : null;
}

export function extensionIdFromUrl(url: string | undefined | null): string | null {
  const match = /^chrome-extension:\/\/([a-p]{32})(?:\/|$)/.exec(url ?? "");
  return match ? match[1] : null;
}
