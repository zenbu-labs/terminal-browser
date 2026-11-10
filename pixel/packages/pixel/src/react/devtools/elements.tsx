import React, { useEffect, useMemo } from "react";

import { Box, Text } from "../components";
import { APP_VIEW, devtoolsBridge, Instance } from "../reconciler-config";
import {
  findInstance,
  HighlightArea,
  selectNode,
  setHighlight,
  setPicking,
  toggleExpanded,
} from "./controller";
import { BoxEdges, inspectorStore, LayoutRect, layoutStore } from "./stores";
import { useStore } from "./store";
import { MONO, theme } from "./theme";
import { Button, Divider, Empty, Toolbar } from "./ui";

interface Row {
  instance: Instance;
  depth: number;
  expandable: boolean;
}

function flattenTree(expanded: ReadonlySet<number>): Row[] {
  const container = devtoolsBridge().containers[APP_VIEW];
  if (!container) return [];
  const rows: Row[] = [];
  const walk = (instance: Instance, depth: number) => {
    const expandable = instance.children.length > 0;
    rows.push({ instance, depth, expandable });
    if (expandable && expanded.has(instance.id)) {
      for (const child of instance.children) walk(child, depth + 1);
    }
  };
  for (const child of container.children) walk(child, 0);
  return rows;
}

function label(instance: Instance): { tag: string; text: string | null } {
  const tag = instance.type;
  if (instance.type === "text") {
    const kids = instance.props.children;
    const text = Array.isArray(kids) ? kids.join("") : String(kids ?? "");
    return { tag, text: text.length > 40 ? `${text.slice(0, 40)}…` : text };
  }
  return { tag, text: null };
}

function ElementRow(props: { row: Row; selected: boolean; expanded: boolean; rem: number }) {
  const { row, selected, expanded, rem } = props;
  const { instance } = row;
  const { tag, text } = label(instance);
  return (
    <Box
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: rem * 0.3,
        padding: {
          left: rem * 0.5 + row.depth * rem * 0.9,
          right: rem * 0.4,
          top: rem * 0.08,
          bottom: rem * 0.08,
        },
        background: selected ? theme.selectionBg : undefined,
        hoverBackground: selected ? theme.selectionBg : theme.hover,
      }}
      onClick={() => {
        if (row.expandable) toggleExpanded(instance.id);
        selectNode(instance.id);
      }}
      onMouseEnter={() => setHighlight(instance.id)}
      onMouseLeave={() => setHighlight(null)}
    >
      <Text
        style={{
          color: row.expandable ? theme.dim : theme.faint,
          fontSize: rem * 0.7,
          fontFamily: MONO,
          wrap: false,
          flexShrink: 0,
        }}
      >
        {row.expandable ? (expanded ? "-" : "+") : " "}
      </Text>
      <Text style={{ color: theme.tag, fontSize: rem * 0.74, fontFamily: MONO, wrap: false }}>
        {`<${tag}>`}
      </Text>
      {instance.props.id && (
        <Text style={{ color: theme.attrName, fontSize: rem * 0.7, fontFamily: MONO, wrap: false }}>
          {`#${instance.props.id}`}
        </Text>
      )}
      {text && (
        <Box style={{ flexShrink: 1, overflow: "hidden" }}>
          <Text style={{ color: theme.dim, fontSize: rem * 0.7, fontFamily: MONO, wrap: false }}>
            {`"${text}"`}
          </Text>
        </Box>
      )}
    </Box>
  );
}

const ZERO_EDGES: BoxEdges = { l: 0, t: 0, r: 0, b: 0 };

const BOX_COLORS: Record<HighlightArea, { bg: string; hover: string }> = {
  margin: { bg: "#f6b26bb8", hover: "#f6b26b" },
  border: { bg: "#ffe599b8", hover: "#ffe599" },
  padding: { bg: "#93c47db8", hover: "#93c47d" },
  content: { bg: "#6fa8dcb8", hover: "#6fa8dc" },
};

const BOX_TEXT = "#1c1e21";

function formatPx(value: number): string {
  return `${Math.round(value * 10) / 10}`;
}

function BoxValue(props: { value: string; rem: number }) {
  return (
    <Text style={{ color: BOX_TEXT, fontSize: props.rem * 0.62, fontFamily: MONO, wrap: false }}>
      {props.value}
    </Text>
  );
}

function BoxRing(props: {
  id: number;
  area: HighlightArea;
  edges: BoxEdges;
  rem: number;
  children: React.ReactNode;
}) {
  const { id, area, edges, rem, children } = props;
  const colors = BOX_COLORS[area];
  const edge = (v: number) => (v === 0 ? "-" : formatPx(v));
  return (
    <Box
      style={{
        flexDirection: "column",
        alignItems: "center",
        background: colors.bg,
        hoverBackground: colors.hover,
        padding: { left: rem * 0.45, right: rem * 0.45, top: rem * 0.1, bottom: rem * 0.1 },
      }}
      onMouseEnter={() => setHighlight(id, area)}
      onMouseLeave={() => setHighlight(null)}
    >
      <Box style={{ position: "absolute", inset: { left: rem * 0.25, top: rem * 0.12 } }}>
        <Text style={{ color: BOX_TEXT, fontSize: rem * 0.56, fontFamily: MONO, wrap: false }}>
          {area}
        </Text>
      </Box>
      <BoxValue rem={rem} value={edge(edges.t)} />
      <Box style={{ flexDirection: "row", alignItems: "center", gap: rem * 0.45 }}>
        <BoxValue rem={rem} value={edge(edges.l)} />
        {children}
        <BoxValue rem={rem} value={edge(edges.r)} />
      </Box>
      <BoxValue rem={rem} value={edge(edges.b)} />
    </Box>
  );
}

function BoxModel(props: { id: number; rect: LayoutRect; rem: number }) {
  const { id, rect, rem } = props;
  const padding = rect.padding ?? ZERO_EDGES;
  const border = rect.border ?? ZERO_EDGES;
  const margin = rect.margin ?? ZERO_EDGES;
  const contentW = Math.max(0, rect.w - border.l - border.r - padding.l - padding.r);
  const contentH = Math.max(0, rect.h - border.t - border.b - padding.t - padding.b);
  return (
    <Box style={{ flexDirection: "column", alignItems: "center", padding: rem * 0.4 }}>
      <BoxRing id={id} area="margin" edges={margin} rem={rem}>
        <BoxRing id={id} area="border" edges={border} rem={rem}>
          <BoxRing id={id} area="padding" edges={padding} rem={rem}>
            <Box
              style={{
                background: BOX_COLORS.content.bg,
                hoverBackground: BOX_COLORS.content.hover,
                padding: { left: rem * 0.7, right: rem * 0.7, top: rem * 0.18, bottom: rem * 0.18 },
              }}
              onMouseEnter={() => setHighlight(id, "content")}
              onMouseLeave={() => setHighlight(null)}
            >
              <BoxValue rem={rem} value={`${formatPx(contentW)} × ${formatPx(contentH)}`} />
            </Box>
          </BoxRing>
        </BoxRing>
      </BoxRing>
    </Box>
  );
}

function formatValue(value: unknown): string {
  return (
    JSON.stringify(value, (_key, v: unknown) =>
      typeof v === "number" ? Math.round(v * 100) / 100 : v
    ) ?? ""
  );
}

function DetailRow(props: { name: string; value: string; rem: number; color?: string }) {
  const { name, value, rem } = props;
  return (
    <Box style={{ flexDirection: "row", gap: rem * 0.5, padding: { left: rem * 0.5, top: 1, bottom: 1 } }}>
      <Box style={{ width: rem * 6.5, flexShrink: 0 }}>
        <Text style={{ color: theme.attrName, fontSize: rem * 0.7, fontFamily: MONO, wrap: false }}>
          {name}
        </Text>
      </Box>
      <Box style={{ flexGrow: 1, flexBasis: 0, overflow: "hidden" }}>
        <Text style={{ color: props.color ?? theme.attrValue, fontSize: rem * 0.7, fontFamily: MONO }}>
          {value}
        </Text>
      </Box>
    </Box>
  );
}

function Details(props: { instance: Instance | null; rect: LayoutRect | null; rem: number }) {
  const { instance, rect, rem } = props;
  if (!instance) {
    return <Empty rem={rem} text="Select an element to inspect it." />;
  }
  const style = instance.props.style ?? {};
  const handlers = (["onClick", "onScroll", "onChange", "onSubmit"] as const).filter(
    (name) => typeof (instance.props as Record<string, unknown>)[name] === "function"
  );
  return (
    <Box style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, overflow: "scroll" }}>
      <Box
        style={{
          flexDirection: "row",
          gap: rem * 0.4,
          padding: rem * 0.4,
          alignItems: "center",
        }}
      >
        <Text style={{ color: theme.tag, fontSize: rem * 0.8, fontFamily: MONO, wrap: false }}>
          {`<${instance.type}>`}
        </Text>
        {instance.props.id && (
          <Text style={{ color: theme.attrName, fontSize: rem * 0.74, fontFamily: MONO, wrap: false }}>
            {`#${instance.props.id}`}
          </Text>
        )}
        <Text style={{ color: theme.faint, fontSize: rem * 0.68, fontFamily: MONO, wrap: false }}>
          {`node ${instance.id}`}
        </Text>
      </Box>
      <Divider />
      {rect && <BoxModel id={instance.id} rect={rect} rem={rem} />}
      {rect ? (
        <Box style={{ flexDirection: "column", padding: { top: rem * 0.25, bottom: rem * 0.25 } }}>
          <DetailRow rem={rem} name="position" value={`${rect.x.toFixed(0)}, ${rect.y.toFixed(0)}`} />
          <DetailRow rem={rem} name="size" value={`${rect.w.toFixed(0)} × ${rect.h.toFixed(0)}`} />
          {rect.vw !== rect.w || rect.vh !== rect.h ? (
            <DetailRow
              rem={rem}
              name="visible"
              value={`${rect.vw.toFixed(0)} × ${rect.vh.toFixed(0)}`}
            />
          ) : null}
          {rect.scrollMax != null && (
            <DetailRow
              rem={rem}
              name="scroll"
              value={`${(rect.scroll ?? 0).toFixed(0)} / ${rect.scrollMax.toFixed(0)}`}
            />
          )}
        </Box>
      ) : (
        <DetailRow rem={rem} name="layout" value="(no rect yet)" color={theme.faint} />
      )}
      <Divider />
      <Box style={{ flexDirection: "column", padding: { top: rem * 0.25, bottom: rem * 0.25 } }}>
        {Object.entries(style).map(([name, value]) => (
          <DetailRow key={name} rem={rem} name={name} value={formatValue(value)} />
        ))}
        {Object.keys(style).length === 0 && (
          <DetailRow rem={rem} name="style" value="(default)" color={theme.faint} />
        )}
        {handlers.map((name) => (
          <DetailRow key={name} rem={rem} name={name} value="f()" color={theme.accent} />
        ))}
      </Box>
    </Box>
  );
}

export function ElementsPanel(props: { rem: number }) {
  const { rem } = props;
  const inspector = useStore(inspectorStore);
  const layout = useStore(layoutStore);

  const rows = useMemo(
    () => flattenTree(inspector.expanded),
    [inspector.expanded, inspector.treeVersion]
  );

  useEffect(() => () => setHighlight(null), []);

  useEffect(() => {
    if (inspector.expanded.size > 0 || rows.length === 0) return;
    const expanded = new Set<number>();
    for (const row of rows) {
      if (row.depth < 3 && row.expandable) expanded.add(row.instance.id);
    }
    inspectorStore.update((s) => ({ ...s, expanded }));
  }, [rows, inspector.expanded.size]);

  const selected =
    inspector.selectedId != null ? findInstance(inspector.selectedId) : null;
  const rect =
    selected != null ? layout.rects.get(selected.id) ?? null : null;

  return (
    <Box style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, overflow: "hidden" }}>
      <Toolbar rem={rem}>
        <Button
          rem={rem}
          label={inspector.picking ? "Picking… (esc)" : "Pick"}
          active={inspector.picking}
          onClick={() => setPicking(!inspector.picking)}
        />
        <Text style={{ color: theme.faint, fontSize: rem * 0.68, wrap: false }}>
          {`${layout.rects.size} nodes`}
        </Text>
      </Toolbar>
      <Divider />
      {rows.length === 0 ? (
        <Empty rem={rem} text="The app has not rendered anything yet." />
      ) : (
        <Box
          style={{ flexDirection: "column", flexGrow: 3, flexBasis: 0, overflow: "scroll" }}
        >
          {rows.map((row) => (
            <ElementRow
              key={row.instance.id}
              row={row}
              rem={rem}
              selected={inspector.selectedId === row.instance.id}
              expanded={inspector.expanded.has(row.instance.id)}
            />
          ))}
        </Box>
      )}
      <Divider />
      <Box
        style={{
          flexDirection: "column",
          flexGrow: 2,
          flexBasis: 0,
          overflow: "hidden",
          background: theme.panel,
        }}
      >
        <Details instance={selected} rect={rect} rem={rem} />
      </Box>
    </Box>
  );
}
