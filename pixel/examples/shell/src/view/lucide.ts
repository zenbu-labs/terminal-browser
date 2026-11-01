import fs from "node:fs";

import svgpath from "svgpath";

const LUCIDE_NAMES = {
  close: "x",
  enter: "corner-down-left",
  command: "command",
  shift: "arrow-big-up",
  "chevron-right": "chevron-right",
  "chevron-down": "chevron-down",
  check: "check",
};

export type LucideIconName = keyof typeof LUCIDE_NAMES;

export const LUCIDE_ICONS = Object.keys(LUCIDE_NAMES) as LucideIconName[];

const SHAPE = /<(path|circle|ellipse|rect|line|polyline|polygon)\b([^>]*?)\/?>/g;
const ATTRIBUTE = /([\w-]+)="([^"]*)"/g;

const paths = new Map<LucideIconName, string>();

export function iconPath(name: LucideIconName): string {
  let d = paths.get(name);
  if (d == null) {
    d = lucideSvgAsSimplePath(fs.readFileSync(require.resolve(`lucide-static/icons/${LUCIDE_NAMES[name]}.svg`), "utf8"));
    paths.set(name, d);
  }
  return d;
}

export function lucideSvgAsSimplePath(svg: string): string {
  return [...svg.matchAll(SHAPE)].map(([, tag, attributes]) => simplePath(shapePath(tag, Object.fromEntries([...attributes.matchAll(ATTRIBUTE)].map(([, key, value]) => [key, value]))))).join(" ");
}

function shapePath(tag: string, attributes: Record<string, string>): string {
  const n = (key: string) => Number(attributes[key] ?? 0);
  switch (tag) {
    case "path":
      return attributes.d;
    case "line":
      return `M${n("x1")} ${n("y1")}L${n("x2")} ${n("y2")}`;
    case "polyline":
      return `M${attributes.points}`;
    case "polygon":
      return `M${attributes.points}Z`;
    case "circle":
      return ellipsePath(n("cx"), n("cy"), n("r"), n("r"));
    case "ellipse":
      return ellipsePath(n("cx"), n("cy"), n("rx"), n("ry"));
    default:
      return rectPath(n("x"), n("y"), n("width"), n("height"), attributes.rx ?? attributes.ry, attributes.ry ?? attributes.rx);
  }
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
}

function rectPath(x: number, y: number, width: number, height: number, rxText: string | undefined, ryText: string | undefined): string {
  const rx = Math.min(Number(rxText ?? 0), width / 2);
  const ry = Math.min(Number(ryText ?? 0), height / 2);
  if (!rx || !ry) return `M${x} ${y}H${x + width}V${y + height}H${x}Z`;
  const corner = (toX: number, toY: number) => `A${rx} ${ry} 0 0 1 ${toX} ${toY}`;
  return [
    `M${x + rx} ${y}H${x + width - rx}`,
    corner(x + width, y + ry),
    `V${y + height - ry}`,
    corner(x + width - rx, y + height),
    `H${x + rx}`,
    corner(x, y + height - ry),
    `V${y + ry}`,
    corner(x + rx, y),
    "Z",
  ].join("");
}

function simplePath(d: string): string {
  const parts: string[] = [];
  const add = (command: string, ...numbers: number[]) => parts.push([command, ...numbers.map((v) => String(Number(v.toFixed(3))))].join(" "));
  svgpath(d)
    .abs()
    .unarc()
    .unshort()
    .iterate((segment, _index, x, y) => {
      const [command, ...v] = segment as [string, ...number[]];
      if (command === "M" || command === "L" || command === "C") add(command, ...v);
      else if (command === "H") add("L", v[0], y);
      else if (command === "V") add("L", x, v[0]);
      else if (command === "Q") add("C", x + (2 / 3) * (v[0] - x), y + (2 / 3) * (v[1] - y), v[2] + (2 / 3) * (v[0] - v[2]), v[3] + (2 / 3) * (v[1] - v[3]), v[2], v[3]);
      else if (command.toUpperCase() === "Z") add("Z");
      else {
        // fixme: placeholder copy
        throw new Error(`no simple form for path command ${command}`);
      }
    });
  return parts.join(" ");
}
