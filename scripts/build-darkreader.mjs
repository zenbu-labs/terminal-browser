// Builds the parts of the Dark Reader extension that its npm package leaves out:
// per-site fixes, the list of already dark sites, and detection of sites that ship their own dark theme
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const VERSION = "4.9.135";
const COMMIT = "dbf2a1029131280d9dab21ed29f1dfdeb51a6cc7";
const TARBALL_SHA256 = "45045c84999be054f4b35dd6bb430231fb9ace5adcdfb6f394665eedf4c7e7a2";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "node_modules", ".cache", `darkreader-${VERSION}`);
const OUT = path.join(ROOT, "assets", "darkreader");

if (!fs.existsSync(SOURCE)) {
  const response = await fetch(`https://codeload.github.com/darkreader/darkreader/tar.gz/${COMMIT}`);
  if (!response.ok) throw new Error(`darkreader source download failed: ${response.status}`);
  const tarball = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(tarball).digest("hex");
  if (sha256 !== TARBALL_SHA256) throw new Error(`darkreader source checksum mismatch: got ${sha256}`);
  fs.mkdirSync(SOURCE, { recursive: true });
  const untar = spawnSync("tar", ["xz", "--strip-components=1", "-C", SOURCE], { input: tarball });
  if (untar.status !== 0) {
    fs.rmSync(SOURCE, { recursive: true, force: true });
    throw new Error(`darkreader source extract failed: ${untar.stderr}`);
  }
}

const PAGE = `
import "./api/chrome";
import { setFetchMethod } from "./api/fetch";
import { DEFAULT_THEME } from "./defaults";
import { createOrUpdateDynamicTheme, removeDynamicTheme } from "./inject/dynamic-theme";
import { runDarkThemeDetector, stopDarkThemeDetector } from "./inject/detector";

setFetchMethod((url) => fetch(url));

function whenDocumentExists(run) {
  if (document.documentElement) return run();
  new MutationObserver((_, observer) => {
    if (!document.documentElement) return;
    observer.disconnect();
    run();
  }).observe(document, { childList: true });
}

globalThis.darkReader = {
  apply: ({ fixes, detectDarkTheme, detectorHints }) =>
    whenDocumentExists(() => {
      createOrUpdateDynamicTheme(DEFAULT_THEME, fixes, window !== window.top);
      if (!detectDarkTheme) return;
      runDarkThemeDetector((hasDarkTheme) => {
        if (!hasDarkTheme) return;
        removeDynamicTheme();
        terminalBrowserDarkReader.darkThemeDetected();
      }, detectorHints);
    }),
  remove: () => {
    stopDarkThemeDetector();
    removeDynamicTheme();
  },
};
`;

const SITES = `
import { parseArray } from "./utils/text";
import { indexURLTemplateList, isURLInIndexedList } from "./utils/url";
import { indexSitesFixesConfig } from "./generators/utils/parse";
import { getDynamicThemeFixesFor } from "./generators/dynamic-theme";
import { getDetectorHintsFor } from "./generators/detector-hints";
import darkSites from "./config/dark-sites.config";
import fixes from "./config/dynamic-theme-fixes.config";
import hints from "./config/detector-hints.config";

const darkSitesIndex = indexURLTemplateList(parseArray(darkSites));
const fixesIndex = indexSitesFixesConfig(fixes);
const hintsIndex = indexSitesFixesConfig(hints);

export const isDarkSite = (url) => isURLInIndexedList(url, darkSitesIndex);
export const fixesFor = (url) => getDynamicThemeFixesFor(url, fixes, fixesIndex, true);
export const detectorHintsFor = (url) => getDetectorHintsFor(url, hints, hintsIndex);
`;

const shared = {
  bundle: true,
  minify: true,
  alias: { "@plus": path.join(SOURCE, "src", "stubs") },
  nodePaths: [path.join(SOURCE, "src")],
  loader: { ".config": "text" },
  define: Object.fromEntries(
    ["DEBUG", "CHROMIUM_MV2", "CHROMIUM_MV3", "FIREFOX_MV2", "THUNDERBIRD", "TEST", "PLUS", "WATCH", "LOG"].map((flag) => [
      `__${flag}__`,
      "false",
    ]),
  ),
  logLevel: "warning",
};

await Promise.all([
  build({
    ...shared,
    stdin: { contents: PAGE, resolveDir: path.join(SOURCE, "src"), loader: "ts" },
    format: "iife",
    outfile: path.join(OUT, "page.js"),
  }),
  build({
    ...shared,
    stdin: { contents: SITES, resolveDir: path.join(SOURCE, "src"), loader: "ts" },
    format: "cjs",
    platform: "node",
    outfile: path.join(OUT, "sites.js"),
  }),
]);
