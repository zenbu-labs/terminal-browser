import { app } from "electron";
import type { WebContents } from "electron";

import { extensionService } from "../extensions/service";
import { INTERNAL_SCHEME, internalHostOf, isInternalUrl } from "./internal";
import { refuseLocalRedirects } from "./local-loads";
import { guardLocalNavigation } from "./local-navigation";
import { trackInternalPageOpener } from "./opened-by";

const OVERRIDABLE = ["newtab", "history", "bookmarks"] as const;

export type OverridablePage = (typeof OVERRIDABLE)[number];

// Like Chrome, the most recently loaded extension that overrides a page wins.
export function urlOverride(page: OverridablePage): string | null {
  let found: string | null = null;
  for (const extension of extensionService().loaded.values()) {
    const file = extension.manifest.chrome_url_overrides?.[page];
    if (file) found = extension.url(file) ?? found;
  }
  return found;
}

function blockWebNavigation(contents: WebContents) {
  contents.on("will-frame-navigate", (event) => {
    if (!isInternalUrl(event.url)) return;
    const initiator = event.initiator?.origin ?? "";
    if (event.isMainFrame && isInternalUrl(initiator)) return;
    event.preventDefault();
  });
}

function followOverrides(contents: WebContents) {
  contents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    const host = internalHostOf(details.url);
    if (!host || !(OVERRIDABLE as readonly string[]).includes(host)) return;
    const target = urlOverride(host as OverridablePage);
    if (!target) return;
    extensionService().overridePage(contents.id, `chrome://${host}/`, target);
    setImmediate(() => !contents.isDestroyed() && void contents.loadURL(target));
  });
}

export function overriddenNewTab(): string | null {
  return urlOverride("newtab") ? `${INTERNAL_SCHEME}://newtab/` : null;
}

export function guardInternalNavigation() {
  app.on("web-contents-created", (_event, contents) => {
    blockWebNavigation(contents);
    guardLocalNavigation(contents);
    refuseLocalRedirects(contents);
    followOverrides(contents);
    trackInternalPageOpener(contents);
  });
}
