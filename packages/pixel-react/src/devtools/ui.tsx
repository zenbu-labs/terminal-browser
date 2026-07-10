import React from "react";

import { Box, Text } from "../components";
import { theme } from "./theme";

export function Button(props: {
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  rem: number;
}) {
  const { label, onClick, active, danger, rem } = props;
  return (
    <Box
      style={{
        padding: { left: rem * 0.5, right: rem * 0.5, top: rem * 0.15, bottom: rem * 0.15 },
        cornerRadius: rem * 0.25,
        background: active ? theme.accentDim : undefined,
        hoverBackground: active ? theme.accentDim : theme.hover,
        border: active ? { width: 1, color: theme.accent } : { width: 1, color: theme.border },
      }}
      onClick={onClick}
    >
      <Text
        style={{
          color: danger ? theme.danger : active ? theme.accent : theme.text,
          fontSize: rem * 0.75,
          wrap: false,
        }}
      >
        {label}
      </Text>
    </Box>
  );
}

export function Chip(props: {
  label: string;
  onClick?: () => void;
  active?: boolean;
  color?: string;
  rem: number;
}) {
  const { label, onClick, active, color, rem } = props;
  return (
    <Box
      style={{
        padding: { left: rem * 0.4, right: rem * 0.4, top: rem * 0.08, bottom: rem * 0.08 },
        cornerRadius: rem * 0.5,
        background: active ? theme.accentDim : theme.chrome,
        hoverBackground: onClick ? theme.chromeActive : undefined,
      }}
      onClick={onClick}
    >
      <Text
        style={{
          color: color ?? (active ? theme.accent : theme.dim),
          fontSize: rem * 0.68,
          wrap: false,
        }}
      >
        {label}
      </Text>
    </Box>
  );
}

export function Toolbar(props: { rem: number; children?: React.ReactNode }) {
  return (
    <Box
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: props.rem * 0.4,
        padding: props.rem * 0.35,
        background: theme.panel,
        border: { width: 0, color: theme.border },
        flexShrink: 0,
      }}
    >
      {props.children}
    </Box>
  );
}

export function Divider() {
  return <Box style={{ height: 1, background: theme.border, flexShrink: 0 }} />;
}

export function Empty(props: { text: string; rem: number }) {
  return (
    <Box
      style={{
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        padding: props.rem,
      }}
    >
      <Text style={{ color: theme.faint, fontSize: props.rem * 0.8 }}>{props.text}</Text>
    </Box>
  );
}
