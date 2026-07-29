---
name: terminal-browser
description: A real browser running inside the terminal. It splits the human's terminal pane automatically, so you can show a website side by side with the conversation, render HTML to visualize something, and drive whatever tab is open — snapshot, click, fill, eval — with the `terminal-browser action` subcommand.
---

`terminal-browser open <url>` puts a browser in a terminal pane. With no
direction it takes over the current pane; `--split` (or a direction word) opens
a new pane beside the human, which is how you show a page next to the
conversation. A path to a local html file works the same as a url, so writing a
page and opening it is a way to show something you built.

`terminal-browser ls` shows the browsers and tabs in this terminal tab, with the
tab ids the other commands take.

`terminal-browser action -- <command>` drives a tab that is already open. It
targets this terminal tab's browser and its active tab unless you select another
one.

## Command reference

```
$ terminal-browser help
Usage: terminal-browser <command> [args]

  open    Open the browser in a terminal pane
  ls      List running browsers and their tabs
  setup   Turn on terminal images in vscode-family editors
  action  Drive an open tab (snapshot, click, fill, eval)
  help    Show this help

terminal-browser <command> --help for one command's options
```

```
$ terminal-browser open --help
Usage: terminal-browser open [url] [direction] [options]

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
```

```
$ terminal-browser ls --help
Usage: terminal-browser ls [options]

Lists the browsers running in this terminal tab, each with its tabs. The tab
ids it prints are what --tab takes in terminal-browser action.

Options:
  --all                 Every browser, not just this terminal tab
  --json                Machine readable, including cdp ports and pane ids
```

```
$ terminal-browser setup --help
Usage: terminal-browser setup

Editors built on vscode ship with terminal images switched off, so the browser
cannot draw anything in their terminals until "terminal.integrated.enableImages"
is true. This finds every vscode-family editor on this machine and turns it on,
leaving the rest of each settings file as it was.

The installer runs this for you. Run it again after installing a new editor.
```

```
$ terminal-browser action --help
Usage: terminal-browser action [selectors] -- <command>

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
```
