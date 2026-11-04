import type { RefObject } from "react";
import { useRect } from "@zenbu-labs/pixel";
import type { NodeHandle } from "@zenbu-labs/pixel";

export interface Anchor {
  // From the anchor's right edge to the chrome's right edge, which resizing the pane doesn't change.
  right: number;
  bottom: number;
}

// Where a toolbar button sits, measured against the chrome in the same layout pass.
// Null until both are measured: drawing an anchored surface before then puts it in
// the wrong place for a frame.
export function useAnchor(anchor: RefObject<NodeHandle | null>, chrome: RefObject<NodeHandle | null>): Anchor | null {
  const rect = useRect(anchor);
  const chromeRect = useRect(chrome);
  if (!anchor.current || !rect || !chromeRect) return null;
  return { right: chromeRect.x + chromeRect.width - (rect.x + rect.width), bottom: rect.y + rect.height };
}

// The left edge of a box `width` wide that lines up with the anchor's right edge,
// kept `margin` inside the chrome.
export function alignToAnchor(anchor: Anchor, width: number, chromeWidth: number, margin: number): number {
  return Math.round(Math.max(margin, Math.min(chromeWidth - anchor.right - width, chromeWidth - width - margin)));
}
