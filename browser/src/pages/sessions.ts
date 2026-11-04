import { app, session as electronSession } from "electron";
import type { Session } from "electron";

// Runs `configure` once for the default session and for every partition session
// created later (SSH panes browse in their own partition).
export function forEverySession(configure: (session: Session) => void): (session: Session) => boolean {
  const configured = new WeakSet<Session>();
  const once = (session: Session) => {
    if (configured.has(session)) return;
    configured.add(session);
    configure(session);
  };
  once(electronSession.defaultSession);
  app.on("session-created", once);
  return (session) => configured.has(session);
}
