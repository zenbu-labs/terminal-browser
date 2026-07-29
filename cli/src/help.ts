interface CommandHelp {
  summary: string;
  usage: string;
  body: string;
}

const COMMANDS: Record<string, CommandHelp> = {
  open: {
    summary: "Open the browser in a terminal pane",
    usage: "terminal-browser open [url] [direction] [options]",
    body: `
Opens the browser inside the terminal. With no direction it takes over the
current pane; a direction, or --split, puts it in a new pane beside you. A url,
a localhost port, or a path to a local html file all work.

Options:
  --dir <direction>     Split direction: right, left, down, up (default right)
  --size <fraction>     Pane size (0.2-0.95)
  --split               Split instead of taking over the current pane
  --isolated            Use a dedicated browser process and profile
  --palette-key <key>   Command palette key (default super+p, none disables)
  --find-key <key>      Find-in-page key (default super+f, none disables)
  --action-mods <mods>  Action shortcut mods (default super+shift, none disables)

Examples:
  terminal-browser open localhost:3000
  terminal-browser open ./report.html --split
  terminal-browser open example.com down --size 0.4
`,
  },
  ls: {
    summary: "List running browsers and their tabs",
    usage: "terminal-browser ls [options]",
    body: `
Lists the browsers running in this terminal tab, each with its tabs. The tab
ids it prints are what --tab takes in terminal-browser action.

Options:
  --all                 Every browser, not just this terminal tab
  --json                Machine readable, including cdp ports and pane ids
`,
  },
  setup: {
    summary: "Turn on terminal images in vscode-family editors",
    usage: "terminal-browser setup",
    body: `
Editors built on vscode ship with terminal images switched off, so the browser
cannot draw anything in their terminals until "terminal.integrated.enableImages"
is true. This finds every vscode-family editor on this machine and turns it on,
leaving the rest of each settings file as it was.

The installer runs this for you. Run it again after installing a new editor.
`,
  },
  action: {
    summary: "Drive an open tab (snapshot, click, fill, eval)",
    usage: "terminal-browser action [selectors] -- <command>",
    body: `
Runs an agent-browser command against a tab that is already open. With no
selectors it picks the browser in this terminal tab and that browser's active
tab.

Selectors:
  --browser <key>       A browser key from terminal-browser ls
  --tab <id>            A tab id from terminal-browser ls
  --target <id>         A cdp target id
  --follow              Bring the tab to the front before running the command

Instead of running a command:
  --resolve             Print the browser and tab the selectors resolve to
  --env                 Print the agent-browser session environment

Examples:
  terminal-browser action -- snapshot
  terminal-browser action -- click @e14
  terminal-browser action -- eval "document.title"
  terminal-browser action --browser 90107-1 --tab 2 -- fill @e3 "hello"
`,
  },
};

function block(text: string): string {
  return `${text.trim()}\n`;
}

export function rootHelp(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const lines = Object.entries(COMMANDS).map(
    ([name, help]) => `  ${name.padEnd(width)}  ${help.summary}`,
  );
  return block(`
Usage: terminal-browser <command> [args]

${lines.join("\n")}
  ${"help".padEnd(width)}  Show this help

terminal-browser <command> --help for one command's options
`);
}

export function commandHelp(name: string): string | null {
  const help = COMMANDS[name];
  if (!help) return null;
  return block(`Usage: ${help.usage}\n${help.body}`);
}

export function helpTopics(): string[] {
  return Object.keys(COMMANDS);
}
