import fs from "node:fs";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { debug } from "../debug";
import { useNodeRect } from "../layout";
import { Box } from "../react";
import type {
  EngineKeyEvent,
  MouseMoveEvent,
  NodeHandle,
  PointerEvent,
  PointerShape,
  Surface,
  WheelEvent,
} from "../react";
import { RootContext, useRegistryColors } from "../registry";
import type { ViewEntry } from "../registry";
import type { Guest, GuestFrame } from "./server";


export function GuestView({ guest, active }: { guest: Guest; active: boolean }) {
  const registry = useContext(RootContext);
  if (!registry) throw new Error("GuestView outside a root");
  const colors = useRegistryColors(registry);
  const boxRef = useRef<NodeHandle>(null);
  const rect = useNodeRect(boxRef, registry);
  const surface = useRef<Surface | null>(null);
  const [pointerShape, setPointerShape] = useState<PointerShape>("default");
  const wheel = useRef({ x: 0, y: 0 });
  const greeted = useRef(false);

  const entry = useMemo<ViewEntry>(
    () => ({
      host: null,
      handle: null,
      devtoolsEnabled: false,
      externalDevtools: false,
      externalDevtoolsAction: null,
      externalDevtoolsCursor: null,
      toggleDevtools: () => {},
      handleKey: (event: EngineKeyEvent) => {
        guest.send({ type: "key", ...event });
        return true;
      },
      paste: (text: string) => guest.send({ type: "paste", text }),
      setActive: (focused: boolean) => guest.send({ type: "focus", focused }),
    }),
    [guest],
  );

  const cell = registry.root.info;
  const snapped = rect
    ? {
        width: Math.floor(rect.width / cell.cellWidth) * cell.cellWidth,
        height: Math.floor(rect.height / cell.cellHeight) * cell.cellHeight,
      }
    : null;

  useLayoutEffect(() => {
    const created = registry.root.createSurface();
    surface.current = created;
    registry.register(entry);
    guest.onFrame = (frame: GuestFrame) => {
      let fd: number;
      try {
        fd = fs.openSync(frame.path, "r");
      } catch (error) {
        debug("guest frame unreadable", frame.path, String(error));
        frame.ack();
        return;
      }
      const stride = frame.width * 4;
      created.present({
        shm: { fd, width: frame.width, height: frame.height, stride, size: stride * frame.height },
        released: () => {
          fs.closeSync(fd);
          frame.ack();
        },
      });
    };
    guest.onPointer = (shape) => {
      setPointerShape(shape as PointerShape);
    };
    guest.onClipboard = (text) => registry.root.setClipboard(text);
    return () => {
      guest.onFrame = null;
      guest.onPointer = null;
      guest.onClipboard = null;
      registry.unregister(entry);
      created.close();
      surface.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guest]);

  useEffect(() => {
    if (!snapped || snapped.width <= 0 || snapped.height <= 0) return;
    const size = {
      cols: snapped.width / cell.cellWidth,
      rows: snapped.height / cell.cellHeight,
      width: snapped.width,
      height: snapped.height,
    };
    if (!greeted.current) {
      greeted.current = true;
      guest.send({ type: "init", ...size, colors, focused: active });
      return;
    }
    guest.send({ type: "size", ...size });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapped?.width, snapped?.height]);

  useEffect(() => {
    if (greeted.current) guest.send({ type: "colors", colors });
  }, [colors, guest]);

  useEffect(() => {
    if (active) registry.focus(entry);
    else registry.blur(entry);
  }, [active, entry, registry]);

  const forward = (event: PointerEvent | MouseMoveEvent, kind: "down" | "up" | "move") => {
    const pointer = event as Partial<PointerEvent>;
    guest.send({
      type: "mouse",
      kind,
      button: pointer.button ?? "none",
      mods: pointer.mods ?? { shift: false, alt: false, ctrl: false, super: false },
      x: Math.max(0, Math.round(event.x)),
      y: Math.max(0, Math.round(event.y)),
    });
  };


  const scroll = (event: WheelEvent) => {
    if (event.precise) {
      guest.send({
        type: "wheel",
        x: Math.max(0, Math.round(event.x)),
        y: Math.max(0, Math.round(event.y)),
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        mods: event.mods,
      });
      return;
    }
    const acc = wheel.current;
    acc.x += event.deltaX;
    acc.y += event.deltaY;
    const stepX = cell.cellWidth;
    const stepY = cell.cellHeight;
    const send = (kind: "scrollup" | "scrolldown" | "scrollleft" | "scrollright") =>
      guest.send({
        type: "mouse",
        kind,
        button: "none",
        mods: event.mods,
        x: Math.max(0, Math.round(event.x)),
        y: Math.max(0, Math.round(event.y)),
      });
    while (acc.y >= stepY) {
      acc.y -= stepY;
      send("scrolldown");
    }
    while (acc.y <= -stepY) {
      acc.y += stepY;
      send("scrollup");
    }
    while (acc.x >= stepX) {
      acc.x -= stepX;
      send("scrollright");
    }
    while (acc.x <= -stepX) {
      acc.x += stepX;
      send("scrollleft");
    }
  };

  return (
    <Box ref={boxRef} style={{ flexGrow: 1, flexBasis: 0, overflow: "hidden" }} hidden={!active}>
      {snapped && snapped.width > 0 && snapped.height > 0 && (
        <Box
          surface={surface.current ?? undefined}
          style={{
            position: "absolute",
            inset: { top: 0, left: 0 },
            width: snapped.width,
            height: snapped.height,
            pointerShape,
          }}
          onPointer={(event: PointerEvent) => {
            registry.focus(entry);
            forward(event, event.kind);
          }}
          onMouseMove={(event: MouseMoveEvent) => forward(event, "move")}
          onWheel={scroll}
        />
      )}
    </Box>
  );
}
