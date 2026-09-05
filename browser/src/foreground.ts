import { app } from "electron";

import { createSession } from "./session/session";

export const FOREGROUND_FLAG = "--foreground";

export async function runForeground(cdpPort: number | null): Promise<void> {
  const session = createSession({
    key: String(process.pid),
    argv: process.argv.slice(2).filter((arg) => arg !== FOREGROUND_FLAG),
    env: process.env,
    cwd: process.cwd(),
    cdpPort,
    onClose: (code) => app.exit(code),
  });
  await session.ready;
}
