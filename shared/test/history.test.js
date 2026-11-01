const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-history-data-"));

const { addHistoryVisit, deleteAllHistory, deleteHistoryRange, deleteHistoryUrlInRange, historyEntry } = require("../dist/index.js");

test("deleting a typed visit lowers the typed count", () => {
  deleteAllHistory();
  const url = "https://typed.example/";
  addHistoryVisit({ url, transition: "typed", time: 1000 });
  addHistoryVisit({ url, transition: "link", time: 2000 });
  addHistoryVisit({ url, transition: "typed", time: 3000 });
  assert.equal(historyEntry(url).typedCount, 2);

  deleteHistoryUrlInRange(url, 0, 1500);
  assert.deepEqual(
    { visits: historyEntry(url).visitCount, typed: historyEntry(url).typedCount, last: historyEntry(url).lastVisitTime },
    { visits: 2, typed: 1, last: 3000 },
  );

  deleteHistoryRange(2500, 4000);
  assert.deepEqual({ visits: historyEntry(url).visitCount, typed: historyEntry(url).typedCount }, { visits: 1, typed: 0 });

  assert.deepEqual(deleteHistoryRange(0, 4000), [url]);
  assert.equal(historyEntry(url), null);
});
