import { normalizeKeybinding } from "pixel-store";
import type { KeybindingActionId, KeybindingSetting } from "pixel-store";
import type { Terminal } from "pixel-terminals";

export interface TerminalKeybindingConflict {
  action: KeybindingActionId;
  binding: string;
  terminal: string;
  terminalAction: string;
  delivery: "consumed" | "conditional";
}

export async function terminalKeybindingConflicts(
  settings: KeybindingSetting[],
  terminal: Terminal | null,
): Promise<TerminalKeybindingConflict[]> {
  if (!terminal?.keybindings) return [];
  let reported;
  try {
    reported = await terminal.keybindings();
  } catch {
    return [];
  }
  const terminalBindings = new Map(
    reported.flatMap((binding) => {
      try {
        return [[normalizeKeybinding(binding.binding), binding] as const];
      } catch {
        return [];
      }
    }),
  );
  const conflicts: TerminalKeybindingConflict[] = [];
  for (const setting of settings) {
    if (setting.binding === "none") continue;
    for (const binding of setting.binding.split(" ")) {
      const matched = terminalBindings.get(binding);
      if (!matched) continue;
      conflicts.push({
        action: setting.id,
        binding,
        terminal: terminal.name,
        terminalAction: matched.action,
        delivery: matched.delivery,
      });
    }
  }
  return conflicts;
}
