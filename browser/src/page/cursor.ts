const CSS_CURSORS = new Set([
  "default", "crosshair", "text", "wait", "help", "progress",
  "cell", "vertical-text", "context-menu", "alias", "copy", "move",
  "no-drop", "not-allowed", "grab", "grabbing", "zoom-in", "zoom-out",
  "e-resize", "n-resize", "ne-resize", "nw-resize", "s-resize", "se-resize",
  "sw-resize", "w-resize", "ns-resize", "ew-resize", "nesw-resize",
  "nwse-resize", "col-resize", "row-resize",
]);

export function cursorShapeFor(type: string): string {
  // chromium's "pointer" is the plain arrow; its css pointer is "hand"
  if (type === "hand") return "pointer";
  if (CSS_CURSORS.has(type)) return type;
  if (type === "nodrop") return "no-drop";
  if (type.endsWith("-panning")) return "all-scroll";
  // pointer, custom, none, null, …
  return "default";
}
