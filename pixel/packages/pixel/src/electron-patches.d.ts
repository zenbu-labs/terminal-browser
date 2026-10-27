import type { PermissionCheckAnswer } from "./web/browser-session";
import type { MediaCapture } from "./web/types";

// The published electron.d.ts for the pinned version predates the media-capture and
// permission-check-prompt patches. Delete this once pixel pins an electron release built with them.
declare global {
  namespace Electron {
    interface WebContents {
      on(event: "media-capture-changed", listener: (event: Event, capture: MediaCapture) => void): this;
    }
    interface Session {
      setPermissionCheckHandler(
        handler:
          | ((
              webContents: WebContents | null,
              permission: string,
              requestingOrigin: string,
              details: PermissionCheckHandlerHandlerDetails,
            ) => PermissionCheckAnswer)
          | null,
      ): void;
    }
  }
}
