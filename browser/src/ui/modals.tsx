import { useLayoutEffect, useRef } from "react";
import { Box, Image, Input, Text } from "@zenbu-labs/pixel";
import type { NodeHandle, TextSpan } from "@zenbu-labs/pixel";
import { Icon } from "./icons";
import { mix } from "./theme";
import type { Theme } from "./theme";
import type { ChromeActions, ChromeLayout, KeywordView, NewTabView, PaletteView } from "./types";

export function Backdrop({ layout, onClose }: { layout: ChromeLayout; onClose(): void }) {
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: 0, left: 0 },
        width: layout.width,
        height: layout.height,
      }}
      onClick={onClose}
    />
  );
}


function lastRowRadius(last: boolean, rem: number) {
  if (!last) return undefined;
  const radius = Math.max(2, rem * 0.55 - 1);
  return { topLeft: 0, topRight: 0, bottomLeft: radius, bottomRight: radius };
}

function ModalCard({
  layout,
  theme,
  width,
  onClose,
  children,
}: {
  layout: ChromeLayout;
  theme: Theme;
  width: number;
  onClose(): void;
  children: React.ReactNode;
}) {
  return (
    <>
      <Backdrop layout={layout} onClose={onClose} />
      <Box
        style={{
          position: "absolute",
          inset: { top: layout.toolbarHeight + layout.rem * 1.2, left: (layout.width - width) / 2 },
          width,
          flexDirection: "column",
          background: theme.overlay,
          cornerRadius: layout.rem * 0.55,
          border: { width: 1, color: theme.fieldBorder },
          overflow: "hidden",
        }}
        onClick={() => {}}
      >
        {children}
      </Box>
    </>
  );
}

export function PaletteCard({
  view,
  actions,
  layout,
  theme,
}: {
  view: PaletteView;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const cardW = Math.min(rem * 26, layout.width - rem * 4);
  const rowH = rem * 2;
  const input = useRef<NodeHandle | null>(null);
  useLayoutEffect(() => {
    input.current?.focus();
  }, []);
  return (
    <ModalCard layout={layout} theme={theme} width={cardW} onClose={actions.paletteClose}>
      <Box
        style={{
          height: rem * 2.4,
          alignItems: "center",
          padding: { left: rem * 0.85, right: rem * 0.85 },
          border: { bottom: [1, theme.hairline] },
        }}
      >
        <Input
          ref={input}
          autoFocus
          style={{ flexGrow: 1, flexBasis: 0, wrap: false, fontSize: rem }}
          caretColor={theme.accent}
          selectionColor={theme.selection}
          onChange={(text) => actions.paletteQuery(text)}
        />
      </Box>
      <Box style={{ flexDirection: "column" }}>
        {view.items.length === 0 && (
          <Text
            style={{
              padding: { left: rem * 0.85, top: rem * 0.35, bottom: rem * 0.35 },
              fontSize: rem * 0.92,
              color: theme.muted,
              selectable: false,
            }}
          >
            No matching actions
          </Text>
        )}
        {view.items.map((item, i) => (
          <Box
            key={item.id}
            style={{
              height: rowH,
              alignItems: "center",
              gap: rem * 0.55,
              padding: { left: rem * 0.85, right: rem * 0.85 },
              background: i === view.index ? theme.hover : undefined,
              hoverBackground: theme.hover,
              cornerRadius: lastRowRadius(i === view.items.length - 1, rem),
            }}
            onClick={() => actions.paletteRun(i)}
          >
            <Text
              style={{
                flexGrow: 1,
                flexBasis: 0,
                fontSize: rem * 0.95,
                wrap: false,
                selectable: false,
              }}
            >
              {item.label}
            </Text>
            <Text
              style={{ fontSize: rem * 0.82, color: theme.muted, wrap: false, selectable: false }}
            >
              {item.shortcut}
            </Text>
          </Box>
        ))}
      </Box>
    </ModalCard>
  );
}

function KeywordChip({ keyword, rem, theme }: { keyword: KeywordView; rem: number; theme: Theme }) {
  const icon = rem * 0.9;
  return (
    <Box
      style={{
        alignItems: "center",
        gap: rem * 0.35,
        padding: { left: rem * 0.4, right: rem * 0.5, top: rem * 0.1, bottom: rem * 0.1 },
        cornerRadius: rem * 0.4,
        background: mix(theme.overlay, theme.accent, 0.22),
        flexShrink: 0,
      }}
    >
      {keyword.icon ? (
        <Image
          src={keyword.icon}
          error={<Icon icon="puzzle" size={icon} color={theme.muted} />}
          style={{ width: icon, height: icon, flexShrink: 0 }}
        />
      ) : (
        <Icon icon="puzzle" size={icon} color={theme.muted} />
      )}
      <Text style={{ fontSize: rem * 0.9, color: theme.fg, wrap: false, selectable: false }}>{keyword.name}</Text>
    </Box>
  );
}

function descriptionSpans(runs: KeywordView["rows"][number]["runs"], selected: boolean, theme: Theme): TextSpan[] {
  let at = 0;
  return runs.map((run) => {
    const start = at;
    at += run.text.length;
    const color = run.styles.includes("url")
      ? theme.accent
      : run.styles.includes("dim")
        ? theme.disabled
        : selected || run.styles.includes("match")
          ? theme.fg
          : theme.muted;
    return { start, end: at, color, bold: run.styles.includes("match") };
  });
}

function KeywordRows({
  keyword,
  actions,
  rem,
  theme,
}: {
  keyword: KeywordView;
  actions: ChromeActions;
  rem: number;
  theme: Theme;
}) {
  if (keyword.rows.length === 0) return null;
  return (
    <Box style={{ flexDirection: "column", border: { top: [1, theme.hairline] } }}>
      {keyword.rows.map((row, i) => {
        const selected = i === keyword.index;
        return (
          <Box
            key={i}
            style={{
              height: rem * 2,
              alignItems: "center",
              gap: rem * 0.6,
              padding: { left: rem * 0.85, right: rem * 0.85 },
              background: selected ? theme.hover : undefined,
              hoverBackground: theme.hover,
              cornerRadius: lastRowRadius(i === keyword.rows.length - 1, rem),
            }}
            onClick={() => actions.keywordPick(i)}
          >
            {keyword.icon ? (
              <Image
                src={keyword.icon}
                error={<Icon icon="puzzle" size={rem * 0.8} color={theme.disabled} />}
                style={{ width: rem * 0.8, height: rem * 0.8, flexShrink: 0 }}
              />
            ) : (
              <Icon icon="puzzle" size={rem * 0.8} color={theme.disabled} />
            )}
            <Text
              style={{
                flexGrow: 1,
                flexBasis: 0,
                flexShrink: 1,
                fontSize: rem * 0.95,
                color: selected ? theme.fg : theme.muted,
                wrap: false,
                selectable: false,
                overflow: "hidden",
              }}
              spans={descriptionSpans(row.runs, selected, theme)}
            >
              {row.runs.map((run) => run.text).join("")}
            </Text>
            {row.deletable && (
              <Box
                style={{ padding: rem * 0.2, cornerRadius: rem * 0.3, hoverBackground: theme.hover, flexShrink: 0 }}
                onClick={() => actions.keywordRemove(i)}
              >
                <Icon icon="close" size={rem * 0.75} color={theme.muted} />
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

export function UrlCard({
  text,
  keyword,
  actions,
  layout,
  theme,
}: {
  text: string;
  keyword: KeywordView | null;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const cardW = Math.min(rem * 28, layout.width - rem * 4);
  const input = useRef<NodeHandle | null>(null);
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.selectAll();
  }, []);
  return (
    <ModalCard layout={layout} theme={theme} width={cardW} onClose={actions.urlEditCancel}>
      <Box
        style={{
          height: rem * 2.4,
          alignItems: "center",
          gap: rem * 0.5,
          padding: { left: rem * 0.85, right: rem * 0.85 },
        }}
      >
        {keyword ? <KeywordChip keyword={keyword} rem={rem} theme={theme} /> : <Icon icon="search" size={rem} color={theme.muted} />}
        <Input
          ref={input}
          autoFocus
          value={text}
          style={{ flexGrow: 1, flexBasis: 0, wrap: false, fontSize: rem }}
          caretColor={theme.accent}
          selectionColor={theme.selection}
          onChange={(next) => actions.urlInput(next)}
          onSubmit={(next) => actions.urlSubmit(next)}
        />
      </Box>
      {keyword && <KeywordRows keyword={keyword} actions={actions} rem={rem} theme={theme} />}
    </ModalCard>
  );
}

export function NewTabCard({
  view,
  keyword,
  actions,
  layout,
  theme,
}: {
  view: NewTabView;
  keyword: KeywordView | null;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const cardW = Math.min(rem * 28, layout.width - rem * 4);
  const rowH = rem * 2;
  const input = useRef<NodeHandle | null>(null);
  useLayoutEffect(() => {
    input.current?.focus();
  }, []);
  return (
    <ModalCard layout={layout} theme={theme} width={cardW} onClose={actions.newTabCancel}>
      <Box
        style={{
          height: rem * 2.4,
          alignItems: "center",
          gap: rem * 0.5,
          padding: { left: rem * 0.85, right: rem * 0.85 },
          border: !keyword && view.suggestions.length ? { bottom: [1, theme.hairline] } : undefined,
        }}
      >
        {keyword ? <KeywordChip keyword={keyword} rem={rem} theme={theme} /> : <Icon icon="search" size={rem} color={theme.muted} />}
        <Input
          ref={input}
          autoFocus
          value={view.query}
          style={{ flexGrow: 1, flexBasis: 0, wrap: false, fontSize: rem }}
          caretColor={theme.accent}
          selectionColor={theme.selection}
          onChange={(text) => actions.newTabQuery(text)}
        />
      </Box>
      {keyword && <KeywordRows keyword={keyword} actions={actions} rem={rem} theme={theme} />}
      {!keyword && view.suggestions.length > 0 && (
        <Box style={{ flexDirection: "column" }}>
          {view.suggestions.map((suggestion, i) => {
            const text = suggestion.kind === "app" ? suggestion.name : suggestion.text;
            const maxChars = Math.floor((cardW - rem * 3.15) / (rem * 0.95 * 0.6));
            const shown =
              text.length > maxChars
                ? `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
                : text;
            return (
              <Box
                key={suggestion.kind === "app" ? `app:${suggestion.id}` : `${i}:${text}`}
                style={{
                  height: rowH,
                  alignItems: "center",
                  gap: rem * 0.6,
                  padding: { left: rem * 0.85, right: rem * 0.85 },
                  background: i === view.index ? theme.hover : undefined,
                  hoverBackground: theme.hover,
                  cornerRadius: lastRowRadius(i === view.suggestions.length - 1, rem),
                }}
                onClick={() => actions.newTabPick(i)}
              >
                <Icon
                  icon={suggestion.kind === "app" ? "terminal" : "search"}
                  size={rem * 0.8}
                  color={theme.disabled}
                />
                <Text
                  style={{
                    flexGrow: 1,
                    flexBasis: 0,
                    flexShrink: 1,
                    fontSize: rem * 0.95,
                    color: i === view.index ? theme.fg : theme.muted,
                    wrap: false,
                    selectable: false,
                    overflow: "hidden",
                  }}
                >
                  {shown}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}
    </ModalCard>
  );
}

