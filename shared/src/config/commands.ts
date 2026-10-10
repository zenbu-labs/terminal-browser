type CommandKeys =
  | { kind: "shared"; keys: string[] }
  | { kind: "platform"; mac: string[]; other: string[] };

interface CommandDef {
  label: string;
  keys: CommandKeys;
}

const shared = (keys: string[]): CommandKeys => ({ kind: "shared", keys });
const platform = (mac: string[], other: string[]): CommandKeys => ({ kind: "platform", mac, other });

export const COMMANDS = {
  palette: { label: "Command palette", keys: platform(["cmd+p"], ["ctrl+k", "alt+k"]) },
  "settings.open": { label: "Settings", keys: shared(["ctrl+,"]) },
  "tab.new": { label: "New tab", keys: platform(["cmd+t", "ctrl+t"], ["ctrl+t"]) },
  "tab.close": { label: "Close tab", keys: platform(["cmd+w", "ctrl+w"], ["ctrl+w"]) },
  "url.edit": { label: "Edit URL", keys: platform(["cmd+l"], ["ctrl+l"]) },
  find: { label: "Find in page", keys: platform(["cmd+shift+f"], ["ctrl+shift+f"]) },
  "page.reload": { label: "Reload page", keys: platform(["cmd+r"], ["ctrl+r"]) },
  "page.back": { label: "Back", keys: platform(["cmd+[", "ctrl+["], ["ctrl+["]) },
  "page.forward": { label: "Forward", keys: platform(["cmd+]", "ctrl+]"], ["ctrl+]"]) },
  "devtools.toggle": {
    label: "Toggle devtools",
    keys: platform(["cmd+shift+i", "f12"], ["ctrl+shift+i", "f12"]),
  },
  "devtools.console": { label: "Devtools console", keys: platform(["cmd+alt+j"], ["ctrl+alt+j"]) },
  "record.toggle": { label: "Record page", keys: platform(["ctrl+r"], ["ctrl+shift+r"]) },
  "grab.toggle": { label: "Send to agent", keys: shared(["ctrl+g"]) },
  "zoom.in": { label: "Zoom in", keys: platform(["cmd+=", "ctrl+="], ["ctrl+="]) },
  "zoom.out": { label: "Zoom out", keys: platform(["cmd+-", "ctrl+-"], ["ctrl+-"]) },
  "zoom.reset": { label: "Reset zoom", keys: platform(["cmd+0", "ctrl+0"], ["ctrl+0"]) },
  "ui.zoom.in": { label: "Zoom UI in", keys: platform(["cmd+shift+=", "ctrl+shift+="], ["ctrl+shift+="]) },
  "ui.zoom.out": { label: "Zoom UI out", keys: platform(["cmd+shift+-", "ctrl+shift+-"], ["ctrl+shift+-"]) },
  "ui.zoom.reset": {
    label: "Reset UI zoom",
    keys: platform(["cmd+shift+0", "ctrl+shift+0"], ["ctrl+shift+0"]),
  },
  quit: { label: "Quit", keys: platform(["ctrl+q", "ctrl+c"], ["ctrl+q"]) },
} satisfies Record<string, CommandDef>;

export type CommandId = keyof typeof COMMANDS;

export const COMMAND_IDS = Object.keys(COMMANDS) as CommandId[];

export function isCommandId(value: string): value is CommandId {
  return Object.prototype.hasOwnProperty.call(COMMANDS, value);
}

export function commandLabel(id: CommandId): string {
  return COMMANDS[id].label;
}

export function defaultKeys(id: CommandId, os: NodeJS.Platform = process.platform): string[] {
  const keys = COMMANDS[id].keys;
  if (keys.kind === "shared") return keys.keys;
  return os === "darwin" ? keys.mac : keys.other;
}
