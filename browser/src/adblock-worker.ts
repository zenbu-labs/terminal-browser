import fs from "node:fs";

import { FiltersEngine } from "@ghostery/adblocker";

// the lists uBlock Origin enables by default, from its own assets.json
const UBO = "https://ublockorigin.github.io/uAssets";
const LISTS = [
  `${UBO}/filters/filters.txt`,
  `${UBO}/filters/badware.txt`,
  `${UBO}/filters/privacy.txt`,
  `${UBO}/filters/unbreak.txt`,
  `${UBO}/filters/quick-fixes.txt`,
  `${UBO}/thirdparties/easylist.txt`,
  `${UBO}/thirdparties/easyprivacy.txt`,
  "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=1&mimetype=plaintext",
];

// scriptlet and redirect payloads, which only the ghostery engine knows how to read
const RESOURCES =
  "https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json";

async function read(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.text();
}

// uBlock Origin splits its lists across files that the parent pulls in by name
async function readWithIncludes(url: string, seen: Set<string>): Promise<string> {
  if (seen.has(url)) return "";
  seen.add(url);
  const body = await read(url);
  const includes = [...body.matchAll(/^!#include +(\S+)/gm)].map(
    (match) => new URL(match[1], url).href,
  );
  const included = await Promise.all(includes.map((child) => readWithIncludes(child, seen)));
  return [body, ...included].join("\n");
}

void (async () => {
  const out = process.argv[2];
  if (!out) {
    process.stderr.write("usage: adblock-worker <output file>\n");
    process.exit(1);
  }
  try {
    const seen = new Set<string>();
    const [lists, resources] = await Promise.all([
      Promise.all(LISTS.map((url) => readWithIncludes(url, seen))),
      read(RESOURCES),
    ]);
    const engine = FiltersEngine.parse(lists.join("\n"), {});
    engine.updateResources(resources, String(resources.length));
    const temporary = `${out}.${process.pid}`;
    fs.writeFileSync(temporary, engine.serialize());
    fs.renameSync(temporary, out);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
})();
