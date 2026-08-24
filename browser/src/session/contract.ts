const APP_MODE_FLAGS = [
  "--no-toolbar",
  "--no-shortcuts",
  "--no-context-menu",
  "--no-overlays",
  "--no-frame",
  "--allow-clipboard-read",
  "--open-tabs-in-popup-stack",
];

export function resolveSessionOptions(argv: string[]) {
  const resolved = argv.includes("--app-mode") ? [...argv, ...APP_MODE_FLAGS] : argv;
  return {
    argv: resolved,
    allowQuitUrl: resolved.includes("--allow-quit-url"),
  };
}

export function ownsSender<T>(
  senderFrame: T,
  senderMainFrame: T,
  senderId: number,
  ownsContents: (id: number) => boolean,
): boolean {
  return senderFrame === senderMainFrame && ownsContents(senderId);
}

export function closeAction(tabCount: number): "shutdown" | "close" {
  return tabCount <= 1 ? "shutdown" : "close";
}
