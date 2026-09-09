import { pathToFileURL } from "node:url";

// dependencies that call createRequire(import.meta.url) would otherwise get {} in a cjs bundle
export const importMetaUrl = pathToFileURL(__filename).href;
