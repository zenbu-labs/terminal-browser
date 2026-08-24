import { screen } from "electron";
import { displayPointSize, setDisplayPointSize } from "pixel-store";

export type ScaleVerdict = {
  scale: number;
  kind: "display" | "font";
  why: string;
};

/**
 * Tracks the pixel density of the display the terminal is actually on.
 *
 * An offscreen window's deviceScaleFactor is fixed when the window is built,
 * and `layout.scale` has to keep matching it or the painted frame stops
 * matching the surface. So we keep both, and express the difference as a page
 * zoom factor:
 *
 *     correction = effective / built
 *
 * Chromium computes `devicePixelRatio` as deviceScaleFactor x zoomFactor and
 * divides the CSS viewport by the zoom, so a corrected page ends up with the
 * viewport and the devicePixelRatio of the display it is really shown on, with
 * no window rebuild and no lost page state.
 */
export class DisplayScale {
  private built = 1;
  private effective = 1;
  /** the terminal's base cell metric in points, which a monitor move leaves alone */
  private point = 0;

  /** the scale the offscreen windows were, and stay, built with */
  start(scale: number, basePx: number): void {
    this.built = scale;
    this.effective = scale;
    this.point = basePx / scale;
  }

  get current(): number {
    return this.effective;
  }

  get pointSize(): number {
    return this.point;
  }

  correction(): number {
    const value = this.effective / this.built;
    if (!Number.isFinite(value) || value <= 0) return 1;
    return Math.min(8, Math.max(0.125, value));
  }

  /**
   * Work out the scale to build with, now that basePx is known.
   *
   * hostDisplayScale() has to guess, because it runs before the engine exists.
   * It samples the display under the mouse cursor, and the cursor is often not
   * where the window is. Getting it wrong is worse than any later mistake,
   * because the point size everything else is measured against is derived from
   * it: a session opened on a 2x panel while the cursor sat on a 1x monitor
   * recorded a 26.32pt cell, and then read every monitor move as a font change.
   *
   * This runs before the layout is computed and before any offscreen window is
   * built, so the scale the windows are built with ends up right.
   */
  startScale(basePx: number, cursorGuess: number): { scale: number; why: string; sure: boolean } {
    const attached = this.known();
    if (attached.length === 1) return { scale: attached[0], why: "single display", sure: true };
    if (!(basePx > 0) || attached.length === 0) {
      return { scale: cursorGuess, why: "no basePx", sure: false };
    }
    const remembered = displayPointSize();
    if (remembered > 0) {
      let best: number | null = null;
      let bestError = Infinity;
      for (const scale of attached) {
        const value = Math.abs(basePx / scale - remembered) / remembered;
        if (value < bestError) {
          bestError = value;
          best = scale;
        }
      }
      if (best != null && bestError <= 0.15) {
        return { scale: best, why: `remembered ${remembered.toFixed(2)}pt`, sure: true };
      }
    }
    // No memory yet. A terminal cell is between about 8 and 24 points tall, so
    // a scale implying anything outside that range is the wrong one.
    const plausible = attached.filter((scale) => basePx / scale >= 8 && basePx / scale <= 24);
    if (plausible.length === 1) {
      return { scale: plausible[0], why: "only plausible cell size", sure: true };
    }
    return { scale: cursorGuess, why: "cursor guess", sure: false };
  }

  /** keep the point size, so the next session does not have to guess at all */
  learn(): void {
    setDisplayPointSize(this.point);
  }

  /**
   * Decide what a change in the terminal's base cell metric means.
   *
   * The pane size is not a usable signal. macOS resizes a window when it moves
   * between monitors, so the pane and the cell rarely move by the same factor;
   * on a measured Retina-to-1x move the cell went to 0.52x while the pane went
   * to 0.79x, which is why followCellZoom read it as a font change. What holds
   * still is the cell size in POINTS, because basePx tracks the physical cell:
   *
   *   built-in Retina   basePx 26.32  at scale 2  ->  13.16 pt
   *   DELL U3415W       basePx 13.59  at scale 1  ->  13.59 pt
   *
   * Reading 13.59 while we believe we are at scale 2 implies 6.79 pt, 48% away
   * from the remembered 13.16. Scale 1 implies 13.59 pt, 3% away. Only a
   * near-exact fit at a different scale counts, so a large font change is not
   * mistaken for a monitor move.
   */
  classify(basePx: number): ScaleVerdict {
    const current = this.effective;
    const scales = this.known();
    if (scales.length === 1 && scales[0] !== current) {
      return { scale: scales[0], kind: "display", why: "single display attached" };
    }
    if (!(this.point > 0) || !(basePx > 0)) {
      return { scale: current, kind: "font", why: "no point size yet" };
    }
    const error = (scale: number) => Math.abs(basePx / scale - this.point) / this.point;
    const currentError = error(current);
    if (currentError <= 0.25) {
      return { scale: current, kind: "font", why: `current off ${currentError.toFixed(3)}` };
    }
    let best = current;
    let bestError = currentError;
    for (const scale of scales) {
      const value = error(scale);
      if (value < bestError) {
        bestError = value;
        best = scale;
      }
    }
    if (best !== current && bestError <= 0.1) {
      return {
        scale: best,
        kind: "display",
        why: `${bestError.toFixed(3)} beats ${currentError.toFixed(3)}`,
      };
    }
    return { scale: current, kind: "font", why: `nothing beats ${currentError.toFixed(3)}` };
  }

  /** adopt the cell size the terminal now reports as the reference point size */
  remember(basePx: number, scale = this.effective): void {
    if (basePx > 0 && scale > 0) this.point = basePx / scale;
  }

  /** returns true when the value moved, so the caller knows to re-apply zoom */
  setEffective(scale: number): boolean {
    if (!Number.isFinite(scale) || scale <= 0) return false;
    if (Math.abs(scale - this.effective) < 1e-3) return false;
    this.effective = scale;
    return true;
  }

  /** every distinct scale factor the OS reports, so no monitor is hardcoded */
  known(): number[] {
    try {
      const seen = new Set<number>();
      for (const display of screen.getAllDisplays()) {
        if (Number.isFinite(display.scaleFactor) && display.scaleFactor > 0) {
          seen.add(display.scaleFactor);
        }
      }
      return [...seen].sort((a, b) => a - b);
    } catch {
      return [];
    }
  }
}
