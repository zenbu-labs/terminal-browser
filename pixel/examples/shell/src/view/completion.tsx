import type { ReactNode } from "react";

import { Box, Text } from "@zenbu-labs/pixel";

import { completionSizes, dividerAfter } from "./sizes";
import type { BarColors } from "./sizes";
import type { CompletionItem } from "../completion/complete";

interface CompletionPopupProps {
  rows: CompletionItem[];
  selected: number;
  top: number;
  visible: number;
  width: number;
  empty: string | null;
  more: number;
  colors: BarColors;
  scale: number;
  onPick(row: number): void;
  onWheel(rows: number): void;
}

export function CompletionPopup(props: CompletionPopupProps) {
  const { colors, scale: s } = props;
  const size = completionSizes(s);
  const { visible } = props;
  const shown = props.rows.slice(props.top, props.top + visible);
  const divider = dividerAfter(props.rows, props.top, visible);
  const overflow = props.rows.length > visible;
  const listHeight = Math.min(visible, props.rows.length) * size.row + (divider >= 0 ? size.divider : 0);
  const thumb = overflow ? Math.max(Math.round(10 * s), (visible / props.rows.length) * listHeight) : 0;
  const thumbAt = overflow ? (props.top / (props.rows.length - visible)) * (listHeight - thumb) : 0;
  return (
    <Panel width={props.width} colors={colors} scale={s}>
      {props.empty != null ? (
        <Box style={{ height: size.row, flexDirection: "row", alignItems: "center", padding: size.rowPadding }}>
          <Text style={{ color: colors.muted, fontSize: size.font, selectable: false }}>{props.empty}</Text>
        </Box>
      ) : (
        <Box style={{ flexDirection: "column" }} onWheel={(event) => props.onWheel(Math.sign(event.deltaY) * Math.max(1, Math.round(Math.abs(event.deltaY) / size.row)))}>
          {shown.map((item, i) => {
            const at = props.top + i;
            const selected = at === props.selected;
            return (
              <Box key={at} style={{ flexDirection: "column" }}>
                <Box
                  style={{
                    height: size.row,
                    flexShrink: 0,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: Math.round(16 * s),
                    padding: size.rowPadding,
                    cornerRadius: 4 * s,
                    background: selected ? colors.hover : undefined,
                    hoverBackground: colors.hover,
                    pointerShape: "pointer",
                  }}
                  onClick={() => props.onPick(at)}
                >
                  <Text style={{ color: colors.fg, fontSize: size.font, wrap: false, ellipsis: true, flexShrink: 0, maxWidth: item.description ? "70%" : "100%", selectable: false }}>{item.label}</Text>
                  <Box style={{ flexGrow: 1, flexBasis: 0, minWidth: 0, overflow: "hidden", flexDirection: "row", justifyContent: "end" }}>
                    {item.description !== "" && (
                      <Text style={{ color: colors.muted, fontSize: size.font, wrap: false, ellipsis: true, flexShrink: 1, minWidth: 0, selectable: false }}>{item.description}</Text>
                    )}
                  </Box>
                </Box>
                {at === divider && <Divider colors={colors} scale={s} />}
              </Box>
            );
          })}
          {overflow && (
            <Box
              style={{ position: "absolute", inset: { top: thumbAt, right: -Math.round(3 * s) }, width: Math.round(2 * s), height: thumb, cornerRadius: s, background: colors.border }}
            />
          )}
        </Box>
      )}
      {props.empty == null && props.more > 0 && (
        <Box style={{ height: size.row, flexDirection: "row", alignItems: "center", padding: size.rowPadding }}>
          {/* fixme: placeholder copy */}
          <Text style={{ color: colors.faint, fontSize: 11 * s, selectable: false }}>{`${props.more} more, keep typing to narrow`}</Text>
        </Box>
      )}
    </Panel>
  );
}

export function CompletionDetails(props: { item: CompletionItem; width: number; colors: BarColors; scale: number }) {
  const { colors, scale: s, item } = props;
  const size = completionSizes(s);
  return (
    <Panel width={props.width} colors={colors} scale={s}>
      <Box style={{ flexDirection: "column", gap: Math.round(4 * s), padding: { top: Math.round(4 * s), bottom: Math.round(4 * s), ...size.rowPadding } }}>
        <Text style={{ color: colors.fg, fontSize: size.font, wrap: true, selectable: false }}>{item.label}</Text>
        <Text style={{ color: colors.muted, fontSize: 11 * s, wrap: true, selectable: false }}>{item.description}</Text>
      </Box>
    </Panel>
  );
}

function Divider(props: { colors: BarColors; scale: number }) {
  const { colors, scale: s } = props;
  const size = completionSizes(s);
  return (
    <Box style={{ height: size.divider, flexDirection: "column", justifyContent: "center", padding: { left: 6 * s, right: 6 * s } }}>
      <Box style={{ height: size.border, background: colors.border }} />
    </Box>
  );
}

function Panel(props: { width: number; colors: BarColors; scale: number; children: ReactNode }) {
  const { colors, scale: s } = props;
  const size = completionSizes(s);
  return (
    <Box
      style={{
        width: props.width,
        flexDirection: "column",
        padding: { top: size.inset, right: size.inset, bottom: size.inset, left: size.inset },
        cornerRadius: 7 * s,
        border: { width: size.border, color: colors.border },
        background: colors.panel,
      }}
    >
      {props.children}
    </Box>
  );
}
