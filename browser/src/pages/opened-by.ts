import type { WebContents } from "electron";

// Web pages can't open internal pages (navigation.ts, tabs.ts), so an internal page was opened by the
// browser itself unless an extension asked for it. Extension APIs announce the internal URL they are
// about to open; the next main-frame navigation to it belongs to the extension.
const EXPECT_MS = 10_000;
const expected = new Map<string, number>();
const openedByExtension = new WeakMap<WebContents, boolean>();

export function expectExtensionNavigation(url: string) {
  expected.set(url, Date.now() + EXPECT_MS);
}

export function trackInternalPageOpener(contents: WebContents) {
  contents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    const deadline = expected.get(details.url);
    if (deadline !== undefined) expected.delete(details.url);
    openedByExtension.set(contents, deadline !== undefined && deadline >= Date.now());
  });
}

export function pageOpenedByExtension(contents: WebContents): boolean {
  return openedByExtension.get(contents) ?? false;
}
