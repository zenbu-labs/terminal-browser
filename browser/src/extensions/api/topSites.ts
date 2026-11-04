import { topHistorySites } from "shared";

import type { ExtensionService } from "../service";

const TOP_SITES = 10;

export function installTopSites(service: ExtensionService) {
  service.router.handle(
    "topSites.get",
    () => topHistorySites(TOP_SITES).map((entry) => ({ url: entry.url, title: entry.title || entry.url })),
    { permission: "topSites" },
  );
}
