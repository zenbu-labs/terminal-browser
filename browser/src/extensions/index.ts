import { session as electronSession } from "electron";

import { installApis } from "./api";
import { startExtensionService } from "./service";
import type { ExtensionService } from "./service";

export function startExtensions(): ExtensionService {
  const service = startExtensionService(electronSession.defaultSession);
  installApis(service);
  return service;
}
