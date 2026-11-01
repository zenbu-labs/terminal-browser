import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";

import { Box, Input, Markdown, Text, useRect } from "@zenbu-labs/pixel";
import type { NodeHandle, MarkdownTheme, ScrollEvent } from "@zenbu-labs/pixel";

import { IconButton, Keys } from "./icons";
import { ANSWER_MAX_HEIGHT, ANSWER_PADDING_TOP, MARGIN_BOTTOM } from "./sizes";
import type { BarColors } from "./sizes";


interface AiBarProps {
  colors: BarColors;
  scale: number;
  width: number;
  maxHeight: number;
  answerScroll: Ref<AnswerScroll>;
  text: string;
  busy: boolean;
  ready: boolean;
  status: string | null;
  answer: string;
  error: string | null;
  notice: string | null;
  modelMenu: ReactNode;
  onText(text: string): void;
  onSubmit(): void;
  onStop(): void;
  onClose(): void;
  onFocusInput(): void;
}

export interface AnswerScroll {
  page(direction: 1 | -1): void;
}

export const AiBar = forwardRef<NodeHandle, AiBarProps>(function AiBar(props, inputRef) {
  const { colors, scale: s } = props;
  const markdownTheme: MarkdownTheme = {
    fg: colors.fg,
    muted: colors.muted,
    link: colors.fg,
    inlineCode: colors.fg,
    codeBg: colors.codeBg,
    separator: colors.border,
    syntax: {},
  };
  return (
    <Box
      style={{
        width: props.width,
        maxHeight: props.maxHeight - MARGIN_BOTTOM * s,
        flexDirection: "column",
        padding: { top: 5 * s, left: 5 * s, right: 5 * s, bottom: 0 },
        margin: { bottom: MARGIN_BOTTOM * s },
        cornerRadius: 5 * s,
        border: { width: Math.max(1, Math.round(s)), color: colors.border },
        background: colors.panel,
      }}
      onClick={() => props.onFocusInput()}
    >
      <Box style={{ flexDirection: "row", alignItems: "center", flexShrink: 0, padding: { left: 6 * s, top: 2 * s, bottom: 2 * s } }}>
        <Box style={{ flexGrow: 1, flexBasis: 0 }}>
          <Input
            ref={inputRef}
            autoFocus
            caretColor={colors.fg}
            selectionColor={colors.hover}
            style={{ color: colors.fg, fontSize: 13 * s, wrap: true }}
            onChange={(value) => props.onText(value)}
            onSubmit={() => props.onSubmit()}
          />
        </Box>
        <Box style={{ padding: { left: 6 * s, right: 3 * s } }}>
          <IconButton name="close" size={13 * s} color={colors.muted} hoverColor={colors.fg} hoverBackground={colors.hover} scale={s} onClick={() => props.onClose()} />
        </Box>
      </Box>
      {props.answer !== "" && <Answer ref={props.answerScroll} text={props.answer} streaming={props.busy} theme={markdownTheme} colors={colors} scale={s} />}
      <Box style={{ flexDirection: "row", alignItems: "center", flexShrink: 0, height: 20 * s, margin: { top: 4 * s, bottom: 6 * s }, padding: { left: 4 * s, right: 4 * s }, gap: 8 * s }}>
        {props.busy && (
          <Box style={{ padding: { left: 5 * s, right: 5 * s }, cornerRadius: 4 * s, background: colors.hover }}>
            {/* fixme: placeholder copy */}
            <Text style={{ color: colors.muted, fontSize: 10 * s }}>Generating…</Text>
          </Box>
        )}
        {props.busy && props.status && <Text style={{ color: colors.faint, fontSize: 10 * s }}>{props.status}</Text>}
        {!props.busy && props.error && <Text style={{ color: colors.error, fontSize: 10 * s }}>{props.error}</Text>}
        {!props.busy && !props.error && !props.ready && props.notice && <Text style={{ color: colors.faint, fontSize: 10 * s }}>{props.notice}</Text>}
        {props.ready && (
          <Box style={{ flexDirection: "row", gap: 10 * s, padding: { left: 2 * s } }}>
            {/* fixme: placeholder copy */}
            <Hint keys="⏎" label="run" colors={colors} scale={s} />
            {/* fixme: placeholder copy */}
            <Hint keys="esc" label="dismiss" colors={colors} scale={s} />
          </Box>
        )}
        <Box style={{ flexGrow: 1 }} />
        {props.modelMenu}
        {!props.ready && (
          <IconButton
            name={props.busy ? "stop" : "enter"}
            size={props.busy ? 10 * s : 13 * s}
            color={colors.faint}
            hoverColor={colors.fg}
            hoverBackground={colors.hover}
            scale={s}
            onClick={() => (props.busy ? props.onStop() : props.onSubmit())}
          />
        )}
      </Box>
    </Box>
  );
});

const Answer = forwardRef<AnswerScroll, { text: string; streaming: boolean; theme: MarkdownTheme; colors: BarColors; scale: number }>(function Answer(props, ref) {
  const { colors, scale: s } = props;
  const box = useRef<NodeHandle>(null);
  const content = useRef<NodeHandle>(null);
  const boxRect = useRect(box);
  const contentRect = useRect(content);
  const following = useRef(true);
  const [offset, setOffset] = useState(0);
  const viewport = boxRect?.height ?? 0;
  const max = contentRect ? Math.max(0, contentRect.height - viewport) : 0;
  useLayoutEffect(() => {
    if (following.current) box.current?.scrollTo(Number.MAX_SAFE_INTEGER);
  }, [props.text, contentRect?.height, viewport]);
  useImperativeHandle(ref, () => ({
    page(direction) {
      const next = Math.max(0, Math.min(max, offset + direction * Math.max(viewport / 2, viewport - 20 * s)));
      following.current = next >= max - 1;
      setOffset(next);
      box.current?.scrollTo(next, true);
    },
  }));
  const onScroll = (event: ScrollEvent) => {
    following.current = event.offset >= event.max - 1;
    setOffset(event.offset);
  };
  const clear = colors.panel.slice(0, 7) + "00";
  const fade = (edge: "top" | "bottom") => (
    <Box
      style={{
        position: "absolute",
        inset: { left: 0, right: 0, [edge]: 0 },
        height: Math.min(18 * s, viewport / 4),
        background: { from: [0, edge === "top" ? 0 : 1], to: [0, edge === "top" ? 1 : 0], stops: [{ at: 0, color: colors.panel }, { at: 1, color: clear }] },
      }}
    />
  );
  return (
    <Box style={{ flexDirection: "column", flexShrink: 1, maxHeight: ANSWER_MAX_HEIGHT * s, overflow: "hidden" }}>
      <Box
        ref={box}
        style={{ flexDirection: "column", flexShrink: 1, overflow: "scroll", scrollbar: { width: 3 * s, hoverWidth: 6 * s, margin: 2 * s, thumbColor: colors.faint, thumbHoverColor: colors.muted } }}
        onScroll={onScroll}
      >
        <Box ref={content} style={{ flexDirection: "column", flexShrink: 0, padding: { top: ANSWER_PADDING_TOP * s, left: 6 * s, right: 6 * s } }}>
          <Markdown text={props.text} theme={props.theme} rem={13 * s} streaming={props.streaming} />
        </Box>
      </Box>
      {offset > 0.5 && fade("top")}
      {offset < max - 0.5 && fade("bottom")}
    </Box>
  );
});

function Hint(props: { keys: string; label: string; colors: BarColors; scale: number }) {
  const { colors, scale: s } = props;
  return (
    <Box style={{ flexDirection: "row", alignItems: "center", gap: 4 * s }}>
      <Keys keys={props.keys} fontSize={10 * s} color={colors.muted} />
      <Text style={{ color: colors.faint, fontSize: 10 * s }}>{props.label}</Text>
    </Box>
  );
}

interface MenuItem {
  label: string;
  shortcut?: string;
  enabled?: boolean;
}

export function ContextMenu(props: { items: (MenuItem | "separator")[]; colors: BarColors; scale: number; onPick(index: number): void }) {
  const { colors, scale: s } = props;
  return (
    <Box
      style={{
        flexDirection: "column",
        minWidth: 200 * s,
        padding: { top: 4 * s, bottom: 4 * s, left: 4 * s, right: 4 * s },
        cornerRadius: 7 * s,
        border: { width: Math.max(1, Math.round(s)), color: colors.border },
        background: colors.panel,
      }}
    >
      {props.items.map((item, i) =>
        item === "separator" ? (
          <Box key={i} style={{ height: 1, margin: { top: 4 * s, bottom: 4 * s, left: 6 * s, right: 6 * s }, background: colors.border }} />
        ) : (
          <Box
            key={i}
            style={{
              flexDirection: "row",
              alignItems: "center",
              height: 22 * s,
              padding: { left: 8 * s, right: 8 * s },
              cornerRadius: 4 * s,
              hoverBackground: item.enabled === false ? undefined : colors.hover,
            }}
            onClick={() => {
              if (item.enabled !== false) props.onPick(i);
            }}
          >
            <Text style={{ color: item.enabled === false ? colors.faint : colors.fg, fontSize: 13 * s }}>{item.label}</Text>
            <Box style={{ flexGrow: 1, minWidth: 24 * s }} />
            {item.shortcut && <Keys keys={item.shortcut} fontSize={12 * s} color={colors.faint} />}
          </Box>
        ),
      )}
    </Box>
  );
}
