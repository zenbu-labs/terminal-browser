import assert from "node:assert";
import { computeLayout } from "./layout";
import type { EngineInfo } from "pixel-react";

// Test: Verify computeLayout behaves deterministically across different scale factors (1x vs 2x)
const baseInfo: EngineInfo = {
  width: 1600,
  height: 800,
  basePx: 16,
  cellWidth: 8,
  cellHeight: 16,
  colors: {
    foreground: [255, 255, 255, 255],
    background: [0, 0, 0, 255],
    palette: [],
  },
  kittyKeyboard: false,
};

// On 1x display (scale = 1)
const layout1x = computeLayout(baseInfo, 1, false, false, null);
assert.strictEqual(layout1x.surface.scale, 1);
assert.strictEqual(layout1x.surface.width, 1590); // ~1600 minus pad
assert.strictEqual(layout1x.surface.height, 763);

// On 2x display (scale = 2)
const layout2x = computeLayout(baseInfo, 2, false, false, null);
assert.strictEqual(layout2x.surface.scale, 2);
assert.strictEqual(layout2x.surface.width, 1590);
assert.strictEqual(layout2x.surface.height, 762);

console.log("computeLayout test passed!");
