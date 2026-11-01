import { session as electronSession } from "electron";

import { installApis } from "./api";
import { DevReloader } from "./dev";
import { startExtensionService } from "./service";
import type { ExtensionService } from "./service";
import { WebStore } from "./webstore";

export function startExtensions(): ExtensionService {
  const service = startExtensionService(electronSession.defaultSession);
  installApis(service);
  new WebStore(service);
  new DevReloader(service);
  service.installer.startPeriodicChecks();
  return service;
}
