import Carousel, { type Demo } from "./components/carousel";
import { DiscordMark, GithubMark, NpmMark, StarIcon } from "./components/icons";
import Install from "./components/install";
import LinkTracker from "./components/link-tracker";
import PixelBackground from "./components/pixel-background";
import { starCount } from "./components/stars";
import Wordmark from "./components/wordmark";
import WipTag from "./components/wip-tag";

export const revalidate = 3600;

const REPO = "https://github.com/zenbu-labs/terminal-browser";
const PIXEL = `${REPO}/tree/main/pixel`;
const DOCS = `${PIXEL}#docs`;
const EXAMPLES = `${PIXEL}/examples`;

const FEATURES = [
  "120 fps pixel perfect graphics in the terminal",
  "Embeddable inside existing TUIs",
  "Built in Chromium WebView component",
  "Cross platform",
  "TypeScript React API",
  "Agent-friendly dev tools",
];

const DEMOS: Demo[] = [
  {
    label: "Browser",
    media: { kind: "video", src: "/media/browser.mp4", poster: "/media/browser-poster.jpg", size: [1954, 1214] },
    caption: <a href="https://terminal-browser.com">terminal-browser.com →</a>,
  },
  {
    label: "Vscode",
    media: { kind: "video", src: "/media/vscode.mp4", poster: "/media/vscode-poster.jpg", size: [1972, 1240] },
    caption: <a href="https://terminal-code.com">terminal-code.com →</a>,
  },
  {
    label: "Zed",
    media: { kind: "video", src: "/media/zed.mp4", poster: "/media/zed-poster.jpg", size: [1954, 1214] },
    caption: <a href={`${EXAMPLES}/zed`}>examples/zed →</a>,
  },
];

const TERMINALS = [
  { name: "Ghostty", icon: "/terminals/ghostty.png" },
  { name: "iTerm2", icon: "/terminals/iterm2.png" },
  { name: "xterm.js", icon: "/terminals/xtermjs.png" },
  { name: "Konsole", icon: "/terminals/konsole.svg" },
  { name: "WezTerm", icon: "/terminals/wezterm.svg" },
  { name: "Warp", icon: "/terminals/warp.svg" },
  { name: "noctty (Ghostty for Windows)", icon: "/terminals/noctty.svg" },
  { name: "Mobile SSH", icon: "/terminals/mobile-ssh.svg" },
  { name: "st (with a patch)", icon: "/terminals/st.svg" },
  { name: "wayst", icon: "/terminals/wayst.svg" },
  { name: "AbsoluteTelnet/SSH", icon: "/terminals/absolutetelnet.png" },
  { name: "cmux", icon: "/terminals/cmux.png" },
  { name: "tty7", icon: "/terminals/tty7.svg" },
  { name: "VS Code", icon: "/terminals/vscode.svg" },
  { name: "Cursor", icon: "/terminals/cursor.svg" },
];

const USED_BY = [
  { name: "terminal-browser", repo: "zenbu-labs/terminal-browser", description: "a real browser inside your terminal" },
  { name: "terminal-code", repo: "zenbu-labs/terminal-code", description: "vscode inside your terminal" },
];

export default async function Home() {
  const stars = Object.fromEntries(await Promise.all(USED_BY.map(async (p) => [p.repo, await starCount(p.repo)])));

  return (
    <>
      <PixelBackground />
      <LinkTracker />
      <div className="col">
        <header className="site" data-area="header">
          <span />
          <span className="right">
            <a href={DOCS}>docs</a>
            <a href={EXAMPLES}>examples</a>
            <a className="gh-stars" href={PIXEL} title="zenbu-labs/terminal-browser/pixel">
              <GithubMark />
              <b>
                <StarIcon />
                <span>{stars["zenbu-labs/terminal-browser"]}</span>
              </b>
            </a>
          </span>
        </header>

        <div className="hero">
          <Wordmark />
          {/* fixme: placeholder copy */}
          <p className="lede">Build graphical applications in the terminal</p>
          <Install />
        </div>

        <section data-area="demos">
          {/* fixme: placeholder copy */}
          <h2>Demos</h2>
          <Carousel demos={DEMOS} />
        </section>

        <section data-area="features">
          {/* fixme: placeholder copy */}
          <h2>Features</h2>
          <ul className="facts">
            {FEATURES.map((feature) => (
              <li key={feature}>{feature}</li>
            ))}
          </ul>
        </section>

        <section data-area="platforms">
          {/* fixme: placeholder copy */}
          <h2>Supported platforms</h2>
          <ul className="facts platforms">
            <li>
              <span>macOS</span>
              <span className="detail">Apple Silicon · Intel</span>
            </li>
            <li>
              <span>Linux</span>
              <span className="detail">arm64 · x64</span>
            </li>
            <li>
              <span>Windows</span>
              <WipTag
                tooltip="You can use pixel on Windows today through WSL. Native Windows support is a work in progress."
              >
                WIP
              </WipTag>
            </li>
          </ul>
        </section>

        <section data-area="used_by">
          {/* fixme: placeholder copy */}
          <h2>Used by</h2>
          <div className="rows">
            {USED_BY.map((project) => (
              <a key={project.repo} href={`https://github.com/${project.repo}`}>
                <span className="n">{project.name}</span>
                <span className="d">{project.description}</span>
                <span className="m">
                  <StarIcon />
                  <span>{stars[project.repo]}</span>
                </span>
              </a>
            ))}
          </div>
        </section>

        <section data-area="terminals">
          {/* fixme: placeholder copy */}
          <h2>Supported terminals</h2>
          <ul className="terminals">
            {TERMINALS.map((terminal) => (
              <li key={terminal.name}>
                <img src={terminal.icon} alt="" />
                {terminal.name}
              </li>
            ))}
          </ul>
        </section>

        <footer data-area="footer">
          <span>© 2026 terminal-browser</span>
          <span className="links">
            <a href="https://www.npmjs.com/package/@zenbu-labs/pixel" aria-label="npm" title="npm">
              <NpmMark />
            </a>
            <a href="https://discord.gg/t3jzHHfc6z" aria-label="Discord" title="Discord">
              <DiscordMark />
            </a>
            <a href={PIXEL} aria-label="GitHub" title="GitHub">
              <GithubMark />
            </a>
          </span>
        </footer>
      </div>
    </>
  );
}
