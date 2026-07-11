import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Box, Input, Text } from "pixel-react";
import type { EngineInfo, NodeHandle } from "pixel-react";

import { store, THINKING } from "./session";
import type { Ask, Item, Session, ToolCall } from "./session";
import { makeTheme, Theme } from "./theme";

const FONT_MONO = 1;

interface Ctx {
  theme: Theme;
  rem: number;
}

export function App({ info }: { info: EngineInfo }) {
  useSyncExternalStore(store.subscribe, store.snapshot);
  const theme = useMemo(() => makeTheme(info.colors), [info]);
  const rem = info.basePx;
  const ctx = { theme, rem };
  const session = store.active();

  const list = useRef<NodeHandle | null>(null);
  const input = useRef<NodeHandle | null>(null);
  const follow = useRef(true);
  const lastOffset = useRef(0);

  useEffect(() => {
    follow.current = true;
    list.current?.scrollTo(1e9);
  }, [store.at]);
  useEffect(() => {
    if (follow.current) list.current?.scrollTo(1e9, true);
  });
  useEffect(() => {
    if (session.ask) input.current?.blur();
    else input.current?.focus();
  }, [session.ask]);

  return (
    <Box
      style={{
        width: "100%",
        height: "100%",
        background: theme.bg,
        color: theme.fg,
        fontSize: rem,
      }}
    >
      {store.sidebar && <Sidebar ctx={ctx} />}
      <Box style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, overflow: "hidden" }}>
        <Header ctx={ctx} session={session} />
        <Box
          ref={list}
          style={{
            flexDirection: "column",
            flexGrow: 1,
            flexBasis: 0,
            overflow: "scroll",
            padding: rem,
            gap: rem * 0.75,
          }}
          onScroll={(e) => {
            if (e.offset < lastOffset.current - 1) follow.current = false;
            if (e.offset >= e.max - 2) follow.current = true;
            lastOffset.current = e.offset;
          }}
        >
          {session.items.length === 0 && (
            <Text style={{ color: theme.muted }}>ask claude anything</Text>
          )}
          {session.items.map((item, i) => (
            <Message key={i} ctx={ctx} item={item} />
          ))}
        </Box>
        {session.ask && <AskBox ctx={ctx} ask={session.ask} />}
        <Composer ctx={ctx} inputRef={input} />
      </Box>
    </Box>
  );
}

function Sidebar({ ctx }: { ctx: Ctx }) {
  const { theme, rem } = ctx;
  return (
    <Box
      style={{
        flexDirection: "column",
        width: rem * 13,
        flexShrink: 0,
        margin: rem * 0.4,
        padding: rem * 0.4,
        gap: rem * 0.125,
        background: theme.sidebarBg,
        cornerRadius: rem * 0.6,
      }}
    >
      <Text
        style={{
          padding: { left: rem * 0.6, right: rem * 0.6, top: rem * 0.35, bottom: rem * 0.35 },
          color: theme.muted,
          fontSize: rem * 0.85,
        }}
      >
        sessions
      </Text>
      {store.sessions.map((session, i) => (
        <SidebarItem key={i} ctx={ctx} session={session} at={i} />
      ))}
      <Box style={{ flexGrow: 1 }} />
      <Text
        style={{
          padding: { left: rem * 0.6, right: rem * 0.6, top: rem * 0.35, bottom: rem * 0.35 },
          cornerRadius: rem * 0.4,
          border: { width: Math.max(rem / 16, 1), color: theme.hairline },
          color: theme.accent,
          hoverBackground: theme.itemHover,
        }}
        onClick={() => store.add()}
      >
        + new session
      </Text>
    </Box>
  );
}

function SidebarItem({ ctx, session, at }: { ctx: Ctx; session: Session; at: number }) {
  const { theme, rem } = ctx;
  const active = at === store.at;
  return (
    <Box
      style={{
        alignItems: "center",
        gap: rem * 0.5,
        padding: { left: rem * 0.6, right: rem * 0.6, top: rem * 0.35, bottom: rem * 0.35 },
        cornerRadius: rem * 0.4,
        background: active ? theme.itemActive : undefined,
        hoverBackground: active ? undefined : theme.itemHover,
        overflow: "hidden",
      }}
      onClick={() => store.select(at)}
    >
      <Text
        style={{
          color: active ? theme.fg : theme.muted,
          flexGrow: 1,
          flexBasis: 0,
          wrap: false,
        }}
      >
        {session.title()}
      </Text>
      {session.working && <Dot ctx={ctx} color={theme.accent} />}
    </Box>
  );
}

function Header({ ctx, session }: { ctx: Ctx; session: Session }) {
  const { theme, rem } = ctx;
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!session.working) return;
    const timer = setInterval(() => setFrame((f) => f + 1), 250);
    return () => clearInterval(timer);
  }, [session.working]);

  const status = session.working
    ? `${session.activity || "working"}${".".repeat(1 + (frame % 3))}`
    : session.cost > 0
      ? `$${session.cost.toFixed(4)}`
      : "idle";

  return (
    <Box
      style={{
        alignItems: "center",
        gap: rem * 0.5,
        padding: { left: rem, right: rem, top: rem * 0.5, bottom: rem * 0.5 },
      }}
    >
      <Chip ctx={ctx} color={theme.fg}>
        {session.model.replace(/^claude-/, "") || "…"}
      </Chip>
      <Chip ctx={ctx} color={session.mode === "bypassPermissions" ? theme.red : theme.muted}>
        {session.mode}
      </Chip>
      <Chip ctx={ctx} color={theme.muted}>
        {`thinking ${THINKING[session.thinking].label}`}
      </Chip>
      <Box style={{ flexGrow: 1 }} />
      <Text
        style={{
          color: session.working ? theme.accent : theme.muted,
          fontSize: rem * 0.85,
          font: FONT_MONO,
          wrap: false,
          flexShrink: 0,
        }}
      >
        {status}
      </Text>
    </Box>
  );
}

function Message({ ctx, item }: { ctx: Ctx; item: Item }) {
  const { theme, rem } = ctx;
  if (item.kind === "user") {
    return (
      <Box style={{ gap: rem * 0.5 }}>
        <Text style={{ color: theme.accent, flexShrink: 0 }}>{">"}</Text>
        <Text style={{ color: theme.muted }}>{item.text}</Text>
      </Box>
    );
  }
  if (item.kind === "tool") {
    return <ToolRow ctx={ctx} call={item.call} />;
  }
  return <Text>{item.text}</Text>;
}

function ToolRow({ ctx, call }: { ctx: Ctx; call: ToolCall }) {
  const { theme, rem } = ctx;
  const color =
    call.status === "running"
      ? theme.accent
      : call.status === "ok"
        ? theme.green
        : theme.red;
  return (
    <Box style={{ flexDirection: "column", gap: rem * 0.25 }}>
      <Box style={{ gap: rem * 0.5, alignItems: "center", overflow: "hidden" }}>
        <Dot ctx={ctx} color={color} />
        <Text style={{ font: FONT_MONO, fontSize: rem * 0.9, flexShrink: 0, wrap: false }}>
          {call.name}
        </Text>
        <Text style={{ color: theme.muted, font: FONT_MONO, fontSize: rem * 0.9, wrap: false }}>
          {call.detail}
        </Text>
      </Box>
      {call.kids.length > 0 && (
        <Box style={{ flexDirection: "column", gap: rem * 0.25, margin: { left: rem } }}>
          {call.kids.map((kid) => (
            <ToolRow key={kid.id} ctx={ctx} call={kid} />
          ))}
        </Box>
      )}
    </Box>
  );
}

function AskBox({ ctx: { theme, rem }, ask }: { ctx: Ctx; ask: Ask }) {
  return (
    <Box
      style={{
        flexDirection: "column",
        gap: rem * 0.25,
        margin: { left: rem, right: rem, bottom: rem * 0.5 },
        padding: rem * 0.6,
        border: { width: Math.max(rem / 16, 1), color: theme.accent },
        cornerRadius: rem * 0.4,
      }}
    >
      <Box style={{ gap: rem * 0.5, overflow: "hidden" }}>
        <Text style={{ color: theme.accent, font: FONT_MONO, flexShrink: 0 }}>{ask.tool}</Text>
        <Text style={{ color: theme.muted, font: FONT_MONO, wrap: false }}>{ask.detail}</Text>
      </Box>
      <Text style={{ color: theme.muted, fontSize: rem * 0.85 }}>enter allow · esc deny</Text>
    </Box>
  );
}

function Composer({ ctx: { theme, rem }, inputRef }: { ctx: Ctx; inputRef: React.Ref<NodeHandle> }) {
  return (
    <Box style={{ flexDirection: "column", flexShrink: 0 }}>
      <Box style={{ height: Math.max(rem / 16, 1), width: "100%", background: theme.hairline }} />
      <Box style={{ alignItems: "start", gap: rem * 0.5, padding: rem * 0.75 }}>
        <Text style={{ color: theme.accent, flexShrink: 0 }}>{">"}</Text>
        <Input
          ref={inputRef}
          style={{ flexGrow: 1, flexBasis: 0 }}
          caretColor={theme.accent}
          selectionColor={theme.selection}
          autoFocus
          onSubmit={(text) => {
            const trimmed = text.trim();
            if (trimmed) store.active().send(trimmed);
          }}
        />
      </Box>
      <Text
        style={{
          padding: { left: rem * 0.75, right: rem * 0.75, bottom: rem * 0.5 },
          color: theme.muted,
          fontSize: rem * 0.8,
        }}
      >
        enter send · shift+enter newline · cmd+b sessions · ^o model · ^p permissions · ^t
        thinking · esc interrupt · ^q quit
      </Text>
    </Box>
  );
}

function Dot({ ctx: { rem }, color }: { ctx: Ctx; color: Theme[keyof Theme] }) {
  return (
    <Box
      style={{
        width: rem * 0.45,
        height: rem * 0.45,
        cornerRadius: 999,
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

function Chip({ ctx: { theme, rem }, color, children }: { ctx: Ctx; color: Theme[keyof Theme]; children: string }) {
  return (
    <Text
      style={{
        padding: { left: rem * 0.6, right: rem * 0.6, top: rem * 0.15, bottom: rem * 0.15 },
        cornerRadius: 999,
        background: theme.chipBg,
        color,
        fontSize: rem * 0.85,
        font: FONT_MONO,
        flexShrink: 0,
        wrap: false,
      }}
    >
      {children}
    </Text>
  );
}
