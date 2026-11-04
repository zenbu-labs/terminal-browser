const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-install-icon-data-"));
require("./fake-electron");
const { readCrxFile } = require("shared");
const { Installer } = require("../dist/extensions/install.js");

const CRX = path.join(__dirname, "../../shared/test/fixtures/json-formatter.crx");

test("the install prompt's icon never lands on a path another user could have planted", async () => {
  const pkg = readCrxFile(CRX);
  const shared = path.join(os.tmpdir(), "terminal-browser-install-icons");
  fs.mkdirSync(shared, { recursive: true });
  const victim = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tb-icon-victim-")), "bashrc");
  fs.writeFileSync(victim, "original");
  const planted = path.join(shared, `${pkg.id}-${pkg.version}.png`);
  fs.rmSync(planted, { force: true });
  fs.symlinkSync(victim, planted);

  let shown = null;
  const window = {
    host: {
      prompt: async (request) => {
        shown = request.icon;
        assert.ok(shown);
        assert.equal(fs.lstatSync(shown).isSymbolicLink(), false);
        assert.equal(fs.statSync(path.dirname(shown)).mode & 0o077, 0);
        return false;
      },
    },
  };
  try {
    const result = await new Installer({ lastFocusedWindow: () => window }).installCrxFile(CRX, window);
    assert.equal(result, null);
    assert.equal(fs.readFileSync(victim, "utf8"), "original");
    assert.notEqual(path.dirname(shown), shared);
    assert.equal(fs.existsSync(shown), false);
  } finally {
    fs.rmSync(planted, { force: true });
  }
});
