const assert = require("node:assert/strict");
const { test } = require("node:test");

const { scaleFromLookup, scaleOfWindow, terminalAppPid } = require("../dist/terminal/window.js");

const GHOSTTY = "   10     1 ??       /Applications/Ghostty.app/Contents/MacOS/ghostty";
const LOGIN = "   20    10 ttys025  /usr/bin/login";
const SHELL = "   30    20 ttys025  -bash";

test("the terminal app is found by walking up from a process on the tty", () => {
  assert.equal(terminalAppPid([GHOSTTY, LOGIN, SHELL].join("\n"), "/dev/ttys025"), 10);
  assert.equal(terminalAppPid([GHOSTTY, LOGIN, SHELL].join("\n"), "ttys025"), 10);
});

test("apps started from the shell, like pixel itself, do not count as the terminal", () => {
  const pixel = "    5    30 ttys025  /Applications/terminal-browser.app/Contents/MacOS/terminal-browser";
  const preview = "    6    30 ttys025  /System/Applications/Preview.app/Contents/MacOS/Preview";
  assert.equal(terminalAppPid([pixel, preview, GHOSTTY, LOGIN, SHELL].join("\n"), "ttys025"), 10);
});

test("an editor's terminal resolves to the editor, not its helper app", () => {
  const listing = [
    "  100     1 ??       /Applications/Visual Studio Code.app/Contents/MacOS/Electron",
    "  110   100 ??       /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)",
    "  120   110 ttys040  /bin/zsh",
  ].join("\n");
  assert.equal(terminalAppPid(listing, "ttys040"), 100);
});

test("a tty with no app above it finds nothing", () => {
  const tmux = ["  300     1 ??       tmux", "  301   300 ttys030  -zsh"].join("\n");
  assert.equal(terminalAppPid(tmux, "ttys030"), null);
  assert.equal(terminalAppPid([GHOSTTY, LOGIN, SHELL].join("\n"), "ttys099"), null);
  assert.equal(terminalAppPid([GHOSTTY, LOGIN, SHELL].join("\n"), "??"), null);
});

test("a parent loop ends the walk", () => {
  const loop = ["  400   401 ttys050  -zsh", "  401   400 ttys050  /usr/bin/login"].join("\n");
  assert.equal(terminalAppPid(loop, "ttys050"), null);
});

test("a terminal started from another terminal's shell is the one that owns the pane", () => {
  const listing = [
    "   50     1 ??       /Applications/iTerm.app/Contents/MacOS/iTerm2",
    "   60    50 ttys001  /usr/bin/login",
    "   70    60 ttys001  -zsh",
    "   80    70 ttys001  /Applications/Ghostty.app/Contents/MacOS/ghostty",
    "   90    80 ttys002  /usr/bin/login",
    "  100    90 ttys002  -bash",
  ].join("\n");
  assert.equal(terminalAppPid(listing, "ttys002"), 80);
});

const LAPTOP = { x: 0, y: 0, width: 1800, height: 1169, scale: 2 };
const EXTERNAL_ABOVE = { x: -930, y: 1169, width: 3440, height: 1440, scale: 1 };

test("a window on the external display above the laptop gets the external display's scale", () => {
  assert.equal(scaleOfWindow({ x: -930, y: -1409, width: 1720, height: 1409 }, [LAPTOP, EXTERNAL_ABOVE]), 1);
});

test("a window on the laptop display gets the laptop's scale", () => {
  assert.equal(scaleOfWindow({ x: 100, y: 100, width: 800, height: 600 }, [LAPTOP, EXTERNAL_ABOVE]), 2);
});

test("a window across two displays gets the scale of the one holding most of it", () => {
  assert.equal(scaleOfWindow({ x: 100, y: -1000, width: 800, height: 1100 }, [LAPTOP, EXTERNAL_ABOVE]), 1);
  assert.equal(scaleOfWindow({ x: 100, y: -100, width: 800, height: 1100 }, [LAPTOP, EXTERNAL_ABOVE]), 2);
});

test("a window off every display has no scale", () => {
  assert.equal(scaleOfWindow({ x: 5000, y: 5000, width: 100, height: 100 }, [LAPTOP, EXTERNAL_ABOVE]), null);
  assert.equal(scaleOfWindow({ x: 0, y: 0, width: 100, height: 100 }, []), null);
});

test("the macOS lookup's output, captured from a terminal on a 1x external display, gives scale 1", () => {
  const output =
    '{"window":{"x":-930,"y":-1409,"width":1720,"height":1409},' +
    '"screens":[{"x":0,"y":0,"width":1800,"height":1169,"scale":2},{"x":-930,"y":1169,"width":3440,"height":1440,"scale":1}]}\n';
  assert.equal(scaleFromLookup(output), 1);
});

test("an empty lookup output means the app had no window", () => {
  assert.equal(scaleFromLookup(""), null);
  assert.equal(scaleFromLookup("\n"), null);
});
