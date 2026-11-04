import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CHROME_VERSION = "156.0.8078.80";

const PLATFORMS = {
  "darwin-arm64": { name: "mac-arm64", binary: "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" },
  "darwin-x64": { name: "mac-x64", binary: "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" },
  "linux-x64": { name: "linux64", binary: "chrome-linux64/chrome" },
};

// Chrome for Testing at the pinned version, downloaded into the user cache on first use.
export async function chromeForTesting(log = () => {}) {
  if (process.env.CFT_CHROME) return process.env.CFT_CHROME;
  const platform = PLATFORMS[`${process.platform}-${process.arch}`];
  // fixme: placeholder copy
  if (!platform) throw new Error(`no Chrome for Testing build for ${process.platform}-${process.arch}`);
  const dir = path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "tb-extensions-conformance", `chrome-${CHROME_VERSION}-${platform.name}`);
  const binary = path.join(dir, platform.binary);
  if (fs.existsSync(binary)) return binary;
  const url = `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/${platform.name}/chrome-${platform.name}.zip`;
  log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(dir), "download-"));
  try {
    const zip = path.join(staging, "chrome.zip");
    fs.writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
    execFileSync("unzip", ["-q", zip, "-d", path.join(staging, "unpacked")]);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(path.join(staging, "unpacked"), dir);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return binary;
}
