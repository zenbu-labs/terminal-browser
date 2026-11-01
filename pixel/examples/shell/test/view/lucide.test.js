const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { LUCIDE_ICONS, iconPath, lucideSvgAsSimplePath } = require("../../dist/view/lucide.js");

const ONLY_M_L_C_Z = /^(?:[MLCZ](?: -?\d+(?:\.\d+)?)*)(?: [MLCZ](?: -?\d+(?:\.\d+)?)*)*$/;

test("every icon pxsh draws is path data of only absolute M, L, C and Z commands and plain numbers", () => {
  for (const name of LUCIDE_ICONS) assert.match(iconPath(name), ONLY_M_L_C_Z, name);
});

test("every Lucide icon converts, whatever shapes and path commands it is made of", () => {
  const dir = path.dirname(require.resolve("lucide-static/icons/x.svg"));
  const files = fs.readdirSync(dir).filter((file) => file.endsWith(".svg"));
  assert.ok(files.length > 1000);
  for (const file of files) assert.match(lucideSvgAsSimplePath(fs.readFileSync(path.join(dir, file), "utf8")), ONLY_M_L_C_Z, file);
});

test("relative commands, H and V, implicit repeats and arcs come out as the same points", () => {
  assert.equal(iconPath("close"), "M 18 6 L 6 18 M 6 6 L 18 18");
  assert.equal(lucideSvgAsSimplePath('<path d="m2 2 3 0 0 3h-3v-3z"/>'), "M 2 2 L 5 2 L 5 5 L 2 5 L 2 2 Z");
  assert.equal(lucideSvgAsSimplePath('<path d="M0 0Q6 6 12 0T24 0"/>'), "M 0 0 C 4 4 8 4 12 0 C 16 -4 20 -4 24 0");
  assert.equal(lucideSvgAsSimplePath('<path d="M0 0S6 6 12 0"/>'), "M 0 0 C 0 0 6 6 12 0");
  assert.match(lucideSvgAsSimplePath('<path d="M4 12a8 8 0 0 0 16 0"/>'), /^M 4 12 (C [\d. -]+ )+?C [\d. -]+ 20 12$/);
});

test("circles, ellipses, rounded rects, lines, polylines and polygons become closed or open paths through their points", () => {
  assert.match(lucideSvgAsSimplePath('<circle cx="12" cy="12" r="10"/>'), /^M 2 12 (C [\d. -]+ )+C [\d. -]+ 2 12 Z$/);
  assert.match(lucideSvgAsSimplePath('<ellipse cx="12" cy="5" rx="9" ry="3"/>'), /^M 3 5 (C [\d. -]+ )+C [\d. -]+ 3 5 Z$/);
  assert.equal(lucideSvgAsSimplePath('<rect width="18" height="10" x="3" y="4"/>'), "M 3 4 L 21 4 L 21 14 L 3 14 Z");
  assert.match(lucideSvgAsSimplePath('<rect width="18" height="18" x="3" y="3" rx="2"/>'), /^M 5 3 L 19 3 C [\d. ]+ 21 5 L 21 19 C [\d. ]+ 19 21 L 5 21 C [\d. ]+ 3 19 L 3 5 C [\d. ]+ 5 3 Z$/);
  assert.equal(lucideSvgAsSimplePath('<line x1="2" x2="22" y1="12" y2="12"/>'), "M 2 12 L 22 12");
  assert.equal(lucideSvgAsSimplePath('<polyline points="22 12 18 12 15 21"/>'), "M 22 12 L 18 12 L 15 21");
  assert.equal(lucideSvgAsSimplePath('<polygon points="3 11 22 2 13 21 11 13 3 11"/>'), "M 3 11 L 22 2 L 13 21 L 11 13 L 3 11 Z");
});
