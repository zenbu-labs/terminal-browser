import { useEffect, useRef, useState } from "react";
import { Box, Image, Text } from "pixel-react";
import { displayUrl } from "../url";
import { Icon } from "./icons";
import { usePulse } from "./pulse";
import { mix, withAlpha } from "./theme";
import type { Theme } from "./theme";
import type { ChromeActions, TabRow } from "./types";

const ANIM_MS = 200;
const easeOut = (t: number) => 1 - (1 - t) ** 3;

interface Entry {
  tab: TabRow;
  ghost: boolean;
  from: number;
  to: number;
  start: number;
}

function widthOf(entry: Entry, now: number): number {
  const t = (now - entry.start) / ANIM_MS;
  if (t >= 1) return entry.to;
  return entry.from + (entry.to - entry.from) * easeOut(Math.max(0, t));
}

function useCompactTabs(
  tabs: TabRow[],
  targetFor: (tab: TabRow) => number,
  pointerIn: { current: boolean },
): { entries: { tab: TabRow; width: number; ghost: boolean }[]; unfreeze: () => void } {
  const s = useRef({
    entries: new Map<number, Entry>(),
    order: [] as number[],
    frozen: null as Map<number, number> | null,
    lastActive: null as number | null,
    mounted: false,
    timer: null as ReturnType<typeof setInterval> | null,
  }).current;
  const [, bump] = useState(0);
  const now = Date.now();
  const live = new Set(tabs.map((tab) => tab.id));
  const activeId = tabs.find((tab) => tab.active)?.id ?? null;
  if (activeId !== s.lastActive) s.frozen = null;
  for (const tab of tabs) if (s.mounted && !s.entries.has(tab.id)) s.frozen = null;
  for (const entry of s.entries.values()) {
    if (live.has(entry.tab.id) || entry.ghost) continue;
    if (pointerIn.current && !s.frozen) {
      s.frozen = new Map(
        [...s.entries.values()]
          .filter((e) => !e.ghost && live.has(e.tab.id))
          .map((e) => [e.tab.id, widthOf(e, now)]),
      );
    }
    entry.ghost = true;
  }
  for (const tab of tabs) {
    const entry = s.entries.get(tab.id);
    if (entry) {
      entry.tab = tab;
      entry.ghost = false;
    } else {
      const target = targetFor(tab);
      s.entries.set(tab.id, {
        tab,
        ghost: false,
        from: s.mounted ? 0 : target,
        to: target,
        start: s.mounted ? now : now - ANIM_MS,
      });
      s.order.push(tab.id);
    }
  }
  s.mounted = true;
  s.lastActive = activeId;
  for (const entry of s.entries.values()) {
    const target = entry.ghost
      ? 0
      : s.frozen?.get(entry.tab.id) ?? targetFor(entry.tab);
    if (Math.round(target) !== Math.round(entry.to)) {
      entry.from = widthOf(entry, now);
      entry.to = target;
      entry.start = now;
    }
  }
  useEffect(() => {
    const settled = [...s.entries.values()].every(
      (entry) => !entry.ghost && widthOf(entry, Date.now()) === entry.to,
    );
    if (settled || s.timer) return;
    s.timer = setInterval(() => {
      const tick = Date.now();
      let moving = false;
      for (const [id, entry] of s.entries) {
        if (widthOf(entry, tick) !== entry.to) moving = true;
        else if (entry.ghost) {
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
  return {
    entries: s.order
      .map((id) => s.entries.get(id))
      .filter((entry): entry is Entry => entry != null)
      .map((entry) => ({
        tab: entry.tab,
        width: Math.round(widthOf(entry, now)),
        ghost: entry.ghost,
      })),
    unfreeze: () => {
      if (s.frozen) {
        s.frozen = null;
        bump((n) => n + 1);
      }
    },
  };
}

export function TabStrip({
  tabs,
  actions,
  rem,
  width,
  url,
  theme,
}: {
  tabs: TabRow[];
  actions: ChromeActions;
  rem: number;
  width: number;
  url: string;
  theme: Theme;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const activeLabel = displayUrl(url);
  const pointerIn = useRef(false);
  const dotPulse = usePulse(tabs.some((tab) => tab.agentControlled && !tab.active));
  const label = (tab: TabRow) =>
    tab.active && !tab.app
      ? activeLabel || tab.title || "new tab"
      : tab.title || (tab.app ? "app" : "new tab");
  const charW = rem * 0.82 * 0.6;
  const slotW = rem * 0.85;
  const padX = rem * 0.7;
  const innerGap = rem * 0.35;
  const gap = rem * 0.3;
  const avail = Math.max(0, width - rem * 1.55) - gap * tabs.length;
  const minInactive = padX * 2 + slotW;
  const capInactive = rem * 10;
  const minActive = Math.min(rem * 10, avail);
  const inactiveWidths = new Map<number, number>();
  let sum = 0;
  for (const tab of tabs) {
    if (tab.active) continue;
    const intrinsic =
      padX * 2 + slotW + innerGap + Math.min(label(tab).length, 24) * charW;
    const w = Math.min(Math.max(intrinsic, minInactive), capInactive);
    inactiveWidths.set(tab.id, w);
    sum += w;
  }
  const budget = avail - minActive;
  if (sum > budget && sum > 0) {
    const scale = budget / sum;
    sum = 0;
    for (const [id, w] of inactiveWidths) {
      const squeezed = Math.max(minInactive, w * scale);
      inactiveWidths.set(id, squeezed);
      sum += squeezed;
    }
  }
  const activeWidth = Math.max(rem * 4, Math.min(rem * 26, avail - sum));
  const { entries, unfreeze } = useCompactTabs(
    tabs,
    (tab) => (tab.active ? activeWidth : inactiveWidths.get(tab.id) ?? minInactive),
    pointerIn,
  );
  return (
    <Box
      style={{
        flexGrow: 1,
        flexBasis: 0,
        height: "100%",
        alignItems: "center",
        gap: rem * 0.25,
      }}
    >
      <Box
        style={{
          flexGrow: 1,
          flexBasis: 0,
          height: "100%",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
        onMouseEnter={() => {
          pointerIn.current = true;
        }}
        onMouseLeave={() => {
          pointerIn.current = false;
          unfreeze();
        }}
      >
        {entries.map(({ tab, width: tabWidth, ghost }) => (
          <Box
            key={tab.id}
            style={{
              width: tabWidth,
              minWidth: 0,
              height: rem * 1.6,
              alignItems: "center",
              justifyContent: tabs.length <= 1 ? "center" : undefined,
              gap: innerGap,
              padding: {
                left: Math.min(padX, tabWidth * 0.25),
                right: Math.min(padX, tabWidth * 0.25),
              },
              margin: {
                left: ghost ? Math.min(gap / 2, tabWidth / 2) : gap / 2,
                right: ghost ? Math.min(gap / 2, tabWidth / 2) : gap / 2,
              },
              cornerRadius: rem * 0.45,
              background:
                tabs.length > 1 && tab.active && !ghost ? theme.hover : undefined,
              hoverBackground: tab.active || ghost ? undefined : theme.hover,
              flexShrink: tab.active && !ghost ? 1 : 0,
              overflow: "hidden",
            }}
            onClick={() =>
              tab.active && !tab.app ? actions.urlEdit() : actions.tabSwitch(tab.id)
            }
            onMouseEnter={() => setHovered(tab.id)}
            onMouseLeave={() => setHovered((id) => (id === tab.id ? null : id))}
          >
            {hovered === tab.id && !ghost ? (
              <Box
                style={{
                  width: slotW,
                  height: slotW,
                  alignItems: "center",
                  justifyContent: "center",
                  cornerRadius: rem * 0.2,
                  hoverBackground: theme.hoverStrong,
                  flexShrink: 0,
                }}
                onClick={() => actions.tabClose(tab.id)}
              >
                <Icon icon="close" size={rem * 0.8} color={theme.muted} />
              </Box>
            ) : tab.agentControlled && !tab.active && !ghost ? (
              <Box
                style={{
                  width: slotW,
                  height: slotW,
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <Box
                  style={{
                    width: slotW * 0.5,
                    height: slotW * 0.5,
                    cornerRadius: slotW * 0.25,
                    background: withAlpha(theme.accent, Math.round(255 * dotPulse)),
                  }}
                />
              </Box>
            ) : tab.favicon ? (
              <Image
                src={tab.favicon}
                error={<Box />}
                style={{
                  width: slotW,
                  height: slotW,
                  cornerRadius: rem * 0.15,
                  flexShrink: 0,
                }}
              />
            ) : (
              <Box style={{ width: slotW, height: slotW, flexShrink: 0 }} />
            )}
            <Text
              style={{
                fontSize: rem * 0.82,
                color:
                  tab.agentControlled && !ghost
                    ? tab.active
                      ? theme.accent
                      : mix(theme.muted, theme.accent, 0.6)
                    : tab.active && !ghost
                      ? theme.fg
                      : theme.muted,
                wrap: false,
                selectable: false,
                flexShrink: 1,
                overflow: "hidden",
              }}
            >
              {label(tab)}
            </Text>
          </Box>
        ))}
      </Box>
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
