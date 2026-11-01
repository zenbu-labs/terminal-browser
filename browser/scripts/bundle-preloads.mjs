import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preloads = [
  ["src/extensions/preload.ts", "extension-preload.js"],
  ["src/extensions/webstore-preload.ts", "chrome-web-store-preload.js"],
  ["src/pages/internal-preload.ts", "internal-preload.js"],
];
const pageScripts = ["extensions", "history", "downloads", "bookmarks", "settings"];
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "dist");

await Promise.all([
  ...preloads.map(([entry, output]) =>
    build({
      entryPoints: [path.join(root, entry)],
      outfile: path.join(outDir, output),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      external: ["electron"],
      logLevel: "warning",
    }),
  ),
  ...pageScripts.map((name) =>
    build({
      entryPoints: [path.join(root, "src/pages/client", `${name}.js`)],
      outfile: path.join(outDir, "pages/client", `${name}.js`),
      bundle: true,
      platform: "browser",
      format: "iife",
      target: "chrome130",
      logLevel: "warning",
    }),
  ),
]);
