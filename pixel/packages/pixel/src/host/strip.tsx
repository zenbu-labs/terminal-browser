import { useContext, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import { Icon } from "../icons";
import { Box, Text } from "../react";
import { RootContext, useRegistryColors } from "../registry";
import { makeTheme } from "../theme";
import { GuestView } from "./guest";
import type { Shell } from "./shell";

export function PaneShell({ shell, children }: { shell: Shell; children: ReactNode }) {
  const registry = useContext(RootContext);
  if (!registry) throw new Error("PaneShell outside a root");
  const { tabs, active } = useSyncExternalStore(shell.subscribe, shell.get, shell.get);
  const colors = useRegistryColors(registry);
  const theme = makeTheme(colors);
  const rem = registry.root.info.basePx;
  const [hovered, setHovered] = useState<string | null>(null);
  const closeSlot = rem * 0.95;

  return (
    <Box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      <Box
        hidden={tabs.length === 1}
        style={{
          height: Math.round(rem * 1.9),
          alignItems: "center",
          gap: rem * 0.25,
          padding: { left: rem * 0.3, right: rem * 0.3 },
          background: theme.field,
          border: { bottom: [1, theme.hairline] },
          flexShrink: 0,
        }}
      >
        {tabs.map((tab, index) => {
          const current = index === active;
          const closable = hovered === tab.key;
          return (
            <Box
              key={tab.key}
              style={{
                flexGrow: 1,
                flexBasis: 0,
                minWidth: 0,
                height: Math.round(rem * 1.4),
                alignItems: "center",
                gap: rem * 0.3,
                padding: { left: rem * 0.7, right: rem * 0.35 },
                cornerRadius: rem * 0.45,
                background: current ? theme.hover : undefined,
                hoverBackground: current ? undefined : theme.hover,
                overflow: "hidden",
              }}
              onClick={() => shell.activate(index)}
              onMouseEnter={() => setHovered(tab.key)}
              onMouseLeave={() => setHovered((key) => (key === tab.key ? null : key))}
            >
              <Text
                style={{
                  flexGrow: 1,
                  flexBasis: 0,
                  fontSize: rem * 0.82,
                  color: current ? theme.fg : theme.muted,
                  wrap: false,
                  ellipsis: true,
                  selectable: false,
                  overflow: "hidden",
                }}
              >
                {tab.label}
              </Text>
              {closable ? (
                <Box
                  style={{
                    width: closeSlot,
                    height: closeSlot,
                    alignItems: "center",
                    justifyContent: "center",
                    cornerRadius: rem * 0.2,
                    hoverBackground: theme.hoverStrong,
                    flexShrink: 0,
                  }}
                  onClick={() => shell.close(index)}
                >
                  <Icon icon="close" size={rem * 0.8} color={theme.muted} />
                </Box>
              ) : (
                <Box style={{ width: closeSlot, height: closeSlot, flexShrink: 0 }} />
              )}
            </Box>
          );
        })}
      </Box>
      <Box style={{ flexGrow: 1, flexBasis: 0, flexDirection: "column" }} hidden={active !== 0}>
        {children}
      </Box>
      {tabs.map(
        (tab, index) =>
          tab.guest && <GuestView key={tab.key} guest={tab.guest} active={index === active} />,
      )}
    </Box>
  );
}
