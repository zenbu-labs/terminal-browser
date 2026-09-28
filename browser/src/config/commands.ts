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
  palette: { label: "command palette", keys: platform(["cmd+p"], ["ctrl+k", "alt+k"]) },
  "settings.open": { label: "settings", keys: shared(["ctrl+,"]) },
  "tab.new": { label: "new tab", keys: platform(["cmd+t", "ctrl+t"], ["ctrl+t"]) },
  "tab.close": { label: "close tab", keys: platform(["cmd+w"], ["ctrl+w"]) },
  "url.edit": { label: "edit url", keys: platform(["cmd+l"], ["ctrl+l"]) },
  find: { label: "find in page", keys: platform(["cmd+shift+f"], ["ctrl+shift+f"]) },
  "page.reload": { label: "reload page", keys: platform(["cmd+r"], ["ctrl+r"]) },
  "page.back": { label: "back", keys: platform(["cmd+[", "ctrl+["], ["ctrl+["]) },
  "page.forward": { label: "forward", keys: platform(["cmd+]", "ctrl+]"], ["ctrl+]"]) },
  "adblock.toggle": { label: "turn off ad blocking", keys: shared([]) },
  "devtools.toggle": {
    label: "toggle devtools",
    keys: platform(["cmd+shift+i", "f12"], ["ctrl+shift+i", "f12"]),
  },
  "devtools.console": { label: "devtools console", keys: platform(["cmd+alt+j"], ["ctrl+alt+j"]) },
  "record.toggle": { label: "record page", keys: platform(["ctrl+r"], ["ctrl+shift+r"]) },
  "grab.toggle": { label: "send to agent", keys: shared(["ctrl+g"]) },
  "zoom.in": { label: "zoom in", keys: platform(["cmd+=", "ctrl+="], ["ctrl+="]) },
  "zoom.out": { label: "zoom out", keys: platform(["cmd+-", "ctrl+-"], ["ctrl+-"]) },
  "zoom.reset": { label: "reset zoom", keys: platform(["cmd+0", "ctrl+0"], ["ctrl+0"]) },
  "ui.zoom.in": { label: "zoom ui in", keys: platform(["cmd+shift+=", "ctrl+shift+="], ["ctrl+shift+="]) },
  "ui.zoom.out": { label: "zoom ui out", keys: platform(["cmd+shift+-", "ctrl+shift+-"], ["ctrl+shift+-"]) },
  "ui.zoom.reset": {
    label: "reset ui zoom",
    keys: platform(["cmd+shift+0", "ctrl+shift+0"], ["ctrl+shift+0"]),
  },
  quit: { label: "quit", keys: platform(["ctrl+q", "ctrl+c"], ["ctrl+q"]) },
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
