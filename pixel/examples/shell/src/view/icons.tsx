import { Fragment, useState } from "react";
import type { ReactNode } from "react";

import { Box, Path, Text } from "@zenbu-labs/pixel";

import { iconPath } from "./lucide";
import type { LucideIconName } from "./lucide";

type IconName = LucideIconName | "stop";

export function Icon(props: { name: IconName; size: number; color: string }) {
  const { size } = props;
  if (props.name === "stop") return <FilledSquare size={size} color={props.color} />;
  return (
    <Path
      d={iconPath(props.name)}
      viewBox={24}
      stroke={{ width: 2, color: props.color, cap: "round", join: "round" }}
      style={{ width: size, height: size, flexShrink: 0 }}
    />
  );
}

function FilledSquare(props: { size: number; color: string }) {
  const { size } = props;
  const side = (size * 18) / 24;
  return (
    <Box style={{ width: size, height: size, flexShrink: 0, alignItems: "center", justifyContent: "center" }}>
      <Box style={{ width: side, height: side, cornerRadius: size / 12, background: props.color }} />
    </Box>
  );
}

export function IconButton(props: { name: IconName; size: number; color: string; hoverColor: string; hoverBackground: string; scale: number; onClick(): void }) {
  const [hovered, setHovered] = useState(false);
  const pad = 3 * props.scale;
  return (
    <Box
      style={{ padding: { left: pad, right: pad, top: pad, bottom: pad }, cornerRadius: 4 * props.scale, hoverBackground: props.hoverBackground }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => props.onClick()}
    >
      <Icon name={props.name} size={props.size} color={hovered ? props.hoverColor : props.color} />
    </Box>
  );
}

const KEY_ICONS: Record<string, IconName> = {
  "⌘": "command",
  "⇧": "shift",
  "⏎": "enter",
};

export function Keys(props: { keys: string; fontSize: number; color: string }) {
  const parts: ReactNode[] = [];
  let text = "";
  const flush = () => {
    if (text === "") return;
    parts.push(<Text style={{ color: props.color, fontSize: props.fontSize }}>{text}</Text>);
    text = "";
  };
  for (const char of props.keys) {
    const icon = KEY_ICONS[char];
    if (!icon) {
      text += char;
      continue;
    }
    flush();
    parts.push(<Icon name={icon} size={Math.round(props.fontSize * 0.95)} color={props.color} />);
  }
  flush();
  return (
    <Box style={{ flexDirection: "row", alignItems: "center", gap: Math.round(props.fontSize * 0.15) }}>
      {parts.map((part, i) => (
        <Fragment key={i}>{part}</Fragment>
      ))}
    </Box>
  );
}
