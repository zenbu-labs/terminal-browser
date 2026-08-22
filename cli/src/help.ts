
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
  --profile <name>      Which of our browser profiles to open on, by slug or by
                        display name (terminal-browser profile lists them). The
                        cookies, local storage and history of one profile are
                        invisible to every other, so the same site can be signed
                        in twice at once. A name that fits no profile, or more
                        than one, refuses instead of opening on a profile you
                        did not ask for. Default: the profile last used here
  --ssh <user@host>     Perform all network requests through a remote server, then
                        proxy the result back to the local terminal-browser instance
  --ssh-bundle <dir>    Install and execute a bundle on a remote server. This is useful when paired with
                        --app-mode and --ssh, allowing you to run an application server on a
                        remote machine, then view the output over ssh
  --ssh-bundle-dir <dir>
                        The path --ssh-bundle should be installed to through the ssh server. Defaults to
                        \${XDG_DATA_HOME:-~/.local/share}/terminal-browser/bundles
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
  terminal-browser open ./report.html --split right
  terminal-browser open github.com/zenbu-labs --split down --size 0.4
  terminal-browser open github.com --profile work
  terminal-browser open --ssh dev@build-box localhost:8080
`,
  },
  ls: {
    summary: "List running browsers and their tabs",
    usage: "terminal-browser ls [options]",
    body: `
Lists the browsers running in this terminal tab, each with the browser profile
it is on and its tabs. The tab ids it prints are what --tab takes in
terminal-browser action, and the profile is what --profile takes in
terminal-browser open.

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
  --profile <name>    Which of our browser profiles the tab lands on, by slug or
                      display name. A browser pane holds one profile at a time,
                      so this moves that browser onto the profile first, which
                      reloads the pages it already has open. When there is no
                      browser yet, the new one starts on that profile

Examples:
  terminal-browser new-tab github.com
  terminal-browser new-tab --browser 90107-1 localhost:3000
  terminal-browser new-tab github.com --profile work
`,
  },
  "import-cookies": {
    summary: "Copy your browser logins into a running browser",
    usage: "terminal-browser import-cookies [options]",
    body: `
Reads the cookies out of a Chromium-family profile on this machine and puts them
into a browser you already have open, so pages come up already signed in. macOS
only: on Linux the key these are encrypted with sits in gnome-keyring or kwallet
and nothing here reads those yet, so the import refuses there rather than copying
values it cannot decrypt. The source profile is only ever read, never written,
and the browser it belongs to can stay open while this runs.

Google Chrome is the one browser this has been run against on a real profile.
Chromium, Brave, Microsoft Edge, Arc, Opera, Opera GX, Vivaldi, Dia, Perplexity
Comet, SigmaOS, Sidekick, Helium and Atlas are read the same way, but where each
of them keeps its profiles and its cookie key is reconstructed from Chromium's
naming pattern rather than checked, so importing from one of those says so.
Firefox and Safari are not supported.

In a terminal it lists what it found and asks before copying anything, because
afterwards anything that can reach this browser can use those logins. Answer
anything but y and nothing is copied. Having no terminal to ask in is not
consent: without one it refuses unless -y is there, so a script or an agent has
to say so outright. The question goes to stderr, so redirecting stderr from a
terminal stops the command rather than asking something you would never see.

The running browser holds the same line for every client, not just this one: it
refuses an import that does not say the operator was asked.

The cookie values are encrypted with a key held in your login keychain, read
in-process, so macOS attributes the request to terminal-browser itself and
"Always Allow" grants it to this browser rather than to everything you run. A run
where nothing decrypts is an error, not a count of zero: a key that does not fit
the store is not the same thing as a profile with no cookies in it.

Cookies only: no history, no bookmarks, no saved passwords. Sites that keep
their login in local storage rather than a cookie will still ask you to sign in.

Options:
  -y, --yes           Copy without asking, and the only way to copy with no
                      terminal to ask in
  --json              Print the result as JSON instead of a sentence
  --from <browser>    Source browser, by slug, display name or alias: chrome,
                      brave, edge, arc, opera, vivaldi, chromium and the rest
                      (default: Chrome, or whichever one is installed)
  --profile <name>    Source profile in that browser, by directory ("Profile 1")
                      or by the name you gave it there ("Work")
  --to-profile <name> Which of OUR browser profiles the cookies go into, by slug
                      or display name (terminal-browser profile lists them).
                      Default: the profile that browser is already on. An unknown
                      or ambiguous name copies nothing
  --domain <list>     Only these domains and their subdomains. Comma, semicolon
                      or space separated, *.example.com and .example.com both
                      work, and the flag can be repeated
  --browser <key>     A browser key from terminal-browser ls

Examples:
  terminal-browser import-cookies
  terminal-browser import-cookies -y --from brave
  terminal-browser import-cookies --profile Default
  terminal-browser import-cookies --domain github.com --json
  terminal-browser import-cookies --domain "github.com, *.slack.com"
  terminal-browser import-cookies --profile Work --to-profile work
`,
  },
  profile: {
    summary: "Manage the browser profiles that hold your logins",
    usage: "terminal-browser profile [list|create|rename|delete|clear] [options]",
    body: `
A profile is a separate box for cookies, local storage and history. Pages opened
on one profile know nothing about pages opened on another, so you can be signed
into the same site twice at once. Every browser starts on the default profile,
which is the one already holding the logins you have now.

The profiles are one list, kept where every browser here reads it. Listing them
works whether or not one is running; making, renaming, deleting and clearing
need a browser to do the work. With no subcommand this lists them. "profiles"
is the same command.

Subcommands:
  list                Every profile, one per line: slug, then display name, then
                      (active) if a running pane is on it and (default) for the
                      default profile. Alias: ls
  create <name>       Make a profile. Aliases: add, new
  rename <profile> <name>
                      Give a profile a new display name
  delete <profile>    Take a profile off the list and discard its data.
                      Aliases: remove, rm
  clear <profile>     Keep the profile but empty it, signing it out of every site

A <profile> is a slug or a display name, matched ignoring case and surrounding
space. A display name that fits more than one profile is refused rather than
guessed at, and so is one that fits none; both name what you typed.

Options:
  --name <name>       The name, instead of the words after the subcommand
  --profile <name>    The profile to act on, instead of the first word
  -y, --yes           Delete or clear without asking
  --json              Print the result as JSON instead of a sentence

delete and clear both throw logins away for good, so in a terminal they say what
goes and ask first. Answer anything but y and nothing happens. As with
import-cookies, having no terminal to ask in is not consent: without one they
refuse unless -y is there, so a script or an agent has to say so outright.

To open on a profile rather than manage one, terminal-browser open --profile
<name>. To see which profile each running browser is on, terminal-browser ls.

Examples:
  terminal-browser profile
  terminal-browser profile create Work
  terminal-browser profile rename Work "Work (EU)"
  terminal-browser profile clear work -y
  terminal-browser profile delete work
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
