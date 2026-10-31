import type { RefObject } from "react";
import { Box, Image, Text, useRect } from "@zenbu-labs/pixel";
import type { NodeHandle } from "@zenbu-labs/pixel";
import { Icon } from "./icons";
import { Backdrop } from "./modals";
import type { Theme } from "./theme";
import type { ExtensionActions, ExtensionsView } from "./extension-types";
import type { ChromeLayout } from "./types";

const MANAGE_LABEL = "Manage extensions";

export function ExtensionsMenu({
  view,
  anchor,
  layout,
  theme,
  actions,
}: {
  view: ExtensionsView;
  anchor: RefObject<NodeHandle | null>;
  layout: ChromeLayout;
  theme: Theme;
  actions: ExtensionActions;
}) {
  const rem = layout.rem;
  const anchorRect = useRect(anchor);
  const pad = Math.round(rem * 0.3);
  const rowH = Math.round(rem * 2);
  const longest = view.actions.reduce((max, action) => Math.max(max, action.name.length), MANAGE_LABEL.length);
  const width = Math.round(Math.min(Math.max(rem * 15, longest * rem * 0.88 * 0.6 + rem * 5), rem * 24, layout.width - rem));
  const right = anchorRect ? anchorRect.x + anchorRect.width : layout.width - rem * 0.4;
  const left = Math.max(rem * 0.4, Math.min(right - width, layout.width - width - rem * 0.4));
  const top = Math.round((anchorRect ? anchorRect.y + anchorRect.height : layout.toolbarHeight) + rem * 0.2);
  const manageIndex = view.actions.length;
  const maxRows = Math.max(1, Math.floor((layout.height - top - rem * 4) / rowH));
  return (
    <>
      <Backdrop layout={layout} onClose={actions.toggleMenu} />
      <Box
        style={{
          position: "absolute",
          inset: { top, left },
          width,
          flexDirection: "column",
          padding: pad,
          background: theme.overlay,
          cornerRadius: rem * 0.45,
          border: { width: 1, color: theme.fieldBorder },
          overflow: "hidden",
        }}
        onClick={() => {}}
      >
        <Box
          style={{
            flexDirection: "column",
            maxHeight: maxRows * rowH,
            overflow: view.actions.length > maxRows ? "scroll" : "hidden",
          }}
        >
          {view.actions.map((action, index) => {
            const iconSize = Math.round(rem * 1.05);
            return (
              <Box
                key={action.extensionId}
                style={{
                  height: rowH,
                  flexShrink: 0,
                  alignItems: "center",
                  gap: rem * 0.6,
                  padding: { left: rem * 0.5, right: rem * 0.25 },
                  cornerRadius: rem * 0.3,
                  background: view.menuIndex === index ? theme.hover : undefined,
                  hoverBackground: theme.hover,
                }}
                onMouseEnter={() => actions.menuHover(index)}
                onClick={() => actions.click(action.extensionId)}
              >
                {action.icon ? (
                  <Image src={action.icon} error={<Box />} style={{ width: iconSize, height: iconSize, flexShrink: 0 }} />
                ) : (
                  <Box style={{ width: iconSize, height: iconSize, flexShrink: 0 }} />
                )}
                <Text
                  style={{
                    flexGrow: 1,
                    flexBasis: 0,
                    fontSize: rem * 0.88,
                    color: action.enabled ? theme.fg : theme.muted,
                    wrap: false,
                    ellipsis: true,
                    selectable: false,
                  }}
                >
                  {action.name}
                </Text>
                <Box
                  style={{
                    width: rem * 1.5,
                    height: rem * 1.5,
                    alignItems: "center",
                    justifyContent: "center",
                    cornerRadius: rem * 0.3,
                    hoverBackground: theme.hoverStrong,
                    flexShrink: 0,
                  }}
                  onClick={() => actions.setPinned(action.extensionId, !action.pinned)}
                >
                  <Icon
                    icon="pushpin"
                    size={rem * 0.9}
                    color={action.pinned ? theme.accent : theme.disabled}
                    weight={action.pinned ? 2.6 : 2}
                  />
                </Box>
              </Box>
            );
          })}
        </Box>
        <Box style={{ height: 1, margin: { top: pad, bottom: pad }, background: theme.hairline, flexShrink: 0 }} />
        <Box
          style={{
            height: Math.round(rem * 1.7),
            flexShrink: 0,
            alignItems: "center",
            padding: { left: rem * 0.5, right: rem * 0.5 },
            cornerRadius: rem * 0.3,
            background: view.menuIndex === manageIndex ? theme.hover : undefined,
            hoverBackground: theme.hover,
          }}
          onMouseEnter={() => actions.menuHover(manageIndex)}
          onClick={actions.openManager}
        >
          <Text style={{ fontSize: rem * 0.82, color: theme.fg, wrap: false, selectable: false }}>{MANAGE_LABEL}</Text>
        </Box>
      </Box>
    </>
  );
}
