const assert = require("node:assert/strict");
const { test } = require("node:test");

const { HistoryCache, completionMove, completionRows, historyRows, moveSelection, narrowCompletions, parseCompletions, popupPlacement, scrollTop, typedSince, wordStart } = require("../../dist/completion/complete.js");

const enc = (text) => text.replace(/[%;\x1e\x1f\n]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);

function marker({ generation = 1, total, groups, messages = [], items, history = [], used = [] }) {
  return [
    generation,
    total ?? items.length,
    groups.map((g) => [g.name ?? "-default-", g.tag, g.explanation ?? "", g.sorted === false ? "0" : "1", g.prefix ?? ""].map(enc).join("\x1f")).join("\x1e"),
    messages.map(enc).join("\x1e"),
    items.map((i) => enc(i.word)).join("\x1e"),
    items.map((i) => enc(i.shown ?? "")).join("\x1e"),
    items.map((i) => i.group).join("\x1e"),
    items.map((i) => i.kind ?? "").join("\x1e"),
    history.map(enc).join("\x1e"),
    used.map(enc).join("\x1e"),
  ].join(";");
}

const labels = (rows) => rows.map((item) => item.label);

test("matches, descriptions and directories come out of zsh's marker", () => {
  const list = parseCompletions(
    marker({
      groups: [{ tag: "options", prefix: "--a" }, { tag: "globbed-files" }],
      items: [
        { word: "--amend", shown: "--amend   -- amend the tip of the current branch", group: 1 },
        { word: "my\\ dir", group: 2, kind: "/" },
        { word: "a;b%c", group: 2, kind: "f" },
      ],
    }),
  );
  assert.equal(list.generation, 1);
  assert.deepEqual(
    list.items.map(({ index, word, label, description, directory }) => [index, word, label, description, directory]),
    [
      [1, "--amend", "--amend", "amend the tip of the current branch", false],
      [2, "my\\ dir", "my\\ dir/", "", true],
      [3, "a;b%c", "a;b%c", "", false],
    ],
  );
  assert.equal(list.groups[0].prefix, "--a");
});

test("an empty list keeps zsh's message without its prompt escapes", () => {
  const list = parseCompletions(marker({ groups: [], messages: ["%Bno more arguments%b"], items: [] }));
  assert.deepEqual(list.items, []);
  assert.deepEqual(list.messages, ["no more arguments"]);
});

test("rows keep each kind together in zsh's order, sorted inside, and a match zsh shows once appears once", () => {
  const list = parseCompletions(
    marker({
      groups: [{ tag: "heads-local" }, { tag: "commits", sorted: false }, { tag: "heads" }],
      items: [
        { word: "main", group: 1 },
        { word: "feature-x", group: 1 },
        { word: "abc123", shown: "abc123  -- [HEAD]    seed", group: 2 },
        { word: "000aaa", group: 2 },
        { word: "main", group: 3 },
        { word: "origin/main", group: 3 },
      ],
    }),
  );
  assert.deepEqual(labels(completionRows(list)), ["feature-x", "main", "abc123", "000aaa", "origin/main"]);
  assert.equal(completionRows(list)[2].description, "[HEAD] seed");
});

test("typing narrows the old list to matches that start with the word so far, ignoring case and quoting", () => {
  const list = parseCompletions(
    marker({ groups: [{ tag: "files", prefix: "m" }], items: [{ word: "my\\ dir", group: 1 }, { word: "Makefile", group: 1 }, { word: "mobile", group: 1 }] }),
  );
  assert.deepEqual(narrowCompletions(list, "y ").map((i) => i.word), ["my\\ dir"]);
  assert.deepEqual(narrowCompletions(list, "A").map((i) => i.word), ["Makefile"]);
});

test("typedSince only accepts characters typed at the cursor", () => {
  assert.equal(typedSince({ buffer: "git co", cursor: 6 }, { buffer: "git com", cursor: 7 }), "m");
  assert.equal(typedSince({ buffer: "ls x", cursor: 2 }, { buffer: "ls ab x", cursor: 5 }), " ab");
  assert.equal(typedSince({ buffer: "git co", cursor: 6 }, { buffer: "git c", cursor: 5 }), null);
  assert.equal(typedSince({ buffer: "git co", cursor: 6 }, { buffer: "xgit co", cursor: 7 }), null);
});

test("the word starts after the last unescaped space or separator", () => {
  assert.equal(wordStart("git checkout fe", 15), 13);
  assert.equal(wordStart("ls my\\ fi", 9), 3);
  assert.equal(wordStart("a|bc", 4), 2);
  assert.equal(wordStart("git checkout fe xyz", 15), 13);
  assert.equal(wordStart("", 0), 0);
});

test("arrows, ctrl-n/ctrl-p and page keys move the selection; other keys don't", () => {
  assert.equal(completionMove("down", 11), 1);
  assert.equal(completionMove("ctrl+n", 11), 1);
  assert.equal(completionMove("up", 11), -1);
  assert.equal(completionMove("ctrl+p", 11), -1);
  assert.equal(completionMove("pagedown", 11), 11);
  assert.equal(completionMove("pageup", 11), -11);
  assert.equal(completionMove("n", 11), null);
  assert.equal(completionMove("ctrl+shift+n", 11), null);
});

test("the selection wraps on single steps and stops at the ends on pages", () => {
  assert.equal(moveSelection(3, -1, 0), 0);
  assert.equal(moveSelection(3, 0, 1), 1);
  assert.equal(moveSelection(3, 2, 1), 0);
  assert.equal(moveSelection(3, 0, -1), 2);
  assert.equal(moveSelection(3, 0, 9), 2);
  assert.equal(moveSelection(3, 2, -9), 0);
  assert.equal(moveSelection(0, -1, 1), -1);
});

test("scrolling moves the least needed to show the selection", () => {
  assert.equal(scrollTop(0, 5, 10, 30), 0);
  assert.equal(scrollTop(0, 12, 10, 30), 3);
  assert.equal(scrollTop(15, 11, 10, 30), 11);
  assert.equal(scrollTop(15, 25, 10, 30), 16);
  assert.equal(scrollTop(25, 29, 10, 30), 20);
  assert.equal(scrollTop(0, 2, 10, 4), 0);
});

const place = (zoom, caret, rows, extra = {}) =>
  popupPlacement({
    caret,
    cell: { width: 10 * zoom, height: 20 * zoom },
    pane: { width: 1000, height: 600 },
    width: 300 * zoom,
    rowHeight: 22 * zoom,
    chrome: 10 * zoom,
    rows,
    ...extra,
  });

test("the popup's top-left corner sits at the caret cell, flips above near the bottom and shifts left only at the right edge, at any zoom", () => {
  for (const zoom of [1, 1.5, 2]) {
    const rowsInPane = Math.floor(600 / (20 * zoom));
    const below = place(zoom, { row: 2, col: 7 }, 5);
    assert.deepEqual([below.left, below.top, below.side, below.visible], [70 * zoom, 60 * zoom, "below", 5], `below at ${zoom}x`);
    const last = rowsInPane - 1;
    const above = place(zoom, { row: last, col: 7 }, 5);
    assert.equal(above.side, "above", `above at ${zoom}x`);
    assert.equal(above.top + above.height, last * 20 * zoom, `ends on the row above the caret at ${zoom}x`);
    const edge = place(zoom, { row: 2, col: Math.floor(1000 / (10 * zoom)) - 2 }, 5);
    assert.equal(edge.left, 1000 - 300 * zoom, `right edge at ${zoom}x`);
  }
});

test("when the popup fits on neither side, as in a zoomed-in pane, it takes the roomier side with fewer rows and never covers the caret", () => {
  const tight = place(2, { row: 1, col: 5 }, 12);
  assert.equal(tight.side, "below");
  assert.equal(tight.top, 80);
  assert.ok(tight.top + tight.height <= 600);
  assert.equal(tight.visible, Math.floor((600 - 80 - 20) / 44));
  const low = place(2, { row: 13, col: 5 }, 12);
  assert.equal(low.side, "above");
  assert.ok(low.top >= 0 && low.top + low.height <= 13 * 40);
  assert.equal(place(2, { row: 0, col: 0 }, 12, { pane: { width: 1000, height: 40 } }).visible, 1);
});


test("history lines come out of the marker as whole-line rows, newline and all", () => {
  const list = parseCompletions(marker({ groups: [], items: [], history: ["gcow -b px-shell", "gco a;b", "for x\nin y"] }));
  assert.deepEqual(
    list.history.map(({ index, history, word, label }) => [index, history, word, label]),
    [
      [1, true, "gcow -b px-shell", "gcow -b px-shell"],
      [2, true, "gco a;b", "gco a;b"],
      [3, true, "for x\nin y", "for x ⏎ in y"],
    ],
  );
});

test("typing narrows the history rows the way up-arrow matches: lines that start with, and are longer than, the text left of the cursor", () => {
  const list = parseCompletions(marker({ groups: [], items: [], history: ["git checkout main", "git cherry-pick abc", "git ch"] }));
  assert.deepEqual(historyRows(list, "git ch").map((i) => i.word), ["git checkout main", "git cherry-pick abc"]);
  assert.deepEqual(historyRows(list, "git che").map((i) => i.word), ["git checkout main", "git cherry-pick abc"]);
  assert.deepEqual(historyRows(list, "git chec").map((i) => i.word), ["git checkout main"]);
  assert.deepEqual(historyRows(list, "Git").map((i) => i.word), []);
});

test("completions rank an exact match first, then by how often history used them there, the more recent first on a tie, then zsh's order", () => {
  const list = parseCompletions(
    marker({
      groups: [{ tag: "commands", prefix: "gco" }],
      items: ["gcomm", "gcore", "gcov", "gco", "gcow", "gcof"].map((word) => ({ word, group: 1 })),
      used: ["gcow", "gcof", "gcow", "gcomm"],
    }),
  );
  assert.deepEqual(labels(completionRows(list)), ["gco", "gcow", "gcof", "gcomm", "gcore", "gcov"]);
});

test("a directory used with its slash in history counts as used", () => {
  const list = parseCompletions(marker({ groups: [{ tag: "directories" }], items: [{ word: "alpha", group: 1, kind: "/" }, { word: "beta", group: 1, kind: "/" }], used: ["beta/"] }));
  assert.deepEqual(labels(completionRows(list)), ["beta/", "alpha/"]);
});

test("pxsh's copy of the history gives the same rows as zsh's up-arrow walk", () => {
  const cache = new HistoryCache();
  ["gcow -b old", "git status", "gcow -b px-shell", "gcow -b old", "gco"].forEach((line, i) => cache.add(i + 1, line));
  assert.deepEqual(cache.upArrow("gco", "gco"), ["gcow -b old", "gcow -b px-shell"]);
  assert.deepEqual(cache.upArrow("gcow", "gcow -b old"), ["gcow -b px-shell", "gcow -b old"]);
  assert.deepEqual(cache.upArrow("", ""), ["gco", "gcow -b old", "gcow -b px-shell", "git status"]);
});

test("the history copy fills newest first in chunks, takes each new command, and knows when it has everything", () => {
  const cache = new HistoryCache();
  assert.equal(cache.next(), 0);
  cache.addChunk({ newest: 10, oldest: 1, lines: ["ten", "nine", "", "seven"] });
  assert.equal(cache.next(), 7);
  cache.addChunk({ newest: 6, oldest: 1, lines: ["six", "five", "four", "three", "two", "one"] });
  assert.equal(cache.next(), null);
  cache.add(11, "eleven");
  cache.add(11, "eleven again");
  assert.equal(cache.size, 10);
  assert.deepEqual(cache.upArrow("e", ""), ["eleven again"]);
});

test("a popup still filling in stays on the side it opened on", () => {
  const above = place(1, { row: 20, col: 7 }, 2, { side: "above" });
  assert.deepEqual([above.top, above.visible], [400 - 54, 2]);
  const below = place(1, { row: 2, col: 7 }, 40, { side: "below" });
  assert.deepEqual([below.top, below.visible], [60, Math.floor((540 - 10) / 22)]);
});
