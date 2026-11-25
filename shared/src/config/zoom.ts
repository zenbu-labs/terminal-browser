export const MIN_PAGE_ZOOM = 0.25;
export const MAX_PAGE_ZOOM = 5;
export const PAGE_ZOOM_RANGE = `a factor or percent between ${MIN_PAGE_ZOOM * 100}% and ${MAX_PAGE_ZOOM * 100}%`;

export function parsePageZoom(raw: string | null): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(%?)\s*$/.exec(raw ?? "");
  if (!match) return null;
  const factor = match[2] ? Number(match[1]) / 100 : Number(match[1]);
  return factor >= MIN_PAGE_ZOOM && factor <= MAX_PAGE_ZOOM ? factor : null;
}
