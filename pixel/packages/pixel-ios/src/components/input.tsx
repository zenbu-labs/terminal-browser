import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Box } from "@zenbu-labs/pixel/device";
import type { DeviceRoot, NativeInputProps, MarkRef, NodeHandle } from "@zenbu-labs/pixel/device";

import { useNativeView } from "../native-views";
import type { NativeViewEvent } from "../native-views";

interface InputEvent extends NativeViewEvent {
  name?: string;
  text?: string;
  source?: "type" | "paste" | "edit";
  selection?: [number, number];
  marks?: { id: number; at: number }[];
  caret?: [number, number, number, number];
  height?: number;
  key?: string;
  mods?: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean };
}

const BAR = { minHeight: 44, padding: 12, button: 36 };
const encoder = new TextEncoder();

const bytes = (text: string, utf16: number) => encoder.encode(text.slice(0, utf16)).length;

function utf16At(text: string, byteOffset: number): number {
  let used = 0;
  let index = 0;
  for (const ch of text) {
    if (used >= byteOffset) break;
    used += encoder.encode(ch).length;
    index += ch.length;
  }
  return index;
}

function rgba(color: unknown): number[] | undefined {
  if (Array.isArray(color)) return [color[0], color[1], color[2], color[3] ?? 255];
  if (typeof color === "string" && /^#?[0-9a-f]{6}$/i.test(color)) {
    const hex = color.replace("#", "");
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(255);
  }
  return undefined;
}

export function makeInput(root: DeviceRoot) {
  return forwardRef<NodeHandle, NativeInputProps>(function Input(props, ref) {
    const text = useRef(props.value ?? props.defaultValue ?? "");
    const marks = useRef<MarkRef[]>(props.defaultMarks ?? []);
    const handlers = useRef(props);
    handlers.current = props;
    const scale = root.displayScale;
    const [height, setHeight] = useState(Math.round(root.info.cellHeight * 1.4));
    const multiline = props.style?.wrap !== false;
    const fontPx = typeof props.style?.fontSize === "number" ? props.style.fontSize : root.info.basePx;
    const color = useMemo(() => rgba(props.style?.color), [props.style?.color]);
    const labels = (list: MarkRef[], value: string) =>
      list.map((mark) => ({ id: mark.id, at: utf16At(value, mark.offset), label: handlers.current.markLabel?.(mark.id) ?? "" }));

    const view = useNativeView(root, "input", (event: InputEvent) => {
      const current = handlers.current;
      if (event.type === "height" && event.height) setHeight(Math.ceil(event.height * scale));
      if (event.type === "input" || event.type === "caret") {
        if (event.text != null) text.current = event.text;
        const value = text.current;
        if (event.marks) marks.current = event.marks.map((mark) => ({ id: mark.id, offset: bytes(value, mark.at) }));
        const cursor = bytes(value, event.selection?.[1] ?? value.length);
        const [x, y, w, h] = (event.caret ?? [0, 0, 0, 0]).map((v) => v * scale);
        if (event.type === "input") current.onChange?.(value, { cursor, x, y, w, h, source: event.source ?? "type", marks: marks.current });
        current.onCaret?.({ cursor, x, y, w, h });
      }
      if (event.type === "tapped") root.hostTap({ x: 0, y: 0, target: "input" });
      if (event.type === "accessory" && event.name) {
        if (event.name === "send") current.onSubmit?.(text.current, marks.current);
        else current.onAccessory?.(event.name);
      }
      if (event.type === "key" && event.key) {
        const mods = event.mods ?? { shift: false, ctrl: false, alt: false, meta: false };
        if (root.hostKey({ key: event.key, kind: "press", mods: { shift: mods.shift, ctrl: mods.ctrl, alt: mods.alt, super: mods.meta } })) return;
        if (event.key === "enter") current.onSubmit?.(text.current, marks.current);
        else if (event.key === "up" || event.key === "down") view.configure({ caret: event.key });
      }
    });

    useEffect(() => {
      view.configure({ fontSize: fontPx / scale, color, multiline, text: text.current, marks: labels(marks.current, text.current), focus: props.autoFocus === true });
    }, [view.id]);

    useEffect(() => view.configure({ fontSize: fontPx / scale, color, multiline }), [view.id, fontPx, color, multiline]);

    const leading = props.accessories?.leading ?? null;
    const trailing = props.accessories?.trailing ?? null;
    useEffect(() => view.configure({ bar: BAR, accessories: { leading, trailing } }), [view.id, leading, trailing]);

    const leadingMenu = JSON.stringify(props.accessoryMenu ?? []);
    useEffect(() => view.configure({ leadingMenu: JSON.parse(leadingMenu) }), [view.id, leadingMenu]);

    useEffect(() => {
      if (props.value != null && props.value !== text.current) {
        text.current = props.value;
        view.configure({ text: props.value, marks: [] });
      }
    }, [view.id, props.value]);

    const sentLabels = useRef(new Map<number, string>());
    useEffect(() => {
      for (const mark of marks.current) {
        const label = handlers.current.markLabel?.(mark.id) ?? "";
        if (!label || sentLabels.current.get(mark.id) === label) continue;
        sentLabels.current.set(mark.id, label);
        view.configure({ removeMark: mark.id });
        view.configure({ addMark: { id: mark.id, at: utf16At(text.current, mark.offset), label } });
      }
    });

    useImperativeHandle(
      ref,
      () => ({
        id: view.id,
        focus: () => view.configure({ focus: true }),
        blur: () => view.configure({ blur: true }),
        scrollTo: () => {},
        scrollIntoView: () => {},
        splice: (start: number, end: number, value: string) => {
          const from = utf16At(text.current, start);
          const to = utf16At(text.current, end);
          text.current = text.current.slice(0, from) + value + text.current.slice(to);
          view.configure({ splice: [from, to, value] });
        },
        selectAll: () => view.configure({ selectAll: true }),
        addMark: (mark: number, offset?: number) => {
          const at = offset == null ? undefined : utf16At(text.current, offset);
          view.configure({ addMark: { id: mark, at, label: handlers.current.markLabel?.(mark) ?? "" } });
        },
        removeMark: (mark: number) => view.configure({ removeMark: mark }),
      }) as unknown as NodeHandle,
      [view.id],
    );

    return <Box style={{ ...props.style, height, flexShrink: 0 }} surface={view.surface} />;
  });
}
