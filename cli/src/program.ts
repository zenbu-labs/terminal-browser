import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Command, CommanderError, InvalidArgumentError, Option } from "commander";

import type { ActionOptions } from "./action";
import type { KeybindingsRequest } from "./keybindings-command";
import type { ProfileRequest } from "./profile-command";

const DIRECTIONS = ["right", "left", "down", "up"] as const;

export type Direction = (typeof DIRECTIONS)[number];

export interface OpenRequest {
  browserArgs: string[];
  profile?: string;
  size?: number;
  split?: Direction;
  target?: string;
}

export interface NewTabRequest {
  browserKey?: string;
  target?: string;
}

export interface CliActions {
  action(options: ActionOptions): Promise<number> | number;
  keybindings(request: KeybindingsRequest): Promise<number> | number;
  ls(all: boolean, json: boolean): Promise<number | void> | number | void;
  newTab(request: NewTabRequest): Promise<number> | number;
  open(request: OpenRequest): Promise<number | void> | number | void;
  profile(request: ProfileRequest): Promise<number> | number;
  setup(): Promise<number> | number;
  shutdown(): Promise<number> | number;
  upgrade(): Promise<number> | number;
}

export interface CliProgramOptions {
  cwd?: string;
  version: string;
  writeErr?: (text: string) => void;
  writeOut?: (text: string) => void;
}

interface ProgramBuild {
  exitCode(): number;
  program: Command;
}

interface OpenOptionValues {
  allowClipboardRead?: boolean;
  appMode?: boolean;
  consoleKey?: string;
  contextMenu?: boolean;
  devtoolsKey?: string;
  findKey?: string;
  frame?: boolean;
  mainScript?: string;
  openTabsInPopupStack?: boolean;
  overlays?: boolean;
  paletteKey?: string;
  parentTty?: string;
  partition?: string;
  preload?: string;
  profile?: string;
  shortcuts?: boolean;
  size?: number;
  split?: Direction;
  splitDir?: Direction;
  toolbar?: boolean;
}

const VALUE_OPTIONS = new Set([
  "--browser",
  "--browser-path",
  "--console-key",
  "--devtools-key",
  "--find-key",
  "--main-script",
  "--name",
  "--palette-key",
  "--parent-tty",
  "--partition",
  "--preload",
  "--profile",
  "--search-engine",
  "--size",
  "--source-dir",
  "--source-profile",
  "--split",
  "--split-dir",
  "--tab",
  "--target",
]);

const ROOT_COMMANDS = [
  "action",
  "help",
  "keybindings",
  "ls",
  "new-tab",
  "open",
  "profile",
  "setup",
  "shutdown",
  "upgrade",
];

export async function runCli(
  argv: string[],
  actions: CliActions,
  options: CliProgramOptions,
): Promise<number> {
  const normalized = normalizeRootArguments(argv, options.cwd ?? process.cwd());
  const hint = searchHint(argv);
  const built = createCliProgram(actions, options, hint);
  try {
    validateOptions(normalized, built.program);
    validateActionDelimiter(normalized, built.program);
    await built.program.parseAsync(normalized, { from: "user" });
    return built.exitCode();
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
}

export function createCliProgram(
  actions: CliActions,
  options: CliProgramOptions,
  errorHint: string | null = null,
): ProgramBuild {
  let exitCode = 0;
  const invoke = async (action: () => Promise<number | void> | number | void) => {
    const result = await action();
    if (typeof result === "number") exitCode = result;
  };
  const program = new Command()
    .name("terminal-browser")
    .description("A real browser that runs inside your terminal")
    .usage("[url or quoted search] [options]\n       terminal-browser <command> [args]")
    .version(
      `terminal-browser ${options.version}`,
      "-v, --version",
      "print the installed version",
    )
    .helpCommand(false)
    .showSuggestionAfterError()
    .showHelpAfterError("(run with --help for usage)")
    .enablePositionalOptions()
    .exitOverride()
    .configureOutput({
      writeOut: options.writeOut ?? ((text) => process.stdout.write(text)),
      writeErr: options.writeErr ?? ((text) => process.stderr.write(text)),
      outputError: (text, write) => {
        write(text.replace(/^error: /, "terminal-browser: "));
        if (errorHint && /unknown command|too many arguments/.test(text)) {
          write(`terminal-browser: ${errorHint}\n`);
        }
      },
    });

  const open = program
    .command("open [target]")
    .description("open the browser in a terminal pane")
    .addHelpText(
      "after",
      `
Opens the browser in the current pane. Pass --split to open it in a new split
pane instead. The target can be a URL, localhost port, path to an HTML file, or
search. Quote searches containing multiple words.

The preload script runs in an isolated world. It receives
globalThis.terminalBrowser with theme(), onTheme(callback), and quit() APIs.
The renderer also receives --terminal-browser-session=<key> in process.argv.

App mode enables --no-toolbar, --no-shortcuts, --no-context-menu,
--no-overlays, --no-frame, --allow-clipboard-read, and
--open-tabs-in-popup-stack.

Examples:
  terminal-browser open localhost:3000
  terminal-browser open "best terminal browser"
  terminal-browser open github.com --profile work
  terminal-browser open ./report.html --split right
  terminal-browser open github.com/zenbu-labs --split down --size 0.4
`,
    );
  addOpenOptions(open);
  open.action((target: string | undefined, values: OpenOptionValues) =>
    invoke(() =>
      actions.open({
        browserArgs: browserArguments(values),
        profile: values.profile,
        size: values.size,
        split: values.split,
        target,
      }),
    ),
  );

  const profile = program
    .command("profile")
    .description("manage persistent browser profiles")
    .addHelpText(
      "after",
      `
Named profiles keep cookies and site storage isolated. The built-in default
profile is used until another profile is selected as the default. Opening with
--profile creates an empty profile when the name is new.

Import and sync copy persistent cookies without modifying the source browser
profile. They also detect its search engine, while preserving an explicit
terminal-browser override across syncs. Session-only and partitioned cookies
cannot be preserved and are skipped. The source browser must be closed.

Run terminal-browser profile <command> --help for command-specific options.

Examples:
  terminal-browser profile sources
  terminal-browser profile default work
  terminal-browser profile default-source brave --source-profile Default
  terminal-browser profile create project-a
  terminal-browser profile create scratch --empty
  terminal-browser profile import brave --name work
  terminal-browser profile settings work --search-engine duckduckgo
  terminal-browser profile search-engines
  terminal-browser profile ls
  terminal-browser profile sync work
  terminal-browser profile remove work
`,
    );
  profile
    .command("ls")
    .description("list profiles and show the selected default")
    .option("--json", "print machine-readable output")
    .action((values: { json?: boolean }) =>
      invoke(() => actions.profile({ action: "ls", json: values.json === true })),
    );
  profile
    .command("default [name]")
    .description("show or select the profile used when none is passed")
    .option("--reset", "restore the built-in default profile")
    .option("--json", "print machine-readable output when showing")
    .action((name: string | undefined, values: { json?: boolean; reset?: boolean }) =>
      invoke(() =>
        actions.profile({
          action: "default",
          json: values.json === true,
          name,
          reset: values.reset === true,
        }),
      ),
    );
  const defaultSource = profile
    .command("default-source [browser]")
    .description("show or configure the source used by create")
    .option("--clear", "remove the configured default source")
    .option("--json", "print machine-readable output when showing");
  addSourceOptions(defaultSource);
  defaultSource.action(
    (
      browser: string | undefined,
      values: {
        browserPath?: string;
        clear?: boolean;
        json?: boolean;
        sourceDir?: string;
        sourceProfile?: string;
      },
    ) =>
      invoke(() =>
        actions.profile({
          action: "default-source",
          browser,
          browserPath: values.browserPath,
          clear: values.clear === true,
          json: values.json === true,
          sourceDir: values.sourceDir,
          sourceProfile: values.sourceProfile,
        }),
      ),
  );
  profile
    .command("create <name>")
    .description("create a profile, using the default source if set")
    .option("--empty", "ignore the default source and create an empty profile")
    .action((name: string, values: { empty?: boolean }) =>
      invoke(() =>
        actions.profile({ action: "create", empty: values.empty === true, name }),
      ),
    );
  profile
    .command("settings <name>")
    .description("show or change terminal-browser profile settings")
    .addOption(valueOption("--search-engine <engine>", "override the imported provider, or inherit"))
    .option("--json", "print machine-readable output when showing")
    .action((name: string, values: { json?: boolean; searchEngine?: string }) =>
      invoke(() =>
        actions.profile({
          action: "settings",
          json: values.json === true,
          name,
          searchEngine: values.searchEngine,
        }),
      ),
    );
  profile
    .command("search-engines")
    .description("list available search engine overrides")
    .option("--json", "print machine-readable output")
    .action((values: { json?: boolean }) =>
      invoke(() =>
        actions.profile({ action: "search-engines", json: values.json === true }),
      ),
    );
  profile
    .command("sources")
    .description("list importable browser profiles on this machine")
    .option("--json", "print machine-readable output")
    .action((values: { json?: boolean }) =>
      invoke(() => actions.profile({ action: "sources", json: values.json === true })),
    );
  const importProfile = profile
    .command("import <browser>")
    .description("import brave, chrome, or chromium cookies")
    .addOption(
      valueOption("--name <name>", "name of the terminal-browser profile").makeOptionMandatory(),
    )
    .option("--replace", "clear target cookies before importing");
  addSourceOptions(importProfile);
  importProfile.action(
    (
      browser: string,
      values: {
        browserPath?: string;
        name: string;
        replace?: boolean;
        sourceDir?: string;
        sourceProfile?: string;
      },
    ) =>
      invoke(() =>
        actions.profile({
          action: "import",
          browser,
          browserPath: values.browserPath,
          name: values.name,
          replace: values.replace === true,
          sourceDir: values.sourceDir,
          sourceProfile: values.sourceProfile,
        }),
      ),
  );
  profile
    .command("sync <name>")
    .description("re-import from a profile's remembered source")
    .option("--replace", "clear target cookies before syncing")
    .action((name: string, values: { replace?: boolean }) =>
      invoke(() =>
        actions.profile({ action: "sync", name, replace: values.replace === true }),
      ),
    );
  profile
    .command("remove <name>")
    .description("permanently delete a named profile")
    .action((name: string) => invoke(() => actions.profile({ action: "remove", name })));

  const keybindings = program
    .command("keybindings")
    .description("configure global browser shortcuts")
    .addHelpText(
      "after",
      `
Saved keybindings apply to every browser profile. Multiple bindings for one
action are separated by spaces. Use "none" to disable an action's shortcut.

Examples:
  terminal-browser keybindings ls
  terminal-browser keybindings set close-tab ctrl+w
  terminal-browser keybindings set palette "ctrl+k alt+k"
  terminal-browser keybindings reset --all
`,
    );
  keybindings
    .command("ls")
    .description("list actions, bindings, and their source")
    .option("--json", "print machine-readable output")
    .action((values: { json?: boolean }) =>
      invoke(() =>
        actions.keybindings({ action: "ls", json: values.json === true }),
      ),
    );
  keybindings
    .command("set <action> <binding...>")
    .description("save one or more bindings for an action")
    .action((action: string, binding: string[]) =>
      invoke(() => actions.keybindings({ action: "set", binding, id: action })),
    );
  keybindings
    .command("reset [action]")
    .description("restore one action or every default binding")
    .option("--all", "restore every default binding")
    .action((action: string | undefined, values: { all?: boolean }) =>
      invoke(() =>
        actions.keybindings({ action: "reset", all: values.all === true, id: action }),
      ),
    );

  program
    .command("ls")
    .description("list running browsers and their tabs")
    .option("--all", "include browsers outside this terminal tab")
    .option("--json", "print machine-readable output")
    .addHelpText(
      "after",
      "\nTab ids in this output can be passed to terminal-browser action --tab.\n",
    )
    .action((values: { all?: boolean; json?: boolean }) =>
      invoke(() => actions.ls(values.all === true, values.json === true)),
    );
  program
    .command("setup")
    .description("configure installed terminals for terminal-browser")
    .addHelpText(
      "after",
      `
Finds supported terminals and fixes settings that would keep the browser from
drawing. For editors based on VS Code, this enables terminal images.
`,
    )
    .action(() => invoke(() => actions.setup()));
  program
    .command("upgrade")
    .description("upgrade to the latest release")
    .addHelpText(
      "after",
      "\nChecks the installed release channel and does nothing when already current.\n",
    )
    .action(() => invoke(() => actions.upgrade()));
  program
    .command("shutdown")
    .description("stop the daemon and close all browsers")
    .addHelpText(
      "after",
      `
All terminal panes share one browser process. This fully stops that process and
closes every open terminal-browser session.
`,
    )
    .action(() => invoke(() => actions.shutdown()));

  program
    .command("new-tab [target]")
    .description("open a tab here, and a browser too if there is none")
    .addOption(valueOption("--browser <key>", "browser key from terminal-browser ls"))
    .addHelpText(
      "after",
      `
Uses the browser in the current terminal tab when exactly one is available. If
there is no browser, starts one with this target as its initial tab. Quote
searches containing multiple words.

Examples:
  terminal-browser new-tab github.com
  terminal-browser new-tab "terminal browser profiles"
  terminal-browser new-tab --browser 90107-1 localhost:3000
`,
    )
    .action((target: string | undefined, values: { browser?: string }) =>
      invoke(() => actions.newTab({ browserKey: values.browser, target })),
    );

  program
    .command("action [agentArgs...]")
    .description("use the open browser through the agent-browser CLI")
    .addOption(valueOption("--browser <key>", "browser key from terminal-browser ls"))
    .addOption(
      valueOption("--tab <id>", "tab id from terminal-browser ls").argParser(parseTabId),
    )
    .addOption(valueOption("--target <id>", "CDP target id"))
    .option("--follow", "bring the tab to the front before running the command")
    .passThroughOptions()
    .addHelpText(
      "after",
      `
Everything after -- is passed to agent-browser without further CLI parsing.
Without selectors, this targets the browser in the current terminal tab and its
active tab.

Examples:
  terminal-browser action -- snapshot
  terminal-browser action -- click @e14
  terminal-browser action -- eval "document.title"
  terminal-browser action --browser 90107-1 --tab 2 -- fill @e3 "hello"
`,
    )
    .action(
      (
        agentArgs: string[],
        values: {
          browser?: string;
          follow?: boolean;
          tab?: number;
          target?: string;
        },
      ) =>
        invoke(() =>
          actions.action({
            browserKey: values.browser,
            follow: values.follow === true,
            passthrough: agentArgs,
            tabId: values.tab,
            targetId: values.target,
          }),
        ),
    );

  program
    .command("help [command]")
    .description("display help for a command")
    .action((name: string | undefined) => {
      if (!name) {
        program.outputHelp();
        return;
      }
      const command = program.commands.find((candidate) => candidate.name() === name);
      if (!command) {
        const topics = program.commands
          .map((candidate) => candidate.name())
          .filter((candidate) => candidate !== "help")
          .join(", ");
        program.error(`error: no help for ${name} (try ${topics})`);
        return;
      }
      command.outputHelp();
    });

  return { exitCode: () => exitCode, program };
}

export function helpTopics(): string[] {
  return createCliProgram(noopActions(), { version: "dev" }).program.commands
    .map((command) => command.name())
    .filter((name) => name !== "help");
}

function addOpenOptions(command: Command): void {
  command
    .addOption(
      valueOption("--split <direction>", "open in a new pane: right, left, down, up").choices(
        DIRECTIONS,
      ),
    )
    .addOption(
      valueOption("--size <fraction>", "fraction of space used by the split").argParser(
        parseSize,
      ),
    )
    .addOption(valueOption("--profile <name>", "isolated persistent browser profile"))
    .addOption(valueOption("--palette-key <keys>", "override the command palette binding"))
    .addOption(valueOption("--find-key <keys>", "override the find binding"))
    .addOption(valueOption("--devtools-key <keys>", "override the developer tools binding"))
    .addOption(valueOption("--console-key <keys>", "override the developer console binding"))
    .addOption(valueOption("--preload <path>", "run a preload script in each web page"))
    .addOption(valueOption("--main-script <path>", "run a script in the Electron main process"))
    .option("--open-tabs-in-popup-stack", "open new tabs as popups over the page")
    .option("--allow-clipboard-read", "let websites read from the clipboard")
    .option("--no-toolbar", "hide the toolbar and tab strip")
    .option("--no-shortcuts", "send browser shortcuts to the page")
    .option("--no-context-menu", "disable the right-click menu")
    .option("--no-overlays", "disable terminal-browser toasts and HUDs")
    .option("--no-frame", "let the page fill the pane")
    .option("--app-mode", "enable the terminal-browser app-mode defaults")
    .addOption(valueOption("--partition <name>", "browser partition").hideHelp())
    .addOption(
      valueOption("--split-dir <direction>", "split direction")
        .choices(DIRECTIONS)
        .hideHelp(),
    )
    .addOption(valueOption("--parent-tty <path>", "parent terminal").hideHelp());
}

function addSourceOptions(command: Command): void {
  command
    .addOption(valueOption("--source-profile <name>", "source profile directory"))
    .addOption(valueOption("--source-dir <path>", "browser user-data directory"))
    .addOption(valueOption("--browser-path <path>", "browser executable"));
}

function valueOption(flags: string, description: string): Option {
  return new Option(flags, description).argParser(nonEmptyValue);
}

function nonEmptyValue(value: string): string {
  if (!value || value.startsWith("-")) throw new InvalidArgumentError("requires a value");
  return value;
}

function parseSize(value: string): number {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0.2 || size > 0.95) {
    throw new InvalidArgumentError("must be a fraction between 0.2 and 0.95");
  }
  return size;
}

function parseTabId(value: string): number {
  const id = Number(value.replace(/^t/, ""));
  if (!Number.isInteger(id)) {
    throw new InvalidArgumentError("must be a tab id from terminal-browser ls");
  }
  return id;
}

function browserArguments(values: OpenOptionValues): string[] {
  const args: string[] = [];
  const booleans: [boolean, string][] = [
    [values.appMode === true, "--app-mode"],
    [values.toolbar === false, "--no-toolbar"],
    [values.shortcuts === false, "--no-shortcuts"],
    [values.contextMenu === false, "--no-context-menu"],
    [values.overlays === false, "--no-overlays"],
    [values.frame === false, "--no-frame"],
    [values.openTabsInPopupStack === true, "--open-tabs-in-popup-stack"],
    [values.allowClipboardRead === true, "--allow-clipboard-read"],
  ];
  for (const [enabled, flag] of booleans) if (enabled) args.push(flag);
  const valueFlags: [string, string | undefined][] = [
    ["--partition", values.partition],
    ["--preload", values.preload],
    ["--main-script", values.mainScript],
    ["--palette-key", values.paletteKey],
    ["--find-key", values.findKey],
    ["--devtools-key", values.devtoolsKey],
    ["--console-key", values.consoleKey],
    ["--split-dir", values.splitDir],
    ["--parent-tty", values.parentTty],
  ];
  for (const [flag, value] of valueFlags) if (value !== undefined) args.push(`${flag}=${value}`);
  return args;
}

function normalizeRootArguments(argv: string[], cwd: string): string[] {
  if (argv.length === 0) return ["open"];
  const first = argv[0];
  if (ROOT_COMMANDS.includes(first) || ["-h", "--help", "-v", "--version"].includes(first)) {
    return argv;
  }
  if (first.startsWith("-") || looksLikeImplicitTarget(first, cwd)) return ["open", ...argv];
  return argv.filter((token, index) => index === 0 || (token !== "-h" && token !== "--help"));
}

function looksLikeImplicitTarget(value: string, cwd: string): boolean {
  if (/\s/.test(value)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true;
  if (/^(?:data|mailto|tel|about|blob|chrome|view-source):/i.test(value)) return true;
  if (/^(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/.*)?$/i.test(value)) return true;
  if (/^[\w-]+:\d+(?:\/.*)?$/.test(value)) return true;
  if (!value.includes(" ") && value.includes(".")) return true;
  const expanded = value === "~" || value.startsWith("~/")
    ? path.join(os.homedir(), value.slice(1))
    : value;
  const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
  return fs.existsSync(resolved);
}

function validateOptions(argv: string[], program: Command): void {
  const end = argv[0] === "action" ? argv.indexOf("--") : -1;
  const own = end >= 0 ? argv.slice(0, end) : argv;
  const seen = new Set<string>();
  for (let index = 0; index < own.length; index += 1) {
    const token = own[index];
    if (!token.startsWith("--")) continue;
    const [name, inline] = token.split("=", 2);
    if (seen.has(name)) program.error(`error: option '${name}' may only be specified once`);
    seen.add(name);
    if (!VALUE_OPTIONS.has(name)) continue;
    if (token.includes("=")) {
      if (!inline) program.error(`error: ${name} requires a value`);
      continue;
    }
    const value = own[index + 1];
    if (value === undefined || value.startsWith("-")) {
      program.error(`error: ${name} requires a value`);
    }
    index += 1;
  }
}

function validateActionDelimiter(argv: string[], program: Command): void {
  if (argv[0] !== "action") return;
  if (argv.includes("-h") || argv.includes("--help")) return;
  if (!argv.includes("--")) {
    program.error("error: action requires -- before the agent-browser command");
  }
}

function searchHint(argv: string[]): string | null {
  if (argv.length === 0) return null;
  const explicit = argv[0] === "open" || argv[0] === "new-tab";
  const known = ROOT_COMMANDS.includes(argv[0]);
  if (known && !explicit) return null;
  const tokens = explicit ? argv.slice(1) : argv;
  const words: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith("--")) {
      const name = token.split("=", 1)[0];
      if (VALUE_OPTIONS.has(name) && !token.includes("=")) index += 1;
      continue;
    }
    words.push(token);
  }
  if (words.length === 1 && !words[0].includes(" ")) {
    return `for a single-word search, use: terminal-browser open ${words[0]}`;
  }
  if (words.length <= 1) return null;
  const phrase = words.join(" ").replaceAll('"', '\\"');
  const command = explicit ? `${argv[0]} ` : "";
  return `for a multi-word search, quote the phrase: terminal-browser ${command}"${phrase}"`;
}

function noopActions(): CliActions {
  return new Proxy({}, { get: () => () => 0 }) as CliActions;
}
