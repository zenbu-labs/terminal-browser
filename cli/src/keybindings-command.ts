import {
  keybindingConflicts,
  keybindingSetting,
  listKeybindings,
  resetKeybinding,
  setKeybinding,
} from "pixel-store";
import type { KeybindingSetting } from "pixel-store";
import type { Terminal } from "pixel-terminals";
import { terminalKeybindingConflicts } from "./terminal-keybindings";

export type KeybindingsRequest =
  | { action: "ls"; json: boolean }
  | { action: "set"; binding: string[]; id: string }
  | { action: "reset"; all: boolean; id?: string };

export async function keybindingsCommand(
  request: KeybindingsRequest,
  terminal: Terminal | null,
): Promise<number> {
  if (request.action === "ls") {
    const settings = listKeybindings();
    if (request.json) print(settings);
    else await printSettings(settings, terminal);
    return 0;
  }
  if (request.action === "set") {
    if (!keybindingSetting(request.id)) fail(`unknown keybinding action ${request.id}`);
    const setting = setKeybinding(request.id, request.binding.join(" "));
    process.stdout.write(`${setting.id}: ${setting.binding}\n`);
    await printConflicts(terminal);
    return 0;
  }
  if (request.all && request.id) {
    fail("keybindings reset accepts an action or --all, not both");
  }
  if (!request.all && !request.id) fail("keybindings reset requires an action or --all");
  if (request.id && !keybindingSetting(request.id)) {
    fail(`unknown keybinding action ${request.id}`);
  }
  resetKeybinding(request.all ? null : request.id!);
  if (request.all) process.stdout.write("reset all keybindings\n");
  else process.stdout.write(`${request.id}: ${keybindingSetting(request.id!)!.binding}\n`);
  return 0;
}

async function printSettings(
  settings: KeybindingSetting[],
  terminal: Terminal | null,
): Promise<void> {
  printTable(
    ["ACTION", "BINDING", "SOURCE"],
    settings.map((setting) => [
      setting.id,
      setting.binding,
      setting.overridden ? "custom" : "default",
    ]),
  );
  await printConflicts(terminal, settings);
}

async function printConflicts(
  terminal: Terminal | null,
  settings = listKeybindings(),
): Promise<void> {
  for (const conflict of keybindingConflicts(settings)) {
    process.stderr.write(
      `warning: ${conflict.binding} is assigned to ${conflict.actions.join(", ")}\n`,
    );
  }
  for (const conflict of await terminalKeybindingConflicts(
    settings,
    terminal,
  )) {
    const behavior =
      conflict.delivery === "conditional" ? "may handle" : "also binds";
    process.stderr.write(
      `warning: ${conflict.terminal} ${behavior} ${conflict.binding} as ${conflict.terminalAction} (${conflict.action})\n`,
    );
  }
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column].length)),
  );
  const line = (row: string[]) =>
    row
      .map((value, column) => value.padEnd(widths[column]))
      .join("  ")
      .trimEnd();
  process.stdout.write(`${line(headers)}\n${rows.map(line).join("\n")}\n`);
}

function fail(message: string): never {
  throw new Error(message);
}
