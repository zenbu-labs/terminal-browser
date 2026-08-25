import assert from "node:assert";

// Simulation of Session's displayScale management
class MockSession {
  displayScale: number;
  layoutScale: number;
  private env: Record<string, string>;
  private mockCursorScale: number;

  constructor(env: Record<string, string>, initialCursorScale: number) {
    this.env = env;
    this.mockCursorScale = initialCursorScale;
    this.displayScale = this.hostDisplayScale();
    this.layoutScale = this.displayScale;
  }

  hostDisplayScale() {
    const explicit = Number(this.env.TERMINAL_BROWSER_DISPLAY_SCALE);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    return this.mockCursorScale;
  }

  // Current session.tsx behavior: no display change handler, onResize doesn't update displayScale
  onResizeCurrent() {
    // Current behavior in session.tsx:
    // this.followCellZoom();
    // this.recalculateLayout(); // uses this.displayScale (stale!)
    this.layoutScale = this.displayScale;
  }

  // Desired behavior: updates displayScale when screen metrics or display changes
  onResizeFixed() {
    const newScale = this.hostDisplayScale();
    if (newScale !== this.displayScale) {
      this.displayScale = newScale;
    }
    this.layoutScale = this.displayScale;
  }

  moveDisplay(newScale: number) {
    this.mockCursorScale = newScale;
  }
}

// Test Current Behavior vs Fixed Behavior:
console.log("Running Phase 1 reproduction test for display scale tracking...");

// 1. Start on 1x display
const session = new MockSession({}, 1);
assert.strictEqual(session.displayScale, 1, "Initial scale should be 1");
assert.strictEqual(session.layoutScale, 1, "Initial layout scale should be 1");

// 2. User moves window to 2x small Retina display
session.moveDisplay(2);

// 3. User resizes or screen metrics change
session.onResizeCurrent();

// ASSERTION THAT GOES RED ON CURRENT CODE:
try {
  assert.strictEqual(session.layoutScale, 2, "FAIL: layoutScale remained stale at 1 when moved to 2x display!");
  console.log("Unexpected: current code passed?");
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.log("REPRODUCED (RED):", msg);
}

// 4. Verify fixed behavior
session.onResizeFixed();
assert.strictEqual(session.layoutScale, 2, "PASS: layoutScale successfully updated to 2 on 2x display");
console.log("Verified: fixed behavior works!");
