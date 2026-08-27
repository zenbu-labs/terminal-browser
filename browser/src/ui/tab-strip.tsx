import { useEffect, useRef, useState } from "react";
import { Box, Image, Text } from "pixel-react";
import type { BrowserState } from "../page/types";
import { displayUrl } from "../url";
import { Icon } from "./icons";
import type { Theme } from "./theme";
import type { ChromeActions, TabRow } from "./types";

interface TabEntry {
  tab: TabRow;
  width: number;
  ghost: boolean;
}

function useAnimatedTabs(tabs: TabRow[], targetFor: (tab: TabRow) => number): TabEntry[] {
  const ref = useRef<{
    entries: Map<number, TabEntry>;
    order: number[];
    timer: ReturnType<typeof setInterval> | null;
    targetFor: (tab: TabRow) => number;
  }>({ entries: new Map(), order: [], timer: null, targetFor });
  const [, bump] = useState(0);
  const s = ref.current;
  s.targetFor = targetFor;
  const live = new Set(tabs.map((tab) => tab.id));
  for (const tab of tabs) {
    const entry = s.entries.get(tab.id);
    if (entry) {
      entry.tab = tab;
      entry.ghost = false;
    } else {
      s.entries.set(tab.id, { tab, width: 0, ghost: false });
      s.order.push(tab.id);
    }
  }
  for (const entry of s.entries.values()) {
    if (!live.has(entry.tab.id)) entry.ghost = true;
  }
  useEffect(() => {
    const settled = [...s.entries.values()].every(
      (entry) => entry.width === (entry.ghost ? 0 : s.targetFor(entry.tab)),
    );
    if (settled || s.timer) return;
    s.timer = setInterval(() => {
      let moving = false;
      for (const entry of s.entries.values()) {
        const target = entry.ghost ? 0 : s.targetFor(entry.tab);
        const delta = target - entry.width;
        if (Math.abs(delta) < 0.75) entry.width = target;
        else {
          entry.width += delta * 0.3;
          moving = true;
        }
      }
      for (const [id, entry] of s.entries) {
        if (entry.ghost && entry.width === 0) {
          s.entries.delete(id);
          s.order = s.order.filter((o) => o !== id);
        }
      }
      bump((n) => n + 1);
      if (!moving && s.timer) {
        clearInterval(s.timer);
        s.timer = null;
      }
    }, 16);
  });
  useEffect(
    () => () => {
      if (s.timer) clearInterval(s.timer);
    },
    [],
  );
  return s.order
    .map((id) => s.entries.get(id))
    .filter((entry): entry is TabEntry => entry != null);
}

export function TabStrip({
  tabs,
  state,
  actions,
  rem,
  theme,
}: {
  tabs: TabRow[];
  state: BrowserState;
  actions: ChromeActions;
  rem: number;
  theme: Theme;
}) {
  const single = tabs.length <= 1;
  const [hovered, setHovered] = useState<number | null>(null);
  const activeLabel = displayUrl(state.url);
  const label = (tab: TabRow) =>
    tab.app ? tab.title || "app" : tab.active ? activeLabel : tab.title || "new tab";
  const charW = rem * 0.82 * 0.6;
  const closeW = rem * 1.25;
  const closeGap = rem * 0.25;
  const entries = useAnimatedTabs(tabs, (tab) => {
    let width = rem * 1.4 + Math.min(label(tab).length, 28) * charW;
    if (tab.favicon) width += rem * 0.85 + rem * 0.35;
    if (tab.active) width += closeW + rem * 0.35;
    width += closeW + closeGap + rem * 0.35;
    return Math.round(width);
  });
  return (
    <Box
      style={{
        flexGrow: 1,
        flexBasis: 0,
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
        gap: rem * 0.25,
        padding: { left: rem * 0.4, right: rem * 0.4 },
        overflow: "hidden",
      }}
    >
      {entries.map(({ tab, width, ghost }) => (
        <Box
          key={tab.id}
          style={{
            width: Math.round(width),
            height: rem * 1.5,
            alignItems: "center",
            justifyContent: "center",
            gap: rem * 0.35,
            padding: { left: rem * 0.7, right: rem * 0.7 },
            cornerRadius: rem * 0.75,
            background: tab.active && !ghost && !single ? theme.field : undefined,
            hoverBackground: ghost ? undefined : theme.hover,
            flexShrink: 1,
            overflow: "hidden",
          }}
          onClick={() =>
            tab.active && !tab.app ? actions.urlEdit() : actions.tabSwitch(tab.id)
          }
          onMouseEnter={() => setHovered(tab.id)}
          onMouseLeave={() => setHovered((id) => (id === tab.id ? null : id))}
        >
          {tab.favicon ? (
            <Image
              src={tab.favicon}
              style={{
                width: rem * 0.85,
                height: rem * 0.85,
                cornerRadius: rem * 0.15,
                flexShrink: 0,
              }}
            />
          ) : null}
          <Text
            style={{
              fontSize: rem * 0.82,
              color: tab.active && !ghost ? theme.fg : theme.muted,
              wrap: false,
              selectable: false,
              flexShrink: 1,
              overflow: "hidden",
            }}
          >
            {ghost ? tab.title || "new tab" : label(tab)}
          </Text>
          {hovered === tab.id && !ghost ? (
            <Box
              style={{
                width: closeW,
                height: closeW,
                alignItems: "center",
                justifyContent: "center",
                margin: { left: closeGap },
                cornerRadius: closeW / 2,
                hoverBackground: theme.hoverStrong,
                flexShrink: 0,
              }}
              onClick={() => actions.tabClose(tab.id)}
            >
              <Icon icon="close" size={rem * 0.9} color={theme.muted} />
            </Box>
          ) : (
            <Box style={{ width: closeW, height: closeW, margin: { left: closeGap }, flexShrink: 0 }} />
          )}
        </Box>
      ))}
      <Box
        style={{
          width: rem * 1.3,
          height: rem * 1.3,
          alignItems: "center",
          justifyContent: "center",
          cornerRadius: rem * 0.65,
          hoverBackground: theme.hover,
          flexShrink: 0,
        }}
        onClick={actions.tabNew}
      >
        <Icon icon="plus" size={rem * 1} color={theme.muted} />
      </Box>
    </Box>
  );
}
