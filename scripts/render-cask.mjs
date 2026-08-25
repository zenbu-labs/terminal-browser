import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2] ?? "dist-release";
const manifests = fs
  .readdirSync(dir)
  .filter((file) => /^manifest-[a-z0-9-]+\.json$/.test(file))
  .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")));

const byPlatform = Object.fromEntries(manifests.map((m) => [m.platform, m]));
const required = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];
const missing = required.filter((platform) => !byPlatform[platform]);
if (missing.length) {
  console.error(`missing manifests in ${dir} for: ${missing.join(", ")}`);
  process.exit(1);
}

const [first, ...rest] = manifests;
for (const manifest of rest) {
  if (manifest.version !== first.version || manifest.channel !== first.channel) {
    console.error(
      `manifest mismatch: ${manifest.platform} is ${manifest.channel}/${manifest.version}, ` +
        `expected ${first.channel}/${first.version}`,
    );
    process.exit(1);
  }
}
if (first.channel !== "stable") {
  console.error(`refusing to render a cask for the ${first.channel} channel`);
  process.exit(1);
}

const version = first.version.replace(/^v/, "");
const sha = (platform) => byPlatform[platform].sha256;

process.stdout.write(`cask "terminal-browser" do
  arch arm: "arm64", intel: "x64"
  os macos: "darwin", linux: "linux"

  version "${version}"
  sha256 arm:          "${sha("darwin-arm64")}",
         intel:        "${sha("darwin-x64")}",
         arm64_linux:  "${sha("linux-arm64")}",
         x86_64_linux: "${sha("linux-x64")}"

  url "https://terminal-browser.sh/install/dl/stable/v#{version}/terminal-browser-#{os}-#{arch}.tar.gz",
      verified: "terminal-browser.sh/install/dl/"
  name "terminal-browser"
  desc "A browser inside your terminal"
  homepage "https://github.com/zenbu-labs/terminal-browser"

  livecheck do
    url "https://terminal-browser.sh/install/latest.json"
    strategy :json do |json|
      json["version"]&.delete_prefix("v")
    end
  end

  binary "terminal-browser/bin/terminal-browser"

  caveats "run terminal-browser setup to configure agent skills"

  zap trash: [
    "~/.agents/skills/terminal-browser",
    "~/.cache/terminal-browser-*",
    "~/.claude/skills/terminal-browser",
    "~/.codex/skills/terminal-browser",
    "~/.cursor/skills/terminal-browser",
    "~/.gemini/skills/terminal-browser",
    "~/.local/share/terminal-browser-*",
    "~/.local/state/terminal-browser",
    "~/.local/state/terminal-browser-*",
  ]
end
`);
