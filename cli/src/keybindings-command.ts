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

export async function keybindingsCommand(
  args: string[],
  terminal: Terminal | null,
): Promise<number> {
  const action = args.shift();
  if (action === "ls") {
    const json = takeBoolFlag(args, "--json");
    unexpected(args);
    const settings = listKeybindings();
    if (json) print(settings);
    else await printSettings(settings, terminal);
    return 0;
  }
  if (action === "set") {
    const id = args.shift();
    if (!id) fail("keybindings set requires an action");
    if (!keybindingSetting(id)) fail(`unknown keybinding action ${id}`);
    if (args.length === 0) fail("keybindings set requires a binding (or none)");
    if (args.some((arg) => arg.startsWith("--"))) unexpected(args);
    const setting = setKeybinding(id, args.join(" "));
    process.stdout.write(`${setting.id}: ${setting.binding}\n`);
    await printConflicts(terminal);
    return 0;
  }
  if (action === "reset") {
    const all = takeBoolFlag(args, "--all");
    const id = args.shift();
    unexpected(args);
    if (all && id)
      fail("keybindings reset accepts an action or --all, not both");
    if (!all && !id) fail("keybindings reset requires an action or --all");
    resetKeybinding(all ? null : id!);
    if (all) process.stdout.write("reset all keybindings\n");
    else process.stdout.write(`${id}: ${keybindingSetting(id!)!.binding}\n`);
    return 0;
  }
  fail("keybindings supports: ls, set, reset");
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

function takeBoolFlag(args: string[], name: string): boolean {
  const at = args.indexOf(name);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
}

function unexpected(args: string[]): void {
  if (args.length > 0)
    fail(`unexpected ${args[0]} (terminal-browser keybindings --help)`);
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
