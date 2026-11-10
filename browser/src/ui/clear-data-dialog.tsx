import { Box, Text } from "@zenbu-labs/pixel";
import type { BrowsingDataKind } from "../session/browsing-data";
import { Icon } from "./icons";
import { Backdrop } from "./modals";
import { mix } from "./theme";
import type { Theme } from "./theme";
import type { ChromeActions, ChromeLayout, ClearDataView } from "./types";

const COPY = {
  title: "Clear browsing data",
  cancel: "Cancel",
  confirm: "Delete data",
  clearing: "Deleting…",
  siteData: "Cookies and site data",
  cache: "Cached images and files",
};

const ROWS: { kind: BrowsingDataKind; label: string }[] = [
  { kind: "siteData", label: COPY.siteData },
  { kind: "cache", label: COPY.cache },
];

export function ClearDataDialog({
  view,
  actions,
  layout,
  theme,
}: {
  view: ClearDataView;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const width = Math.min(rem * 26, layout.width - rem * 2);
  const canConfirm = view.checked.length > 0 && !view.clearing;
  return (
    <>
      <Backdrop layout={layout} onClose={actions.clearDataCancel} />
      <Box
        style={{
          position: "absolute",
          inset: { top: layout.toolbarHeight + rem * 0.9, left: Math.round((layout.width - width) / 2) },
          width,
          flexDirection: "column",
          gap: rem * 0.9,
          padding: { left: rem * 1.2, right: rem * 1.2, top: rem * 1, bottom: rem * 1.1 },
          background: theme.overlay,
          cornerRadius: rem * 0.8,
          border: { width: 1, color: theme.fieldBorder },
        }}
        onClick={() => {}}
      >
        <Box style={{ alignItems: "center", gap: rem * 0.5 }}>
          <Text
            style={{ flexGrow: 1, flexBasis: 0, fontSize: rem * 1.15, color: theme.fg, wrap: false, selectable: false }}
          >
            {COPY.title}
          </Text>
          <Box
            style={{
              width: rem * 1.5,
              height: rem * 1.5,
              alignItems: "center",
              justifyContent: "center",
              cornerRadius: rem * 0.3,
              hoverBackground: theme.hover,
              flexShrink: 0,
            }}
            onClick={actions.clearDataCancel}
          >
            <Icon icon="close" size={rem * 1} color={theme.fg} />
          </Box>
        </Box>
        <Box style={{ flexDirection: "column", gap: rem * 0.3 }}>
          {ROWS.map((row) => (
            <CheckRow
              key={row.kind}
              label={row.label}
              checked={view.checked.includes(row.kind)}
              rem={rem}
              theme={theme}
              onToggle={() => actions.clearDataToggle(row.kind)}
            />
          ))}
        </Box>
        <Box style={{ justifyContent: "end", gap: rem * 0.6 }}>
          <DialogButton label={COPY.cancel} tone="neutral" enabled rem={rem} theme={theme} onClick={actions.clearDataCancel} />
          <DialogButton
            label={view.clearing ? COPY.clearing : COPY.confirm}
            tone="danger"
            enabled={canConfirm}
            rem={rem}
            theme={theme}
            onClick={actions.clearDataConfirm}
          />
        </Box>
      </Box>
    </>
  );
}

function CheckRow({
  label,
  checked,
  rem,
  theme,
  onToggle,
}: {
  label: string;
  checked: boolean;
  rem: number;
  theme: Theme;
  onToggle(): void;
}) {
  const box = rem * 1.1;
  return (
    <Box
      style={{
        alignItems: "center",
        gap: rem * 0.7,
        padding: { left: rem * 0.4, right: rem * 0.4, top: rem * 0.45, bottom: rem * 0.45 },
        cornerRadius: rem * 0.4,
        hoverBackground: theme.hover,
      }}
      onClick={onToggle}
    >
      <Box
        style={{
          width: box,
          height: box,
          alignItems: "center",
          justifyContent: "center",
          cornerRadius: rem * 0.25,
          background: checked ? theme.accent : theme.field,
          border: { width: 1, color: checked ? theme.accent : theme.fieldBorder },
          flexShrink: 0,
        }}
      >
        {checked && <Icon icon="check" size={box * 0.8} color={theme.overlay} weight={3} />}
      </Box>
      <Text style={{ flexGrow: 1, flexBasis: 0, fontSize: rem * 0.95, color: theme.fg, selectable: false }}>
        {label}
      </Text>
    </Box>
  );
}

function DialogButton({
  label,
  tone,
  enabled,
  rem,
  theme,
  onClick,
}: {
  label: string;
  tone: "neutral" | "danger";
  enabled: boolean;
  rem: number;
  theme: Theme;
  onClick(): void;
}) {
  const danger = tone === "danger";
  return (
    <Box
      style={{
        height: rem * 1.9,
        alignItems: "center",
        padding: { left: rem * 1.1, right: rem * 1.1 },
        cornerRadius: rem * 0.35,
        background: danger ? mix(theme.overlay, theme.red, enabled ? 0.3 : 0.12) : theme.field,
        hoverBackground: enabled ? (danger ? mix(theme.overlay, theme.red, 0.5) : theme.hoverStrong) : undefined,
        flexShrink: 0,
      }}
      onClick={enabled ? onClick : undefined}
    >
      <Text
        style={{ fontSize: rem * 0.95, color: enabled ? theme.fg : theme.disabled, wrap: false, selectable: false }}
      >
        {label}
      </Text>
    </Box>
  );
}
