const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Vt, sgr } = require("../dist/terminal/vt.js");

const HERE = __dirname;
const HOST = path.join(HERE, "..", "dist", "host.js");
const FAKE = path.join(HERE, "fake-ghostty.py");
const TERMINFO_DIRS = [path.join(os.homedir(), ".terminfo"), "/Applications/Ghostty.app/Contents/Resources/terminfo", path.join(os.homedir(), "pc-orch", "kit", "ghostty-resources", "terminfo")]
  .filter((dir) => fs.existsSync(dir))
  .join(":");
const ARTIFACTS = process.env.PXSH_ARTIFACTS ?? path.join(os.tmpdir(), "pxsh-artifacts");

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pxsh-home-"));
  fs.writeFileSync(path.join(home, ".zshrc"), 'PS1="READY> "\nunsetopt PROMPT_SP\n');
  return home;
}

function withoutHostTerminal(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^(GHOSTTY_|KITTY_|ZENBU|TMUX|TERM_PROGRAM|INIT_CWD$|PXSH_)/.test(name)));
}

function runFake({ name, steps, command, env = {}, cols = 100, rows = 30, cell = "10x20", timeout = 30, frames = false, legacyKeys = false, ghosttyVersion, oldOutput = null, oldLine = null, noDsr = false, dsrTypeahead = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pxsh-run-"));
  const home = env.HOME ?? makeHome();
  const capture = path.join(dir, "capture.bin");
  const script = path.join(dir, "steps.json");
  const tapFile = path.join(dir, "tap.bin");
  fs.writeFileSync(script, JSON.stringify(steps));
  const framesDir = path.join(dir, "frames");
  const extra = [
    ...(frames ? ["--frames", framesDir] : []),
    ...(legacyKeys ? ["--legacy-keys"] : []),
    ...(ghosttyVersion ? ["--version", ghosttyVersion] : []),
    ...(oldOutput != null ? ["--old-output", String(oldOutput)] : []),
    ...(oldLine != null ? ["--old-line", oldLine] : []),
    ...(noDsr ? ["--no-dsr"] : []),
    ...(dsrTypeahead != null ? ["--dsr-typeahead", dsrTypeahead] : []),
  ];
  const result = spawnSync("python3", [FAKE, "--capture", capture, "--script", script, "--cols", String(cols), "--rows", String(rows), "--cell", cell, "--timeout", String(timeout), ...extra, "--", ...command], {
    cwd: home,
    env: {
      ...withoutHostTerminal(process.env),
      HOME: home,
      ZDOTDIR: home,
      TERM: "xterm-ghostty",
      TERM_PROGRAM: "ghostty",
      TERMINFO_DIRS,
      PXSH_CWD: home,
      PXSH_TAP: tapFile,
      PXSH_NO_UI: "1",
      ...env,
    },
    encoding: "utf8",
    timeout: (timeout + 10) * 1000,
  });
  const out = {
    capture: fs.existsSync(capture) ? fs.readFileSync(capture) : Buffer.alloc(0),
    marks: fs.existsSync(capture + ".marks.json") ? JSON.parse(fs.readFileSync(capture + ".marks.json", "utf8")) : {},
    resizes: fs.existsSync(capture + ".resizes.json") ? JSON.parse(fs.readFileSync(capture + ".resizes.json", "utf8")) : [],
    size: { cols, rows },
    tap: fs.existsSync(tapFile) ? readTap(fs.readFileSync(tapFile)) : [],
    stderr: result.stderr,
    frames: frames && fs.existsSync(path.join(framesDir, "frames.json")) ? JSON.parse(fs.readFileSync(path.join(framesDir, "frames.json"), "utf8")) : [],
    dir,
  };
  if (name) {
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, `${name}.capture.bin`), out.capture);
    if (fs.existsSync(tapFile)) fs.copyFileSync(tapFile, path.join(ARTIFACTS, `${name}.tap.bin`));
  }
  return out;
}

function readTap(data) {
  const records = [];
  for (let at = 0; at + 5 <= data.length; ) {
    const from = { 0x73: "shell", 0x70: "pxsh", 0x72: "raw", 0x7a: "zsh" }[data[at]];
    const length = data.readUInt32LE(at + 1);
    records.push({ from, bytes: data.subarray(at + 5, at + 5 + length) });
    at += 5 + length;
  }
  return records;
}

function between(buffer, start, end) {
  const from = buffer.indexOf(start);
  if (from < 0) return null;
  const to = buffer.indexOf(end, from + start.length);
  if (to < 0) return null;
  return buffer.subarray(from + start.length, to);
}

const pxsh = ["node", HOST];
const plainZsh = ["/bin/zsh", "-l"];

function uiEnv(home) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "pxsh-state-"));
  return {
    HOME: home,
    PXSH_NO_UI: "",
    PXSH_CODEX: path.join(__dirname, "fixtures", "fake-codex"),
    PXSH_CLAUDE: "/nonexistent",
    XDG_STATE_HOME: state,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
  };
}

function screenAt(capture, at, cols = 100, rows = 30, resizes = []) {
  const vt = new Vt(cols, rows, { scrollback: 1000 });
  let fed = 0;
  for (const [offset, toCols, toRows] of resizes) {
    if (offset > at) break;
    vt.write(capture.subarray(fed, offset));
    fed = offset;
    vt.resize(toCols, toRows, 10, 20);
    [cols, rows] = [toCols, toRows];
  }
  vt.write(capture.subarray(fed, at));
  const info = vt.info();
  const lines = [];
  const grid = [];
  let placeholders = 0;
  for (let y = 0; y < rows; y++) {
    const cells = [];
    const texts = [];
    for (let x = 0; x < cols; x++) {
      const c = vt.cell(x, y);
      if (c.text.codePointAt(0) === 0x10eeee) placeholders++;
      cells.push(`${c.text}${sgr(c.style)}`);
      texts.push(c.text);
    }
    lines.push(cells.join(""));
    grid.push(texts);
  }
  const text = vt.lines(0, rows).map((l) => l.cells.join("").trimEnd());
  const scrollback = vt.lines(-info.history, info.history).map((l) => l.cells.join("").trimEnd());
  return { lines, grid, text, scrollback, placeholders, cursor: [info.cursorX, info.cursorY], visible: info.cursorVisible, mouse: info.mouseTracking, pen: sgr(vt.pen()) };
}

function screenOf(run, mark) {
  return screenAt(run.capture, run.marks[mark], run.size.cols, run.size.rows, run.resizes);
}

module.exports = { runFake, between, pxsh, plainZsh, makeHome, uiEnv, screenAt, screenOf, ARTIFACTS };
