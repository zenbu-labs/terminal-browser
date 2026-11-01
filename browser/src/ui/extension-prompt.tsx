import { useEffect, useRef, useState } from "react";
import { Box, Image, Text, useRect } from "@zenbu-labs/pixel";
import type { NodeHandle } from "@zenbu-labs/pixel";
import { Backdrop } from "./modals";
import { ScrollPane } from "./settings/scroll-pane";
import { mix } from "./theme";
import type { Theme } from "./theme";
import type { ExtensionsView } from "./extension-types";
import type { ChromeLayout } from "./types";

type Prompt = NonNullable<ExtensionsView["prompt"]>;

const NAME_LIMIT = 45;
const LINE_BREAK = /[\n\r\u2028\u2029]/;
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// Chrome's Extension::LoadName: whitespace runs holding a line break are
// removed, other runs become one space. Bidi controls are dropped so a name
// can't reorder the text around it.
export function promptName(name: string): string {
  return name
    .replace(BIDI_CONTROLS, "")
    .replace(/\s+/g, (run) => (LINE_BREAK.test(run) ? "" : " "))
    .trim();
}

export function clampName(name: string, limit = NAME_LIMIT): string {
  const characters = Array.from(name);
  const max = Math.max(1, Math.min(limit, NAME_LIMIT));
  return characters.length > max ? `${characters.slice(0, max - 1).join("").trimEnd()}…` : name;
}

function copy(kind: Prompt["kind"], name: string): { title: string; confirm: string; danger: boolean } {
  switch (kind) {
    case "install":
      return { title: `Add "${name}"?`, confirm: "Add extension", danger: false };
    case "permissions":
      return { title: `"${name}" wants to:`, confirm: "Allow", danger: false };
    case "update":
      return { title: `"${name}" needs new permissions`, confirm: "Allow", danger: false };
    case "remove":
      return { title: `Remove "${name}"?`, confirm: "Remove", danger: true };
  }
}

const CANCEL = "Cancel";

export function ExtensionPrompt({
  prompt,
  layout,
  theme,
  onAnswer,
  onFullyShown,
}: {
  prompt: Prompt;
  layout: ChromeLayout;
  theme: Theme;
  onAnswer(accepted: boolean): void;
  onFullyShown(key: number, shown: boolean): void;
}) {
  const rem = layout.rem;
  const width = Math.min(rem * 26, layout.width - rem * 2);
  const top = layout.toolbarHeight + rem * 0.9;
  const iconSize = Math.round(rem * 1.6);
  const titleSize = rem * 1.1;
  const titleWidth = Math.max(0, width - rem * 2.4 - (prompt.icon ? iconSize + rem * 0.75 : 0));
  const fullName = promptName(prompt.name);
  const titleColumns = Math.floor(titleWidth / (titleSize * 0.6));
  const name = clampName(fullName, titleColumns - copy(prompt.kind, "").title.length);
  const { title, confirm, danger } = copy(prompt.kind, name);
  const [hovered, setHovered] = useState(false);
  const card = useRef<NodeHandle | null>(null);
  const viewport = useRef<NodeHandle | null>(null);
  const list = useRef<NodeHandle | null>(null);
  const buttons = useRef<NodeHandle | null>(null);
  const cardRect = useRect(card);
  const viewportRect = useRect(viewport);
  const listRect = useRect(list);
  const buttonsRect = useRect(buttons);
  const hasWarnings = prompt.warnings.length > 0;
  const warningsFit = !hasWarnings || (viewportRect !== null && listRect !== null && listRect.height <= viewportRect.height + 1);
  const buttonsFit =
    cardRect !== null &&
    buttonsRect !== null &&
    buttonsRect.y + buttonsRect.height <= Math.min(cardRect.y + cardRect.height, layout.height) + 1;
  const fullyShown = warningsFit && buttonsFit;
  useEffect(() => onFullyShown(prompt.key, fullyShown), [prompt.key, fullyShown]);
  return (
    <>
      <Backdrop layout={layout} onClose={() => {}} />
      <Box
        ref={card}
        style={{
          position: "absolute",
          inset: { top, left: Math.round((layout.width - width) / 2) },
          width,
          maxHeight: Math.max(0, layout.height - top - rem * 0.9),
          flexDirection: "column",
          gap: rem * 0.9,
          padding: { left: rem * 1.2, right: rem * 1.2, top: rem * 1.1, bottom: rem * 1.1 },
          background: theme.overlay,
          cornerRadius: rem * 0.8,
          border: { width: 1, color: theme.fieldBorder },
          overflow: "hidden",
        }}
        onClick={() => {}}
      >
        <Box
          style={{ alignItems: "center", gap: rem * 0.75, flexShrink: 0 }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          {prompt.icon && (
            <Image
              src={prompt.icon}
              error={<Box style={{ width: iconSize, height: iconSize, flexShrink: 0 }} />}
              style={{ width: iconSize, height: iconSize, flexShrink: 0 }}
            />
          )}
          <Text style={{ width: titleWidth, fontSize: titleSize, color: theme.fg, wrap: false, ellipsis: true, selectable: false }}>
            {title}
          </Text>
        </Box>
        {hasWarnings && (
          <ScrollPane
            paneRef={viewport}
            rem={rem}
            resetKey={prompt.key}
            style={{
              flexDirection: "column",
              flexShrink: 1,
              padding: { left: prompt.icon ? iconSize + rem * 0.75 : 0 },
            }}
          >
            <Box ref={list} style={{ flexDirection: "column", gap: rem * 0.45, flexShrink: 0, padding: { right: rem * 0.6 } }}>
              {prompt.warnings.map((warning) => (
                <Text key={warning} style={{ fontSize: rem * 0.9, color: theme.muted, selectable: false }}>
                  {warning}
                </Text>
              ))}
            </Box>
          </ScrollPane>
        )}
        <Box ref={buttons} style={{ justifyContent: "end", gap: rem * 0.6, padding: { top: rem * 0.2 }, flexShrink: 0 }}>
          <PromptButton label={CANCEL} tone="neutral" rem={rem} theme={theme} onClick={() => onAnswer(false)} />
          <PromptButton label={confirm} tone={danger ? "danger" : "accent"} rem={rem} theme={theme} onClick={() => onAnswer(true)} />
        </Box>
      </Box>
      {hovered && name !== fullName && <NameTooltip name={fullName} width={width} top={top} layout={layout} theme={theme} />}
    </>
  );
}

function NameTooltip({ name, width, top, layout, theme }: { name: string; width: number; top: number; layout: ChromeLayout; theme: Theme }) {
  const rem = layout.rem;
  const height = Math.min(rem * 4.6, Math.max(rem * 1.6, top - rem * 0.3));
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: Math.max(0, top - height - rem * 0.3), left: Math.round((layout.width - width) / 2) },
        width,
        maxHeight: height,
        padding: { left: rem * 0.6, right: rem * 0.6, top: rem * 0.3, bottom: rem * 0.3 },
        background: theme.overlay,
        cornerRadius: rem * 0.3,
        border: { width: 1, color: theme.fieldBorder },
        overflow: "hidden",
      }}
    >
      <Text style={{ fontSize: rem * 0.75, color: theme.fg, selectable: false }}>{name}</Text>
    </Box>
  );
}

function PromptButton({
  label,
  tone,
  rem,
  theme,
  onClick,
}: {
  label: string;
  tone: "neutral" | "accent" | "danger";
  rem: number;
  theme: Theme;
  onClick(): void;
}) {
  const tint = tone === "accent" ? theme.accent : tone === "danger" ? theme.red : null;
  return (
    <Box
      style={{
        height: rem * 1.9,
        alignItems: "center",
        padding: { left: rem * 1.1, right: rem * 1.1 },
        cornerRadius: rem * 0.35,
        background: tint ? mix(theme.overlay, tint, tone === "danger" ? 0.3 : 0.22) : theme.field,
        hoverBackground: tint ? mix(theme.overlay, tint, tone === "danger" ? 0.5 : 0.38) : theme.hoverStrong,
        flexShrink: 0,
      }}
      onClick={onClick}
    >
      <Text style={{ fontSize: rem * 0.95, color: theme.fg, wrap: false, selectable: false }}>{label}</Text>
    </Box>
  );
}
