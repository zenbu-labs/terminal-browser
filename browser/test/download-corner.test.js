const assert = require("node:assert/strict");
const { test } = require("node:test");

const { DownloadCorner } = require("../dist/session/download-corner.js");

function record(id, extra = {}) {
  return {
    id, url: `https://a.test/${id}`, finalUrl: "", filename: `/dl/file-${id}`, mime: "", startTime: 0, endTime: null,
    state: "in_progress", error: null, paused: false, totalBytes: 100, receivedBytes: 0, byExtensionId: null, danger: "safe",
    ...extra,
  };
}

test("a held dangerous download stays in the corner while another download makes progress", () => {
  const corner = new DownloadCorner();
  assert.equal(corner.changed(record(1, { receivedBytes: 10 })).id, 1);
  const held = corner.changed(record(2, { danger: "file", receivedBytes: 100 }));
  assert.deepEqual([held.id, held.dangerous], [2, true]);
  for (const received of [40, 70, 100]) assert.equal(corner.changed(record(1, { receivedBytes: received })).id, 2);
  assert.equal(corner.changed(record(1, { state: "complete", receivedBytes: 100 })).id, 2);
});

test("the next held download comes forward once the first is discarded, then the corner frees up", () => {
  const corner = new DownloadCorner();
  corner.changed(record(1, { danger: "file" }));
  corner.changed(record(2, { danger: "file" }));
  assert.equal(corner.changed(record(3)).id, 1);
  assert.equal(corner.erased(1).id, 2);
  assert.equal(corner.erased(2), null);
  assert.equal(corner.changed(record(3, { receivedBytes: 50 })).percent, 50);
});

test("a kept download leaves the front and shows as saved", () => {
  const corner = new DownloadCorner();
  corner.changed(record(1, { danger: "file" }));
  const kept = corner.changed(record(1, { danger: "accepted", state: "complete", receivedBytes: 100 }));
  assert.deepEqual([kept.id, kept.dangerous, kept.state], [1, false, "done"]);
  assert.equal(corner.changed(record(2)).id, 2);
});
