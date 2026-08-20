export const QUIT_URL = "terminal-browser://quit";

export type QuitUrlRequest = "navigation" | "window-open" | "redirect";
export type QuitUrlAction = "ignore" | "consume" | "close";

export class QuitUrlPolicy {
  constructor(
    private readonly allowed: boolean,
    private readonly primaryContentsId: number,
  ) {}

  request(
    url: string,
    requesterContentsId: number | undefined,
    request: QuitUrlRequest,
    initiatorContentsId?: number,
  ): QuitUrlAction {
    if (url !== QUIT_URL) return "ignore";
    if (
      request === "redirect" ||
      !this.allowed ||
      requesterContentsId !== this.primaryContentsId ||
      (request === "navigation" && initiatorContentsId !== this.primaryContentsId)
    ) {
      return "consume";
    }
    return "close";
  }
}

export function registerQuitUrlNavigationHandlers(
  contents: Electron.WebContents,
  resolveContents: (frame: Electron.WebFrameMain) => Electron.WebContents | undefined,
  handle: (
    url: string,
    request: Extract<QuitUrlRequest, "navigation" | "redirect">,
    targetContentsId: number | undefined,
    initiatorContentsId: number | undefined,
  ) => boolean,
) {
  const contentsId = (frame: Electron.WebFrameMain | null | undefined) => {
    if (!frame) return undefined;
    try {
      if (frame.detached || frame.isDestroyed()) return undefined;
      const resolved = resolveContents(frame);
      return resolved && !resolved.isDestroyed() ? resolved.id : undefined;
    } catch {
      return undefined;
    }
  };
  contents.on("will-frame-navigate", (event) => {
    if (
      handle(
        event.url,
        "navigation",
        contentsId(event.frame),
        contentsId(event.initiator),
      )
    ) {
      event.preventDefault();
    }
  });
  contents.on("will-redirect", (event) => {
    if (
      handle(event.url, "redirect", contentsId(event.frame), contentsId(event.initiator))
    ) {
      event.preventDefault();
    }
  });
}
