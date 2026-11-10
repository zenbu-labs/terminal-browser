<img width="86" height="86" style="margin-bottom: -10px" alt="The pixel logo: a red square stacked on a green and a blue square" src="website/app/icon.svg" />

# Pixel

A library for building graphical applications in the terminal

```
npm create @zenbu-labs/pixel@latest
```

<img alt="pixel demos: terminal-browser, terminal-code and Zed running in a terminal" src="website/public/media/demos.gif" height="400" />

## Notable features:

- A react API to use a rust based graphics engine that runs in the terminal
- WebView component that lets you render web content
- Support for proxying network requests made by the webview over an SSH connection
- Can be embedded inside other terminal applications
- Built in devtools (element inspector, profiler, log viewer)
- Cross platform

## Projects using pixel

- [terminal-browser](https://github.com/zenbu-labs/terminal-browser) - a browser inside the terminal
- [terminal-code](https://github.com/zenbu-labs/terminal-code) - vscode inside the terminal
# Docs

The documentation below is meant for humans. For detailed api documentation for your agents please reference [AGENT-DOCS.md](./AGENT-DOCS.md), the [examples](./examples), and the codebase itself.

## How does it work

Pixel allows for GUIs in the terminal by using a terminal feature to display raw pixels. Terminal programs can use this feature through a standard known as the [kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/). This standard allows terminal programs to write instructions to stdout that tell the terminal:
- what pixels to display
- what region to display the pixels

Under the hood, the Pixel library is converting UI definitions into kitty graphics instructions.

## Rendering types
Pixel has 2 ways to render UI:
1. the native react API
2. the webview component

These 2 options will give you significantly different results. 

The webview component lets you render full fidelity webapps, using the chromium browser engine under the hood. This means chromium speed and styling capabilities. 

The native react api lets you define your UI in react, but this gets interpreted by the pixel engine under the hood, which has less styling capabilities than css, and for heavy UI would be less efficient than chromium.

One downside to using the webview component is that it requires your app to spawn a new [renderer process](https://www.chromium.org/developers/design-documents/multi-process-architecture/#architectural-overview), which can easily consume hundreds of mb. While the pixel engine can use <10mb for a simple app.

The native UI and webview component can be useful if paired together since it allows you to embed webview components relative to the native UI elements. This allows you to implement a tabbed browser like [terminal-browser](https://github.com/zenbu-labs/terminal-browser)




## Multiplexers
Pixel apps will work in multiplexers, but will have worse performance, and may loose capabilities, like receiving lower precision mouse position values.


This is because multiplexers rewrite the output of terminal programs in a way that:
- forces pixel to send graphics commands in a de-optimized format
- (might) drop requests for terminal features like precise mouse position reporting

[Herdr](https://herdr.dev/) and [tmux](https://github.com/tmux/tmux) are examples of multiplexers that have been tested to work with pixel.


## SSH
Pixel will work out of the box over SSH.

Displaying graphics over SSH is possible because pixel sends the image data through stdout, just like any other terminal program output. Though, this is a de-optimization compared to running a pixel app locally. When the terminal and pixel app are on the same machine, pixel transfers image data to the terminal through shared memory.

In supported terminals, pixel will only send changed pixels over the SSH connection to minimmize bandwidth usage and improve performance. 

Pixel also comes with support for proxying webview network requests over an SSH connection. This is useful if you want to run a backend on a remote server for an application, but still want the UI to run locally. The best example of this is the pixel app [terminal-code](https://github.com/zenbu-labs/terminal-code), which allows users to install the vscode server on a remote machine, and then run the vscode UI locally through the terminal. Another example is [terminal-browser](https://github.com/zenbu-labs/terminal-browser), which lets you access localhost URLs on a remote machine through this SSH proxying feature.

## Terminal scripting
Pixel provides a standardized way to script the host terminal the pixel app is running in.

This is extremely useful if you expect you would want an agent to open the pixel app for you next to itself. For example, imagine the following scenario for the pixel app [terminal-browser](https://github.com/zenbu-labs/terminal-browser):

> [user] Can you open my website inside terminal-browser?
> 
> [agent] Sure!
> 
> [agent] Bash(terminal-browser open localhost:3000 --split right)

In this scenario, `--split right` is powered by pixels terminal scripting API, which under the hood implements scripting commands for many terminals and multiplexers.


## Devtools

Pixel comes with built in devtools, available by right clicking an app in dev mode. The most useful tool is the profiler, which can be used to optimize performance w/ agents by doing the following:
1. start a profile
2. interact with the app to cause slowdown
3. stop and export the profile

Agents can read the exported profile, and optimize based on the data.

The profiler devtool also gives you an option to see what pixel data is being sent to the terminal

https://github.com/user-attachments/assets/681a1578-2c32-4dde-a4e8-2470c4dea7dc


## UI Transparency
Pixel native UI and webviews support transparency. By default native UI has transparency on, so it will automatically show your terminal background color, and if your terminal background is transparent, that will also apply to the pixel UI. Webviews by default are opaque, but can be flipped on through the webview options.

Because of internal implementation details, rendering opaque UI is slightly more performant compared to transparent UI. So if you are trying to minimize CPU usage, you can try making all content opaque.



## Questions
If you are curious how something works or behaves, I highly recommend asking your coding agent to clone this github repo and explore this package, then ask whatever questions you want!

