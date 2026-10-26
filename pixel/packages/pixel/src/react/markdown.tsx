import { memo, useEffect, useMemo, useRef, type MutableRefObject } from "react";

import { Box, Image, Text, type NodeHandle } from "./components";
import {
  HIGHLIGHT_CAPTURES,
  highlight,
  parseMarkdown,
  type MarkdownBlock,
  type MarkdownRow,
  type MarkdownSpan,
} from "./native";
import type { Color, FontFamily } from "./styles";
import type { ClickEvent, TextSpan } from "./reconciler-config";

export interface MarkdownTheme {
  fg: Color;
  muted: Color;
  link: Color;
  inlineCode: Color;
  codeBg: Color;
  separator: Color;
  syntax: Record<string, Color | undefined>;
}

export interface MarkdownProps {
  text: string;
  theme: MarkdownTheme;
  rem: number;
  streaming?: boolean;
  /** The family code blocks draw in. */
  codeFamily?: FontFamily;
  onLinkClick?: (href: string) => void;
  highlight?: { start: number; end: number } | null;
  highlightBg?: Color;
}

const HEADING_SCALE = [1.7, 1.4, 1.2, 1.05, 1, 1] as const;

type Anchors = MutableRefObject<Map<string, NodeHandle>>;

interface Nav {
  anchors: Anchors;
  follow: (href: string) => void;
}

export function Markdown({
  text,
  theme,
  rem,
  streaming,
  codeFamily,
  onLinkClick,
  highlight,
  highlightBg,
}: MarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(text, streaming), [text, streaming]);
  const groups = useMemo(() => groupQuotes(blocks), [blocks]);
  const slugs = useMemo(() => headingSlugs(blocks), [blocks]);
  const anchors = useRef(new Map<string, NodeHandle>());
  const external = useRef(onLinkClick);
  external.current = onLinkClick;
  const nav = useRef<Nav>({
    anchors,
    follow: (href) => {
      if (href.startsWith("#")) {
        anchors.current.get(href.slice(1))?.scrollIntoView(true); // bad api
      } else {
        external.current?.(href);
      }
    },
  });
  const highlighted = (block: MarkdownBlock) =>
    highlight != null && block.sourceEnd > highlight.start && block.sourceStart < highlight.end;
  const firstHighlighted = useRef<NodeHandle | null>(null);
  useEffect(() => {
    if (highlight != null) firstHighlighted.current?.scrollIntoView(true);
  }, [highlight?.start, highlight?.end, text]);
  let highlightSeen = false;
  const blockProps = (block: MarkdownBlock, index: number) => {
    const hit = highlighted(block);
    const first = hit && !highlightSeen;
    if (hit) highlightSeen = true;
    return {
      block,
      index,
      slug: slugs.get(index),
      nav: nav.current,
      theme,
      rem,
      codeFamily,
      highlightBg: hit ? highlightBg ?? theme.codeBg : undefined,
      highlightRef: first ? firstHighlighted : undefined,
    };
  };
  return (
    <Box style={{ flexDirection: "column", gap: rem * 0.55 }}>
      {groups.map((group, i) =>
        group.quote > 0 ? (
          <Box key={i} style={{ gap: rem * 0.6 }}>
            {Array.from({ length: group.quote }, (_, bar) => (
              <Box
                key={bar}
                style={{ width: Math.max(2, rem * 0.18), background: theme.separator }}
              />
            ))}
            <Box style={{ flexDirection: "column", gap: rem * 0.55, flexShrink: 1 }}>
              {group.blocks.map(({ block, index }, j) => (
                <Block key={j} {...blockProps(block, index)} />
              ))}
            </Box>
          </Box>
        ) : (
          <Block key={i} {...blockProps(group.blocks[0].block, group.blocks[0].index)} />
        )
      )}
    </Box>
  );
}

interface QuoteGroup {
  quote: number;
  blocks: { block: MarkdownBlock; index: number }[];
}

function groupQuotes(blocks: MarkdownBlock[]): QuoteGroup[] {
  const groups: QuoteGroup[] = [];
  blocks.forEach((block, index) => {
    const last = groups[groups.length - 1];
    if (block.quote > 0 && last?.quote === block.quote) {
      last.blocks.push({ block, index });
    } else {
      groups.push({ quote: block.quote, blocks: [{ block, index }] });
    }
  });
  return groups;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

function headingSlugs(blocks: MarkdownBlock[]): Map<number, string> {
  const used = new Map<string, number>();
  const out = new Map<number, string>();
  blocks.forEach((block, index) => {
    if (block.kind !== "heading") return;
    const base = slugify(block.text);
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    out.set(index, n === 0 ? base : `${base}-${n}`);
  });
  return out;
}

interface BlockProps {
  block: MarkdownBlock;
  theme: MarkdownTheme;
  rem: number;
  codeFamily?: FontFamily;
  slug?: string;
  nav?: Nav;
  index?: number;
  highlightBg?: Color;
  highlightRef?: MutableRefObject<NodeHandle | null>;
}

const Block = memo(
  function Block({
    block,
    theme,
    rem,
    codeFamily,
    slug,
    nav,
    index,
    highlightBg,
    highlightRef,
  }: BlockProps) {
    let body = (
      <BlockBody
        block={block}
        theme={theme}
        rem={rem}
        codeFamily={codeFamily}
        slug={slug}
        nav={nav}
        index={index}
      />
    );
    if (highlightBg != null) {
      body = (
        <Box
          ref={(handle) => {
            if (highlightRef) highlightRef.current = handle;
          }}
          style={{
            background: highlightBg,
            cornerRadius: rem * 0.25,
            margin: { left: -rem * 0.35, right: -rem * 0.35 },
            padding: { left: rem * 0.35, right: rem * 0.35, top: rem * 0.15, bottom: rem * 0.15 },
          }}
        >
          <Box style={{ flexDirection: "column", flexGrow: 1 }}>{body}</Box>
        </Box>
      );
    }
    if (block.listDepth == null) return body;
    const indent = block.listDepth * rem * 1.3;
    return (
      <Box style={{ margin: { left: indent } }}>
        <Box style={{ width: rem * 1.4, flexShrink: 0 }}>
          {block.itemStart && (
            <Text style={{ color: block.task != null ? theme.link : theme.muted }}>
              {marker(block)}
            </Text>
          )}
        </Box>
        <Box style={{ flexDirection: "column", flexShrink: 1 }}>{body}</Box>
      </Box>
    );
  },
  (a, b) =>
    a.theme === b.theme &&
    a.rem === b.rem &&
    a.codeFamily === b.codeFamily &&
    a.slug === b.slug &&
    a.index === b.index &&
    a.highlightBg === b.highlightBg &&
    a.highlightRef === b.highlightRef &&
    blockEqual(a.block, b.block)
);

function marker(block: MarkdownBlock): string {
  if (block.task != null) return block.task ? "☑" : "□";
  if (block.ordinal != null) return `${block.ordinal}.`;
  return "•";
}

function blockEqual(a: MarkdownBlock, b: MarkdownBlock): boolean {
  return (
    a.kind === b.kind &&
    a.text === b.text &&
    a.level === b.level &&
    a.language === b.language &&
    a.closed === b.closed &&
    a.quote === b.quote &&
    a.listDepth === b.listDepth &&
    a.ordinal === b.ordinal &&
    a.task === b.task &&
    a.itemStart === b.itemStart &&
    a.src === b.src &&
    spansEqual(a.spans, b.spans) &&
    a.aligns.length === b.aligns.length &&
    a.aligns.every((al, i) => al === b.aligns[i]) &&
    a.rows.length === b.rows.length &&
    a.rows.every((row, i) => rowEqual(row, b.rows[i]))
  );
}

function rowEqual(a: MarkdownRow, b: MarkdownRow): boolean {
  return (
    a.cells.length === b.cells.length &&
    a.cells.every(
      (cell, i) => cell.text === b.cells[i].text && spansEqual(cell.spans, b.cells[i].spans)
    )
  );
}

function spansEqual(a: MarkdownSpan[], b: MarkdownSpan[]): boolean {
  return (
    a.length === b.length &&
    a.every((s, i) => {
      const o = b[i];
      return (
        s.start === o.start &&
        s.end === o.end &&
        s.bold === o.bold &&
        s.italic === o.italic &&
        s.strikethrough === o.strikethrough &&
        s.code === o.code &&
        s.link === o.link &&
        s.incompleteLink === o.incompleteLink
      );
    })
  );
}

function blockId(index: number | undefined): string | undefined {
  return index != null ? `md:${index}` : undefined;
}

function BlockBody({ block, theme, rem, codeFamily, slug, nav, index }: BlockProps) {
  switch (block.kind) {
    case "heading": {
      const scale = HEADING_SCALE[block.level - 1] ?? 1;
      return (
        <Text
          id={blockId(index)}
          ref={(handle) => {
            if (!slug || !nav) return;
            if (handle) nav.anchors.current.set(slug, handle);
            else nav.anchors.current.delete(slug);
          }}
          style={{ fontSize: rem * scale, color: theme.fg }}
          spans={styledSpans(block.text, block.spans, theme, { bold: true, cover: true })}
          onClick={linkClick(block.spans, nav)}
        >
          {block.text}
        </Text>
      );
    }
    case "code":
      return (
        <CodeBlock block={block} theme={theme} rem={rem} codeFamily={codeFamily} index={index} />
      );
    case "rule":
      return <Box style={{ height: 1, background: theme.separator }} />;
    case "image":
      return (
        <Image
          src={block.src}
          style={{ height: rem * 8, cornerRadius: rem * 0.4 }}
          placeholder={<Box style={{ background: theme.codeBg }} />}
        />
      );
    case "table":
      return <Table block={block} theme={theme} rem={rem} nav={nav} index={index} />;
    default:
      return (
        <Text
          id={blockId(index)}
          style={{ color: theme.fg }}
          spans={styledSpans(block.text, block.spans, theme, {})}
          onClick={linkClick(block.spans, nav)}
        >
          {block.text}
        </Text>
      );
  }
}

function linkClick(spans: MarkdownSpan[], nav?: Nav) {
  if (!nav || !spans.some((s) => s.link)) return undefined;
  return (event: ClickEvent) => {
    if (event.offset == null) return;
    const hit = spans.find(
      (s) => s.link && s.start <= event.offset! && event.offset! < s.end
    );
    if (hit?.link) nav.follow(hit.link);
  };
}

function styledSpans(
  text: string,
  spans: MarkdownSpan[],
  theme: MarkdownTheme,
  opts: { bold?: boolean; cover?: boolean }
): TextSpan[] | undefined {
  if (!spans.length && !opts.cover) return undefined;
  const styled: TextSpan[] = spans.map((s) => ({
    start: s.start,
    end: s.end,
    color: s.code ? theme.inlineCode : s.link || s.incompleteLink ? theme.link : theme.fg,
    background: s.code ? theme.codeBg : undefined,
    bold: s.bold || opts.bold,
    italic: s.italic,
    underline: Boolean(s.link),
    strikethrough: s.strikethrough,
  }));
  if (!opts.cover) return styled;
  const bytes = Buffer.byteLength(text);
  const covered: TextSpan[] = [];
  let at = 0;
  for (const span of styled) {
    if (span.start > at) covered.push({ start: at, end: span.start, color: theme.fg, bold: opts.bold });
    covered.push(span);
    at = span.end;
  }
  if (at < bytes) covered.push({ start: at, end: bytes, color: theme.fg, bold: opts.bold });
  return covered;
}

const CELL_JUSTIFY = { left: "start", center: "center", right: "end", none: "start" } as const;

function Table({ block, theme, rem, nav, index }: BlockProps) {
  const columns = block.rows[0]?.cells.length ?? 0;
  const weights = Array.from({ length: columns }, (_, c) =>
    Math.min(
      42,
      Math.max(3, ...block.rows.map((row) => row.cells[c]?.text.length ?? 0))
    )
  );
  if (columns === 0) return null;
  return (
    <Box
      style={{
        flexDirection: "column",
        border: { width: 1, color: theme.separator },
        padding: 1,
        overflow: "hidden",
      }}
    >
      {block.rows.map((row, r) => (
        <Box
          key={r}
          style={{
            background: r === 0 ? theme.codeBg : undefined,
            border: r > 0 ? { top: [1, theme.separator] } : undefined,
          }}
        >
          {Array.from({ length: columns }, (_, c) => {
            const cell = row.cells[c];
            const align = block.aligns[c] ?? "none";
            return (
              <Box
                key={c}
                style={{
                  flexGrow: weights[c],
                  flexBasis: 0,
                  justifyContent: CELL_JUSTIFY[align],
                  border: c > 0 ? { left: [1, theme.separator] } : undefined,
                  padding: {
                    left: rem * 0.6,
                    right: rem * 0.6,
                    top: rem * 0.35,
                    bottom: rem * 0.35,
                  },
                }}
              >
                {cell && (
                  <Text
                    id={blockId(index)}
                    style={{ color: theme.fg }}
                    spans={styledSpans(cell.text, cell.spans, theme, {
                      bold: r === 0,
                      cover: r === 0,
                    })}
                    onClick={linkClick(cell.spans, nav)}
                  >
                    {cell.text}
                  </Text>
                )}
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

function CodeBlock({ block, theme, rem, codeFamily, index }: BlockProps) {
  const spans = useMemo(
    () =>
      highlight(block.text, block.language).map((s) => ({
        start: s.start,
        end: s.end,
        color: theme.syntax[HIGHLIGHT_CAPTURES[s.capture]] ?? theme.fg,
      })),
    [block.text, block.language, theme]
  );
  return (
    <Box
      style={{
        flexDirection: "column",
        background: theme.codeBg,
        cornerRadius: rem * 0.35,
        padding: { left: rem * 0.75, right: rem * 0.75, top: rem * 0.5, bottom: rem * 0.5 },
        gap: rem * 0.35,
        overflow: "hidden",
      }}
    >
      {block.language !== "" && (
        <Text style={{ color: theme.muted, fontSize: rem * 0.8 }}>
          {block.language + (block.closed ? "" : " …")}
        </Text>
      )}
      <Text
        id={blockId(index)}
        style={{ wrap: false, color: theme.fg, fontFamily: codeFamily ?? "monospace" }}
        spans={spans}
      >
        {block.text}
      </Text>
    </Box>
  );
}
