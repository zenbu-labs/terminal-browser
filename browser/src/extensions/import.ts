import { CrxError, fetchStorePackage, findImportSource, findImports, getExtension, importDisabledReason, isExtensionId } from "shared";
import type { ImportBrowser } from "shared";

import { AlreadyInstalledError } from "./install";
import type { InstallResult } from "./install";
import type { ExtensionService } from "./service";

export interface ImportResult extends InstallResult {
  enabled: boolean;
  needsApproval: boolean;
}

// Welcome pages an extension opens right after it's imported stay in the
// background so the import page keeps focus.
const BACKGROUND_TABS_MS = 15_000;

function importFailure(error: unknown): string {
  if (error instanceof AlreadyInstalledError) return "Already installed";
  if (error instanceof CrxError) {
    if (error.code === "not_found" || error.code === "wrong_id") return "Not on the Chrome Web Store";
    if (error.code === "download_failed") return error.message;
    return "Signature check failed";
  }
  return error instanceof Error ? error.message : String(error);
}

// Imports install without a permission prompt, since the user already accepted
// these extensions in the browser they come from. The Web Store package is
// still verified like any other install.
export class Importer {
  private readonly importedAt = new Map<string, number>();

  constructor(private readonly service: ExtensionService) {}

  find(): Promise<ImportBrowser[]> {
    return findImports({ prodversion: process.versions.chrome });
  }

  // The id must be a Web Store extension in the chosen profile right now;
  // whether it ends up on comes from that profile too, never from the page.
  async install(browser: string, profile: string, id: string): Promise<ImportResult> {
    if (!isExtensionId(id)) throw new Error(`${id} is not an extension id`);
    const source = findImportSource(browser, profile, id);
    // fixme: placeholder copy
    if (!source || source.item.status !== "ready") throw new Error("Not in this profile");
    try {
      if (getExtension(id)) throw new AlreadyInstalledError(id);
      const pkg = await fetchStorePackage(id, process.versions.chrome);
      const disabledReason = importDisabledReason(source, pkg.manifest);
      this.importedAt.set(id, Date.now());
      const result = await this.service.installer.installPrepared(pkg, disabledReason);
      return { ...result, enabled: disabledReason === null, needsApproval: disabledReason === "permissions_increase" && source.item.enabled };
    } catch (error) {
      throw new Error(importFailure(error));
    }
  }

  justImported(id: string): boolean {
    const at = this.importedAt.get(id);
    return at !== undefined && Date.now() - at < BACKGROUND_TABS_MS;
  }
}
