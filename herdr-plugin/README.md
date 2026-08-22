# terminal-browser herdr plugin
A real browser that runs inside your terminal



<video src="https://github.com/user-attachments/assets/abe2f43e-fc50-4866-b753-33388967945d" controls></video>

### Install (macOS & Linux)

```bash
herdr plugin install zenbu-labs/terminal-browser/herdr-plugin
```
### Herdr actions 
#### `open-split`

Open terminal-browser in a split to the right of your focused pane.

#### `open-url`

The handler behind ctrl-clicking a link. It opens the link as a tab in the browser already
on screen in that herdr tab, or elsewhere in that workspace, and only splits a new browser
in when the workspace has none. A browser in another workspace is left alone, so a click
never sends a page to a space you are not looking at.

### Usage
```
terminal-browser # launches the browser
terminal-browser open <url> # opens the browser at a url
terminal-browser --split right # opens the browser in a split pane to the right
terminal-browser ls # lists open browsers
terminal-browser action # an agent-browser compatible cli for interacting with open terminal-browsers
```


### Use cases:
- You can have a coding agent and website scoped to the same terminal tab
- Your agent has full access to interact with open terminal-browsers, which gives your agent the capability to use the web
- You can ask an agent to make HTML plans and them open them inside terminal-browser, which will automatically open in a split pane next to your agent
- terminal-browser works over SSH, which allows you to preview websites running on remote machines easily

