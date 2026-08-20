
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
  --profile <name>      Use an isolated persistent browser profile
  --preload=<path>      Run a script inside the context of a web page before it loads (uses electron's preload feature under the hood, runs in an isolated world).
                        terminal-browser specific api's are exposed on globalThis.terminalBrowser
                        {
                          theme: () => { background: [r,g,b], foreground: [r,g,b], ansi: ([r,g,b] | null)[] } | null, // null until the terminal reports its colors
                          onTheme: (cb: (theme: Theme) => void) => () => void, // returns unsubscribe
                          quit: () => void // closes this browser window
                        }
                        --terminal-browser-session=<key> is passed as extra arguments to the renderer process, available via process.argv
  --main-script=<path>  Run a node.js script in the same process as the browser (this is an electron main process)
  --open-tabs-in-popup-stack Links that would open a new tab open a popup over the
                        page instead.
  --allow-clipboard-read
                        Lets websites read from clipboard.
  --no-toolbar          No toolbar or tab strip
  --no-shortcuts        No browser shortcuts, keys go to the page
  --no-context-menu     No right-click menu
  --no-overlays         No toasts or HUDs drawn over the page
  --no-frame            No border or padding, the page fills the pane
  --app-mode            Shorthand for --no-toolbar --no-shortcuts
                        --no-context-menu --no-overlays --no-frame
                        --allow-clipboard-read --open-tabs-in-popup-stack

Examples:
  terminal-browser open localhost:3000
  terminal-browser open github.com --profile work
  terminal-browser open ./report.html --split right
  terminal-browser open github.com/zenbu-labs --split down --size 0.4
`,
  },
  profile: {
    summary: "Manage persistent browser profiles",
    usage: "terminal-browser profile <command> [options]",
    body: `
Named profiles keep cookies and site storage isolated from each other. The
built-in default profile is used until another profile is selected as the
default. Opening with --profile creates an empty profile when the name is new.
Import and sync copy persistent cookies through browser APIs; the source profile
is never modified and its browser must be closed.

Commands:
  ls                         List profiles and show the selected default
  default [name]             Show or select the profile used when none is passed
  default-source [browser]   Show or configure the source used by create
  create <name>              Create a profile, using the default source if set
  sources                    List importable browser profiles on this machine
  import <browser>           Import brave, chrome, or chromium cookies
  sync <name>                Re-import from a profile's remembered source
  remove <name>              Permanently delete a named profile

Default options:
  --reset                    Restore the built-in default profile

Default-source options:
  --source-profile <name>    Source profile directory, such as "Profile 1"
  --source-dir <path>        Browser user-data directory when it is not detected
  --browser-path <path>      Browser executable when it is not detected
  --clear                    Remove the configured default source

Create options:
  --empty                    Ignore the default source and create an empty profile

Import options:
  --name <name>              Name of the terminal-browser profile
  --source-profile <name>    Source profile directory, such as "Profile 1"
  --source-dir <path>        Browser user-data directory when it is not detected
  --browser-path <path>      Browser executable when it is not detected
  --replace                  Clear target cookies before importing

Sync options:
  --replace                  Clear target cookies before syncing

List, default, default-source, and sources options:
  --json                     Print machine-readable output

Session-only and partitioned cookies cannot be preserved and are skipped.

Examples:
  terminal-browser profile sources
  terminal-browser profile default work
  terminal-browser profile default-source brave --source-profile Default
  terminal-browser profile create project-a
  terminal-browser profile create scratch --empty
  terminal-browser profile import brave --name work
  terminal-browser profile ls
  terminal-browser profile sync work
  terminal-browser profile remove work
  terminal-browser open github.com --profile work
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
    summary: "Configure installed terminals so terminal-browser works best",
    usage: "terminal-browser setup",
    body: `
Finds the terminals on this machine and fixes any settings that would keep the
browser from drawing in them. Editors built on vscode ship with terminal images
switched off, so this turns "terminal.integrated.enableImages" on in each one.

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
  shutdown: {
    summary: "Stop the daemon",
    usage: "terminal-browser shutdown",
    body: `
Every browser in a terminal pane shares one browser process as an optimization. To
fully quit terminal-browser operations, you can use this shutdown command. This will
close all open browsers.
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
