import { useMemo, useState } from "react";
import { Box, Input, Text } from "pixel-react";
import type { EngineInfo } from "pixel-react";

import { demoNotes, Note } from "./notes";
import { makeTheme, Theme } from "./theme";

const FONT_MONO = 1;

interface Ctx {
  theme: Theme;
  rem: number;
}

export function App({ info }: { info: EngineInfo }) {
  const theme = useMemo(() => makeTheme(info.colors), [info]);
  const rem = info.basePx;
  const ctx = { theme, rem };

  const [notes, setNotes] = useState<Note[]>(demoNotes);
  const [activeId, setActiveId] = useState(demoNotes[0].id);
  const active = notes.find((n) => n.id === activeId) ?? notes[0];

  const setText = (text: string) =>
    setNotes((all) => all.map((n) => (n.id === active.id ? { ...n, text } : n)));
  const addNote = () =>
    setNotes((all) => {
      const id = Math.max(...all.map((n) => n.id)) + 1;
      setActiveId(id);
      return [...all, { id, title: `untitled ${id}`, text: "" }];
    });

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
      <Sidebar
        ctx={ctx}
        notes={notes}
        activeId={active.id}
        onSelect={setActiveId}
        onAdd={addNote}
      />
      <Editor ctx={ctx} note={active} onChange={setText} />
    </Box>
  );
}

function Sidebar({
  ctx: { theme, rem },
  notes,
  activeId,
  onSelect,
  onAdd,
}: {
  ctx: Ctx;
  notes: Note[];
  activeId: number;
  onSelect: (id: number) => void;
  onAdd: () => void;
}) {
  return (
    <Box
      style={{
        flexDirection: "column",
        width: rem * 14,
        flexShrink: 0,
        margin: rem * 0.4,
        padding: rem * 0.6,
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
        notes
      </Text>
      {notes.map((note) => (
        <SidebarItem
          key={note.id}
          ctx={{ theme, rem }}
          note={note}
          active={note.id === activeId}
          onSelect={onSelect}
        />
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
        onClick={onAdd}
      >
        + new note
      </Text>
    </Box>
  );
}

function SidebarItem({
  ctx: { theme, rem },
  note,
  active,
  onSelect,
}: {
  ctx: Ctx;
  note: Note;
  active: boolean;
  onSelect: (id: number) => void;
}) {
  return (
    <Text
      style={{
        padding: { left: rem * 0.6, right: rem * 0.6, top: rem * 0.35, bottom: rem * 0.35 },
        cornerRadius: rem * 0.4,
        background: active ? theme.itemActive : undefined,
        hoverBackground: active ? undefined : theme.itemHover,
        color: active ? theme.fg : theme.muted,
        hoverColor: active ? undefined : theme.fg,
      }}
      onClick={() => onSelect(note.id)}
    >
      {note.title}
    </Text>
  );
}

function Editor({
  ctx,
  note,
  onChange,
}: {
  ctx: Ctx;
  note: Note;
  onChange: (text: string) => void;
}) {
  const { theme, rem } = ctx;
  const pad = rem * 1.1;
  return (
    <Box style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, overflow: "hidden" }}>
      <Box
        style={{
          justifyContent: "space-between",
          alignItems: "center",
          padding: { left: pad, right: pad, top: rem * 0.7, bottom: rem * 0.7 },
        }}
      >
        <Text style={{ fontSize: rem * 1.35 }}>{note.title}</Text>
        <Chip ctx={ctx} color={theme.muted}>
          markdown
        </Chip>
      </Box>
      <Box
        style={{
          height: Math.max(rem / 16, 1),
          width: "100%",
          background: theme.hairline,
        }}
      />
      <Box style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, overflow: "scroll" }}>
        <Input
          key={note.id}
          style={{ padding: pad, flexShrink: 0 }}
          defaultValue={note.text}
          caretColor={theme.accent}
          selectionColor={theme.selection}
          autoFocus
          onChange={onChange}
        />
      </Box>
      <StatusBar ctx={ctx} note={note} />
    </Box>
  );
}

function StatusBar({ ctx, note }: { ctx: Ctx; note: Note }) {
  const { theme, rem } = ctx;
  const lines = note.text === "" ? 0 : note.text.split("\n").length;
  return (
    <Box
      style={{
        justifyContent: "space-between",
        alignItems: "center",
        padding: { left: rem * 0.75, right: rem * 0.75, top: rem * 0.5, bottom: rem * 0.5 },
      }}
    >
      <Text style={{ color: theme.muted, fontSize: rem * 0.85 }}>
        ctrl-q quit / cmd-z undo / right-drag select
      </Text>
      <Box style={{ gap: rem * 0.5, alignItems: "center" }}>
        <Chip ctx={ctx} color={theme.muted}>{`${lines} lines`}</Chip>
        <Chip ctx={ctx} color={theme.accent}>
          react
        </Chip>
      </Box>
    </Box>
  );
}

function Chip({
  ctx: { theme, rem },
  color,
  children,
}: {
  ctx: Ctx;
  color: Theme[keyof Theme];
  children: string;
}) {
  return (
    <Text
      style={{
        padding: { left: rem * 0.7, right: rem * 0.7, top: rem * 0.2, bottom: rem * 0.2 },
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
