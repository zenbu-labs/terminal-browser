import { useEffect, useRef, useState } from "react";
import type { MutableRefObject, ReactNode } from "react";

import { Box, Text, useRect } from "@zenbu-labs/pixel";
import type { NodeHandle, Rect } from "@zenbu-labs/pixel";

import type { BarColors } from "./sizes";
import { Icon } from "./icons";
import { effortLabel } from "../ai/models";
import type { AiChoice, Harness, ModelOption } from "../ai/models";

export interface ModelGroup {
  harness: Harness;
  title: string;
  models: ModelOption[];
  note: string | null;
  enabled: boolean;
}

interface ModelMenuProps {
  colors: BarColors;
  scale: number;
  frame: { width: number; height: number };
  groups: ModelGroup[];
  choice: AiChoice;
  conversation: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  onChoice(choice: AiChoice): void;
  keys: MutableRefObject<((key: string) => boolean) | null>;
  onRect?(rect: Rect | null): void;
  children(open: boolean): ReactNode;
}

type Submenu = "effort" | "model";

type Row = { kind: "toggle"; label: string; on: boolean; set(on: boolean): void } | { kind: "submenu"; label: string; value: string; submenu: Submenu } | { kind: "divider" };

type Option =
  | { kind: "header"; key: string; label: string; note: string | null }
  | { kind: "option"; key: string; label: string; hint?: string; detail: string[]; selected: boolean; enabled: boolean; pick(): void };

// fixme: placeholder copy
const COPY = { fast: "Fast", effort: "Effort", model: "Model", defaultEffort: "Default", newChat: (title: string) => `Starts a new chat with ${title}` };

function wrap(index: number, length: number) {
  return (index + length) % length;
}

export function ModelMenu(props: ModelMenuProps) {
  const { colors, scale: s, groups, choice, open } = props;
  const [submenu, setSubmenu] = useState<Submenu | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [optionCursor, setOptionCursor] = useState<number | null>(null);
  const trigger = useRef<NodeHandle>(null);
  const popover = useRef<NodeHandle>(null);
  const popoverRect = useRect(popover);
  const rect = useRect(trigger);
  const models = groups.flatMap((group) => group.models);
  const model = models.find((m) => m.harness === choice.harness && m.id === choice.model) ?? null;
  const levels = model?.efforts ?? [];
  const effort = choice.effort ?? model?.defaultEffort ?? null;
  const rowHeight = Math.round(22 * s);
  const dividerHeight = Math.round(9 * s);
  const headerHeight = Math.round(20 * s);
  const inset = Math.round(4 * s);
  const gap = Math.round(6 * s);
  const fontSize = 12 * s;

  const close = () => {
    setSubmenu(null);
    setCursor(null);
    setOptionCursor(null);
    props.onOpenChange(false);
  };

  const pickModel = (next: ModelOption) => {
    const effort = choice.effort && next.efforts.some((e) => e.level === choice.effort) ? choice.effort : next.harness === "codex" ? next.defaultEffort : null;
    props.onChoice({ harness: next.harness, model: next.id, effort, fast: choice.fast && next.fastTier != null });
  };

  const rows: Row[] = [
    ...(model?.fastTier ? [{ kind: "toggle" as const, label: COPY.fast, on: choice.fast, set: (fast: boolean) => props.onChoice({ ...choice, fast }) }] : []),
    ...(levels.length ? [{ kind: "submenu" as const, label: COPY.effort, value: effort ? effortLabel(effort) : COPY.defaultEffort, submenu: "effort" as const }] : []),
    ...(model?.fastTier || levels.length ? [{ kind: "divider" as const }] : []),
    { kind: "submenu", label: COPY.model, value: model ? (model.hint ?? model.name) : choice.model, submenu: "model" },
  ];

  const effortOptions: Option[] = [
    ...(choice.harness === "claude" ? [{ level: null, description: "" }] : []),
    ...levels,
  ].map(({ level, description }) => ({
    kind: "option",
    key: level ?? "default",
    label: level ? effortLabel(level) : COPY.defaultEffort,
    detail: description ? [description] : [],
    selected: level === effort,
    enabled: true,
    pick: () => props.onChoice({ ...choice, effort: level }),
  }));

  const modelOptions: Option[] = groups.flatMap((group) => [
    { kind: "header" as const, key: `header-${group.harness}`, label: group.title, note: group.note },
    ...group.models.map((m): Option => ({
      kind: "option",
      key: `${m.harness}-${m.id}`,
      label: m.name,
      hint: m.hint,
      detail: [...m.details, ...(props.conversation && m.harness !== choice.harness ? [COPY.newChat(group.title)] : [])],
      selected: m === model,
      enabled: group.enabled,
      pick: () => {
        pickModel(m);
        close();
      },
    })),
  ]);

  const options = submenu === "effort" ? effortOptions : submenu === "model" ? modelOptions : [];
  const pickable = options.flatMap((option, i) => (option.kind === "option" && option.enabled ? [i] : []));

  const focusRow = (index: number) => {
    const row = rows[index];
    setCursor(index);
    setSubmenu(row.kind === "submenu" ? row.submenu : null);
    setOptionCursor(null);
  };

  const enterOptions = () => {
    const selected = options.findIndex((o) => o.kind === "option" && o.selected);
    setOptionCursor(pickable.includes(selected) ? selected : (pickable[0] ?? null));
  };

  useEffect(() => {
    if (!open) {
      setSubmenu(null);
      setCursor(null);
      setOptionCursor(null);
    }
  }, [open]);

  const handleKey = (key: string) => {
    const nav = key === "up" ? -1 : key === "down" ? 1 : 0;
    if (optionCursor !== null) {
      const option = options[optionCursor];
      if (nav && pickable.length) setOptionCursor(pickable[wrap(pickable.indexOf(optionCursor) + nav, pickable.length)]);
      else if (key === "enter" && option?.kind === "option") option.pick();
      else if (key === "left" || key === "escape") setOptionCursor(null);
      else return false;
      return true;
    }
    const selectable = rows.flatMap((row, i) => (row.kind === "divider" ? [] : [i]));
    const row = cursor === null ? null : rows[cursor];
    if (nav) {
      const at = cursor === null ? (nav < 0 ? 0 : -1) : selectable.indexOf(cursor);
      focusRow(selectable[wrap(at + nav, selectable.length)]);
    } else if (row?.kind === "toggle" && key === "enter") row.set(!row.on);
    else if (row?.kind === "submenu" && (key === "enter" || key === "right")) enterOptions();
    else if (key === "escape") close();
    else return false;
    return true;
  };

  useEffect(() => {
    props.keys.current = open ? handleKey : null;
  });

  useEffect(() => {
    props.onRect?.(open ? popoverRect : null);
  }, [open, popoverRect?.x, popoverRect?.y, popoverRect?.width, popoverRect?.height]);

  useEffect(() => () => props.onRect?.(null), []);

  const heightOf = (row: Row) => (row.kind === "divider" ? dividerHeight : rowHeight);
  const menuWidth = Math.round(190 * s);
  const listWidth = Math.round(270 * s);
  const detailLines = options.some((o) => o.kind === "option" && o.detail.length) ? 3 : 0;
  const detailLineHeight = Math.round(15 * s);
  const detailHeight = detailLines ? dividerHeight + detailLines * detailLineHeight + inset : 0;
  const optionsHeight = options.reduce((sum, o) => sum + (o.kind === "header" ? headerHeight + (o.note ? detailLineHeight : 0) : rowHeight), 0);

  const triggerHeight = rect?.height ?? rowHeight;
  const up = rect ? rect.y > props.frame.height - (rect.y + rect.height) : true;
  const room = Math.max(rowHeight * 3, (rect ? (up ? rect.y : props.frame.height - rect.y - rect.height) : props.frame.height / 2) - gap - inset * 2);
  const leftRoom = rect ? rect.x + rect.width - inset : props.frame.width;
  const stacked = menuWidth + gap + listWidth > leftRoom;
  const onlyClickSwitchesLists = stacked;
  const anchor = rows.findIndex((row) => row.kind === "submenu" && row.submenu === submenu);
  const along = (up ? rows.slice(anchor + 1) : rows.slice(0, Math.max(0, anchor))).reduce((sum, row) => sum + heightOf(row), 0);
  const listHeight = Math.min(optionsHeight, room - detailHeight - 2 * inset) + detailHeight + 2 * inset;
  const lift = stacked ? 0 : Math.max(0, Math.min(along, room - listHeight));

  const optionList = options.length > 0 && (
    <Box
      style={{
        width: listWidth,
        margin: up ? { bottom: lift } : { top: lift },
        flexDirection: "column",
        padding: { top: inset, right: inset, bottom: inset, left: inset },
        cornerRadius: 7 * s,
        border: { width: Math.max(1, Math.round(s)), color: colors.border },
        background: colors.panel,
      }}
    >
      <Box style={{ flexDirection: "column", maxHeight: room - detailHeight - 2 * inset, overflow: "scroll" }}>
        {options.map((option, i) =>
          option.kind === "header" ? (
            <Box key={option.key} style={{ flexDirection: "column", padding: { left: 8 * s, right: 6 * s }, justifyContent: "end" }}>
              <Box style={{ height: headerHeight, flexDirection: "row", alignItems: "end", padding: { bottom: 3 * s } }}>
                <Text style={{ color: colors.faint, fontSize: 11 * s, selectable: false }}>{option.label}</Text>
              </Box>
              {option.note && (
                <Box style={{ height: detailLineHeight, flexDirection: "row", alignItems: "center" }}>
                  <Text style={{ color: colors.muted, fontSize: 11 * s, selectable: false }}>{option.note}</Text>
                </Box>
              )}
            </Box>
          ) : (
            <MenuRow key={option.key} colors={colors} scale={s} height={rowHeight} active={i === optionCursor} enabled={option.enabled} onHover={() => option.enabled && setOptionCursor(i)} onClick={() => option.enabled && option.pick()}>
              <Box style={{ flexDirection: "row", alignItems: "center", gap: 6 * s }}>
                <Text style={{ color: option.enabled ? colors.fg : colors.faint, fontSize, selectable: false }}>{option.label}</Text>
                {option.hint && <Text style={{ color: colors.muted, fontSize, selectable: false }}>{option.hint}</Text>}
              </Box>
              <Box style={{ width: 12 * s, height: 12 * s }}>{option.selected && <Icon name="check" size={12 * s} color={colors.fg} />}</Box>
            </MenuRow>
          ),
        )}
      </Box>
      {detailLines > 0 && <OptionDetail option={options[optionCursor ?? options.findIndex((o) => o.kind === "option" && o.selected)]} colors={colors} scale={s} lines={detailLines} lineHeight={detailLineHeight} dividerHeight={dividerHeight} />}
    </Box>
  );

  return (
    <Box>
      <Box ref={trigger} style={{ pointerShape: "pointer" }} onClick={() => (open ? close() : props.onOpenChange(true))}>
        {props.children(open)}
      </Box>
      {open && (
        <Box
          ref={popover}
          style={{
            position: "absolute",
            inset: up ? { right: 0, bottom: triggerHeight + gap } : { right: 0, top: triggerHeight + gap },
            flexDirection: stacked ? "column" : "row",
            alignItems: stacked ? "end" : up ? "end" : "start",
            gap,
          }}
          onClickOutside={close}
        >
          {(up || !stacked) && optionList}
          <Box
            style={{
              width: menuWidth,
              flexDirection: "column",
              padding: { top: inset, right: inset, bottom: inset, left: inset },
              cornerRadius: 7 * s,
              border: { width: Math.max(1, Math.round(s)), color: colors.border },
              background: colors.panel,
            }}
          >
            {rows.map((row, i) =>
              row.kind === "divider" ? (
                <Box key={i} style={{ height: dividerHeight, flexDirection: "column", justifyContent: "center", padding: { left: 6 * s, right: 6 * s } }}>
                  <Box style={{ height: Math.max(1, Math.round(s)), background: colors.border }} />
                </Box>
              ) : (
                <MenuRow
                  key={row.label}
                  colors={colors}
                  scale={s}
                  height={rowHeight}
                  active={row.kind === "submenu" ? row.submenu === submenu : i === cursor}
                  enabled
                  onHover={() => (onlyClickSwitchesLists ? setCursor(i) : focusRow(i))}
                  onClick={() => (row.kind === "toggle" ? row.set(!row.on) : focusRow(i))}
                >
                  <Text style={{ color: colors.fg, fontSize, selectable: false }}>{row.label}</Text>
                  {row.kind === "toggle" ? (
                    <Toggle on={row.on} colors={colors} scale={s} />
                  ) : (
                    <Box style={{ flexDirection: "row", alignItems: "center", gap: 3 * s }}>
                      <Text style={{ color: colors.muted, fontSize, selectable: false }}>{row.value}</Text>
                      <Icon name="chevron-right" size={11 * s} color={colors.muted} />
                    </Box>
                  )}
                </MenuRow>
              ),
            )}
          </Box>
          {!up && stacked && optionList}
        </Box>
      )}
    </Box>
  );
}

function MenuRow(props: { colors: BarColors; scale: number; height: number; active: boolean; enabled: boolean; onHover(): void; onClick(): void; children: ReactNode }) {
  const { colors, scale: s } = props;
  return (
    <Box
      style={{
        height: props.height,
        flexShrink: 0,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16 * s,
        padding: { left: 8 * s, right: 6 * s },
        cornerRadius: 4 * s,
        background: props.active ? colors.hover : undefined,
        hoverBackground: props.enabled ? colors.hover : undefined,
        pointerShape: props.enabled ? "pointer" : undefined,
      }}
      onMouseEnter={props.onHover}
      onClick={props.onClick}
    >
      {props.children}
    </Box>
  );
}

function OptionDetail(props: { option: Option | undefined; colors: BarColors; scale: number; lines: number; lineHeight: number; dividerHeight: number }) {
  const { colors, scale: s } = props;
  const detail = props.option?.kind === "option" ? props.option.detail : [];
  return (
    <Box style={{ flexDirection: "column", padding: { left: 8 * s, right: 6 * s, bottom: 4 * s } }}>
      <Box style={{ height: props.dividerHeight, flexDirection: "column", justifyContent: "center" }}>
        <Box style={{ height: Math.max(1, Math.round(s)), background: colors.border }} />
      </Box>
      <Box style={{ height: props.lines * props.lineHeight, flexDirection: "column", overflow: "hidden" }}>
        {detail.map((part, i) => (
          <Text key={i} style={{ color: colors.muted, fontSize: 11 * s, selectable: false }}>
            {part}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function Toggle(props: { on: boolean; colors: BarColors; scale: number }) {
  const { colors, scale: s } = props;
  const height = Math.round(14 * s);
  const width = Math.round(height * 1.75);
  const pad = Math.max(2, Math.round(2 * s));
  const knob = height - 2 * pad;
  return (
    <Box style={{ width, height, cornerRadius: height / 2, background: props.on ? colors.on : colors.border }}>
      <Box style={{ position: "absolute", inset: props.on ? { top: pad, right: pad } : { top: pad, left: pad }, width: knob, height: knob, cornerRadius: knob / 2, background: colors.knob }} />
    </Box>
  );
}

export function ModelTrigger(props: { label: string; open: boolean; colors: BarColors; scale: number }) {
  const { colors, scale: s } = props;
  const [hovered, setHovered] = useState(false);
  const color = props.open || hovered ? colors.fg : colors.faint;
  return (
    <Box
      style={{ flexDirection: "row", alignItems: "center", gap: 3 * s, height: 19 * s, padding: { left: 5 * s, right: 4 * s }, cornerRadius: 4 * s, background: props.open ? colors.hover : undefined, hoverBackground: colors.hover }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Text style={{ color, fontSize: 11 * s, selectable: false }}>{props.label}</Text>
      <Icon name="chevron-down" size={10 * s} color={color} />
    </Box>
  );
}
