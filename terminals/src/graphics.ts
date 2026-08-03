import fs from "node:fs";

export type GraphicsSupport = "supported" | "unsupported" | "unknown";

export const SKIP_ENV = "TERMINAL_BROWSER_SKIP_GRAPHICS_CHECK";

const PROBE_ID = 4207;

const PROBE_TIMEOUT_MS = 500;

function passthrough(seq: string): string {
  return `\x1bPtmux;${seq.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

function probeSequence(tmux: boolean): string {
  const query = `\x1b_Gi=${PROBE_ID},a=q,t=d,f=24,s=1,v=1;AAAA\x1b\\`;
  return `${tmux ? passthrough(query) : query}\x1b[c`;
}

function graphicsReply(buffer: string): boolean | null {
  const needle = `Gi=${PROBE_ID};`;
  const at = buffer.indexOf(needle);
  if (at < 0) return null;
  const rest = buffer.slice(at + needle.length);
  if (rest.length < 2) return null;
  return rest.startsWith("OK");
}

function sawPrimaryDa(buffer: string): boolean {
  return /\x1b\[\?[0-9;]*c/.test(buffer);
}

export function probeKittyGraphics(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GraphicsSupport> {
  const stdin = process.stdin;
  if (!stdin.isTTY || !process.stdout.isTTY || typeof stdin.setRawMode !== "function") {
    return Promise.resolve("unknown");
  }

  const tmux = Boolean(env.TMUX);
  const wasRaw = stdin.isRaw;

  return new Promise<GraphicsSupport>((resolve) => {
    let buffer = "";
    let done = false;
    let timer: NodeJS.Timeout;

    const finish = (result: GraphicsSupport) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      stdin.pause();
      // leave the tty exactly as we found it — the caller may still need to read
      try {
        stdin.setRawMode(wasRaw);
      } catch {}
      resolve(result);
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("binary");
      const reply = graphicsReply(buffer);
      if (reply !== null) return finish(reply ? "supported" : "unsupported");
      // inside tmux the DA1 answer comes from tmux itself, so it can beat the outer
      // terminal's passthrough reply — there it is not evidence of anything
      if (!tmux && sawPrimaryDa(buffer)) return finish("unsupported");
      if (buffer.length > 1024) finish("unknown");
    };

    try {
      stdin.setRawMode(true);
    } catch {
      return resolve("unknown");
    }
    stdin.resume();
    stdin.on("data", onData);

    timer = setTimeout(() => {
      finish(sawPrimaryDa(buffer) ? "unsupported" : "unknown");
    }, PROBE_TIMEOUT_MS);

    try {
      fs.writeSync(1, probeSequence(tmux));
    } catch {
      finish("unknown");
    }
  });
}

/** Best guess from the environment, for when we cannot probe the tty. */
export function graphicsFromEnv(env: NodeJS.ProcessEnv = process.env): GraphicsSupport {
  const term = env.TERM ?? "";
  if (term.includes("kitty") || env.KITTY_WINDOW_ID || env.KITTY_PID) return "supported";
  if (term.includes("ghostty") || env.TERM_PROGRAM === "ghostty" || env.GHOSTTY_RESOURCES_DIR) {
    return "supported";
  }
  if (env.TERM_PROGRAM === "WezTerm" || env.WEZTERM_PANE) return "supported";
  // iTerm2 implements the kitty graphics protocol (3.5+). LC_TERMINAL survives
  // into nested tmux, so this still identifies the outer host there.
  if (
    env.TERM_PROGRAM === "iTerm.app" ||
    env.LC_TERMINAL === "iTerm2" ||
    env.ITERM_SESSION_ID ||
    env.ITERM_PROFILE
  ) {
    return "supported";
  }
  // tmux hides whatever is outside it; without a probe we cannot say
  if (env.TMUX) return "unknown";
  return "unsupported";
}

export async function checkKittyGraphics(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GraphicsSupport> {
  if (env[SKIP_ENV]) return "supported";
  const probed = await probeKittyGraphics(env);
  return probed === "unknown" ? graphicsFromEnv(env) : probed;
}

export function unsupportedGraphicsMessage(color = false): string {
  const sgr = (code: string, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  return [
    "",
    `  ${sgr("1", "This terminal cannot show images, which terminal-browser needs.")}`,
    "",
    `  ${sgr("2", "We recommend Ghostty:")}`,
    `  ${sgr("4", "https://ghostty.org/download")}`,
    "",
    `  ${sgr("2", "Any terminal that supports the kitty graphics protocol works too.")}`,
    "",
  ].join("\n");
}
