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
  reload: `${arcPath(12, 12, 7, 0, 270)} C 13.96 5 15.83 5.78 17.24 7.13 L 19 8.89 M 19 5 L 19 8.89 L 15.11 8.89`,
  search: `${arcPath(11, 11, 5.75, 0, 360)} M 15.4 15.4 L 19.25 19.25`,
  download: "M 12 4.5 L 12 14.5 M 7.75 10.5 L 12 14.75 L 16.25 10.5 M 5.5 18.5 L 18.5 18.5",
  cursor: "M 6.5 4.5 L 18 11.8 L 12.6 13.2 L 10.2 19 Z",
  pen: "M 4.5 19.5 L 8.2 18.6 L 18.8 8 L 16 5.2 L 5.4 15.8 L 4.5 19.5 Z",
  arrow: "M 6 18 L 17.5 6.5 M 10.5 6 L 18 6 L 18 13.5",
  oval: arcPath(12, 12, 7.5, 0, 360),
  text: "M 5.5 6 L 18.5 6 M 12 6 L 12 19",
  crop: "M 7 3 L 7 17 L 21 17 M 3 7 L 17 7 L 17 21",
  record: arcPath(12, 12, 4.5, 0, 360),
  play: "M 9 6.5 L 17.5 12 L 9 17.5 Z",
  bolt: "M 13.2 3.5 L 6.5 13.5 L 11.2 13.5 L 10.4 20.5 L 17.5 10.2 L 12.4 10.2 Z",
  camera:
    "M 4 8.2 L 8.3 8.2 L 9.8 6 L 14.2 6 L 15.7 8.2 L 20 8.2 L 20 18 L 4 18 Z " +
    arcPath(12, 12.9, 3.1, 0, 360),
  pause: "M 9.2 6.8 L 9.2 17.2 M 14.8 6.8 L 14.8 17.2",
  terminal:
    "M 5 3 L 19 3 C 20.104 3 21 3.896 21 5 L 21 19 C 21 20.104 20.104 21 19 21 " +
    "L 5 21 C 3.896 21 3 20.104 3 19 L 3 5 C 3 3.896 3.896 3 5 3 Z " +
    "M 7 11 L 9 9 L 7 7 M 11 13 L 15 13",
  shield: "M 12 3.5 L 19 6.3 L 19 11.6 C 19 15.7 16.1 18.9 12 20.5 C 7.9 18.9 5 15.7 5 11.6 L 5 6.3 Z",
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
