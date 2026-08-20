const BROWSER_FLAGS = [
  "--app-mode",
  "--no-toolbar",
  "--no-shortcuts",
  "--no-context-menu",
  "--no-overlays",
  "--no-frame",
  "--open-tabs-in-popup-stack",
  "--allow-clipboard-read",
  "--allow-quit-url",
  "--partition=",
  "--preload=",
  "--main-script=",
  "--palette-key=",
  "--find-key=",
  "--devtools-key=",
  "--console-key=",
  "--split-dir=",
  "--parent-tty=",
];

export function isBrowserFlag(arg: string): boolean {
  return BROWSER_FLAGS.some((flag) =>
    flag.endsWith("=") ? arg.startsWith(flag) : arg === flag,
  );
}
