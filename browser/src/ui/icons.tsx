import { Path } from "pixel-react";
import type { Rgba } from "pixel-react";

function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): string {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const segments = Math.max(1, Math.ceil(Math.abs(toDeg - fromDeg) / 90));
  const step = (rad(toDeg) - rad(fromDeg)) / segments;
  const k = (4 / 3) * Math.tan(step / 4);
  const n = (value: number) => Number(value.toFixed(3));
  const px = (t: number) => cx + r * Math.cos(t);
  const py = (t: number) => cy + r * Math.sin(t);
  let a = rad(fromDeg);
  let path = `M ${n(px(a))} ${n(py(a))}`;
  for (let i = 0; i < segments; i++) {
    const b = a + step;
    path +=
      ` C ${n(px(a) - k * r * Math.sin(a))} ${n(py(a) + k * r * Math.cos(a))}` +
      ` ${n(px(b) + k * r * Math.sin(b))} ${n(py(b) - k * r * Math.cos(b))}` +
      ` ${n(px(b))} ${n(py(b))}`;
    a = b;
  }
  return path;
}

export const ICONS = {
  back: "M 14.5 5.5 L 8 12 L 14.5 18.5",
  forward: "M 9.5 5.5 L 16 12 L 9.5 18.5",
  close: "M 7 7 L 17 17 M 17 7 L 7 17",
  plus: "M 12 5.5 L 12 18.5 M 5.5 12 L 18.5 12",
  reload: `${arcPath(12, 12, 6.5, 0, 315)} M 15.77 4.31 L 16.6 7.4 L 13.51 6.57`,
  search: `${arcPath(11, 11, 5.75, 0, 360)} M 15.4 15.4 L 19.25 19.25`,
  download: "M 12 4.5 L 12 14.5 M 7.75 10.5 L 12 14.75 L 16.25 10.5 M 5.5 18.5 L 18.5 18.5",
};

export type IconName = keyof typeof ICONS;

export function Icon({
  icon,
  size,
  color,
  weight = 2.2,
}: {
  icon: IconName;
  size: number;
  color: Rgba;
  weight?: number;
}) {
  return (
    <Path
      d={ICONS[icon]}
      viewBox={24}
      stroke={{ width: weight, color, cap: "round", join: "round" }}
      style={{ width: size, height: size, flexShrink: 0 }}
    />
  );
}
