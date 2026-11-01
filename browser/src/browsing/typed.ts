import type { WebContents } from "electron";

// Chrome's PAGE_TRANSITION_FROM_ADDRESS_BAR belongs to the one main-frame navigation the user started from the
// address bar. It follows that navigation through its redirects and ends when it commits or another one starts.
interface Navigation {
  url: string;
  typed: boolean;
  first: boolean;
  committed: boolean;
}

const typing = new WeakSet<WebContents>();
const typedTabs = new WeakSet<WebContents>();
const navigations = new WeakMap<WebContents, Navigation>();
const watched = new WeakSet<WebContents>();

export function navigateTyped(contents: WebContents, navigate: () => void) {
  typing.add(contents);
  try {
    navigate();
  } finally {
    typing.delete(contents);
  }
}

// A tab opened from the address bar: its first navigation is the one the user typed.
export function openedFromAddressBar(contents: WebContents) {
  typedTabs.add(contents);
}

export function watchTypedNavigations(contents: WebContents) {
  if (watched.has(contents)) return;
  watched.add(contents);
  let started = false;
  contents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame) return;
    navigations.set(contents, { url: details.url, typed: typing.has(contents), first: !started, committed: false });
    started = true;
  });
  contents.on("did-navigate", () => {
    const navigation = navigations.get(contents);
    if (navigation) navigation.committed = true;
  });
}

function fromAddressBar(contents: WebContents, navigation: Navigation): boolean {
  return navigation.typed || (navigation.first && typedTabs.has(contents));
}

export function committedFromAddressBar(contents: WebContents): boolean {
  const navigation = navigations.get(contents);
  return !!navigation && navigation.committed && fromAddressBar(contents, navigation);
}

// Whether a download starting at `url` is what the typed navigation still in flight in `contents` turned into.
// A navigation becomes at most one download.
export function takeTypedDownload(contents: WebContents, url: string): boolean {
  const navigation = navigations.get(contents);
  if (!navigation || navigation.committed || navigation.url !== url || !fromAddressBar(contents, navigation)) return false;
  navigations.delete(contents);
  return true;
}
