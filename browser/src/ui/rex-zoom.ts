import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { useEffect, useState } from "react";

const exec = promisify(execFile);

export const REX_ZOOM_BUTTONS_POINTS = 35;

const RECONNECT_MS = 1000;

interface RexSession {
  windows: { zoomed_block_id?: string }[];
}

interface RexEvent {
  payload?: { event?: { type?: string } };
}

export function useInsideRexZoom(env: NodeJS.ProcessEnv): boolean {
  const [zoomed, setZoomed] = useState(false);
  const session = env.REX_SESSION;
  const block = env.REX_BLOCK;

  useEffect(() => {
    if (!session || !block) return;
    let stopped = false;
    let checking = false;
    let stale = false;

    async function check() {
      if (checking) {
        stale = true;
        return;
      }
      checking = true;
      do {
        stale = false;
        const view = await exec("rex", ["session", "inspect", session!, "--json"], { env })
          .then(({ stdout }) => JSON.parse(stdout) as RexSession)
          .catch(() => null);
        if (view && !stopped) setZoomed(view.windows.some((window) => window.zoomed_block_id === block));
      } while (stale && !stopped);
      checking = false;
    }

    let events: ChildProcess | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;

    function follow() {
      const child = spawn("rex", ["events", "-s", session!, "--json"], {
        env,
        stdio: ["ignore", "pipe", "ignore"],
      });
      child.on("error", () => {});
      child.on("exit", () => {
        if (!stopped) reconnect = setTimeout(follow, RECONNECT_MS);
      });
      createInterface({ input: child.stdout }).on("line", (line) => {
        try {
          const event = JSON.parse(line) as RexEvent;
          if (event.payload?.event?.type === "session_view_changed") void check();
        } catch {}
      });
      events = child;
      void check();
    }

    follow();
    return () => {
      stopped = true;
      if (reconnect) clearTimeout(reconnect);
      events?.kill();
    };
  }, [session, block]);

  return zoomed;
}
