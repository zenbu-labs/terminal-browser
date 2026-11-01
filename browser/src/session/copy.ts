export interface PageSelection {
  text: string;
  frame: Electron.WebFrameMain;
  timeOrigin: number;
  url: string;
}

export async function readPageSelection(contents: Electron.WebContents): Promise<PageSelection | null> {
  try {
    if (contents.isDestroyed()) return null;
    const frame = contents.focusedFrame;
    if (!frame || frame.isDestroyed() || frame.detached) return null;
    const url = frame.url;
    const result = await frame.executeJavaScript(`(() => {
      const element = document.activeElement;
      let text;
      if (element && typeof element.selectionStart === "number" && typeof element.selectionEnd === "number") {
        text = element.value.slice(element.selectionStart, element.selectionEnd);
      } else {
        text = String(getSelection() ?? "");
      }
      return { text, timeOrigin: performance.timeOrigin };
    })()`) as { text?: unknown; timeOrigin?: unknown } | null;
    if (
      typeof result?.text !== "string" || !result.text ||
      typeof result.timeOrigin !== "number" || !Number.isFinite(result.timeOrigin)
    ) return null;
    return { text: result.text, timeOrigin: result.timeOrigin, frame, url };
  } catch {
    return null;
  }
}

export async function isPageSelectionCurrent(selection: PageSelection): Promise<boolean> {
  try {
    const { frame, timeOrigin, url } = selection;
    if (frame.isDestroyed() || frame.detached || frame.url !== url) return false;
    return (await frame.executeJavaScript("performance.timeOrigin")) === timeOrigin && frame.url === url;
  } catch {
    return false;
  }
}
