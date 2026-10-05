
interface CommandHelp {
  summary: string;
  usage: string;
  body: string;
}

const COMMANDS: Record<string, CommandHelp> = {
  open: {
    summary: "Open the browser in a terminal pane",
    usage: "terminal-browser open [url] [options]",
    body: `
Opens the browser in the current pane. Pass --split to open it in a new
split pane instead.

The url can be a normal url, a localhost port, or a path to an html file.

Options:
  --split <direction>   Open in a new pane: right, left, down, up
  --size <fraction>     How much of the space the split takes (0.2 to 0.95)
  --ssh <user@host>     Perform all network requests through a remote server, then
                        proxy the result back to the local terminal-browser instance
  --allow-clipboard-read
                        Lets websites read from clipboard.
  --transparent         [placeholder copy: Let the terminal show through pages that do not paint
                        a background. Persist it with terminal-browser config set window.transparent on]
  --no-merge            Do not open the terminal-browser instance as a tab in a neighbor terminal-browser


Examples:
  terminal-browser open localhost:3000
  terminal-browser open ./report.html --split right
  terminal-browser open github.com/zenbu-labs --split down --size 0.4
  terminal-browser open --ssh dev@build-box localhost:8080
`,
  },
  ls: {
    summary: "List running browsers and their tabs",
    usage: "terminal-browser ls [options]",
    body: `
Lists the browsers running in this terminal tab, each with its tabs. The tab
ids it prints are what --tab takes in terminal-browser action.

Options:
  --all               Every browser, not just this terminal tab
  --json              Machine readable, including cdp ports and pane ids
`,
  },
  setup: {
    summary: "Configure terminals and agents so terminal-browser works best",
    usage: "terminal-browser setup",
    body: `
Sets up configuration to make terminal-browser work best, this includes:
- installing agent skills

`,
  },
  upgrade: {
    summary: "Upgrade to the latest release",
    usage: "terminal-browser upgrade",
    body: `
Checks this install's release channel and installs the latest version. Does
nothing when already up to date.
`,
  },
  "new-tab": {
    summary: "Open a tab here, and a browser too if there is none",
    usage: "terminal-browser new-tab [url] [options]",
    body: `
Opens a tab in a browser already open. By default, if there is a single
browser open in the current terminal tab, it will open a tab in that browser.
If there are no browsers, a new browser will be opened with the specified tab
as the initial (if ran from a shell without a TTY, it will open in a split to
the right). If there are multiple browsers, new-tab will error and a
--browser <key> is a required argument (<key> can be found by running
terminal-browser ls)

Options:
  --browser <key>     A browser key from terminal-browser ls

Examples:
  terminal-browser new-tab github.com
  terminal-browser new-tab --browser 90107-1 localhost:3000
`,
  },
  apps: {
    summary: "Lists registered terminal-browser apps",
    usage: "terminal-browser apps [--json]",
    body: `
Lists the id, name, and binary path of registered terminal-browser apps. Apps can be registered
using terminal-browser register-app. If an app is registered it can be opened through the terminal-browser
new tab command palette after searching for its name.
`,
  },
  "register-app": {
    summary: "Register a terminal-browser application",
    usage: "terminal-browser register-app --name <name> --bin <path> [--id <id>] [--args \"…\"]",
    body: `
Registers metadata for a terminal-browser application to ~/.local/share/terminal-browser-interop/apps/<id>.json. This enables functionality
when a user is using terminal-browser, and lets other applications discover terminal-browser apps.
`,
  },
  "unregister-app": {
    summary: "Unregister a terminal-browser application",
    usage: "terminal-browser unregister-app <id>",
    body: `
Remove application metadata from ~/.local/share/terminal-browser-interop/apps/<id>.json.
`,
  },
  shutdown: {
    summary: "Stop the daemon",
    usage: "terminal-browser shutdown",
    body: `
Every browser in a terminal pane shares one browser process as an optimization. To
fully quit terminal-browser operations, you can use this shutdown command. This will
close all open browsers.
`,
  },
  config: {
    summary: "Get and set settings and shortcuts",
    usage: "terminal-browser config <list|get|set|unset|path> [key] [value]",
    body: `
Reads and writes the settings.json and shortcuts.json files.

Settings are addressed by their settings.json key. Shortcuts are addressed as
shortcuts.<command> and take a comma separated list of key chords, or none to
unbind. unset restores the default.

Commands:
  list                 List every setting and shortcut with its current value
  get <key>            Print the value of one key
  set <key> <value>    Set a key
  unset <key>          Restore a key to its default
  path                 Print the paths of the config files

Examples:
  terminal-browser config list
  terminal-browser config get search.engine
  terminal-browser config set telemetry.usage off
  terminal-browser config set updates.check off
  terminal-browser config set shortcuts.tab.new "cmd+t,ctrl+t"
  terminal-browser config set shortcuts.record.toggle none
  terminal-browser config unset render.fps
  terminal-browser config path
`,
  },
  action: {
    summary: "Use the open browser through the agent-browser CLI",
    usage: "terminal-browser action [selectors] -- <command>",
    body: `
An agent-browser compatible CLI for the browser you already have open.
Everything after -- is an agent-browser command. With no selectors it targets
the browser in this terminal tab and that browser's active tab.

Selectors:
  --browser <key>     A browser key from terminal-browser ls
  --tab <id>          A tab id from terminal-browser ls
  --target <id>       A CDP target id
  --follow            Bring the tab to the front before running the command

Examples:
  terminal-browser action -- snapshot
  terminal-browser action -- click @e14
  terminal-browser action -- eval "document.title"
  terminal-browser action --browser 90107-1 --tab 2 -- fill @e3 "hello"
  terminal-browser action done
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
Usage: terminal-browser [url] [options]
       terminal-browser <command> [args]

${lines.join("\n")}

terminal-browser <command> --help for one command's options
terminal-browser --version prints the installed version
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
