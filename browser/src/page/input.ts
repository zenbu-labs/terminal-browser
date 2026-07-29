import { clipboard, nativeImage } from "electron";
import type { WebContents } from "electron";
import type { EngineKeyEvent, PastedImage, PointerEvent, WheelEvent } from "pixel-react";

export interface InputTarget {
  contents(): WebContents;
  scale(): number;
  focus(): void;
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
  cdpInput: boolean;
}

/** Translates engine pointer/wheel/key events into chromium input events for
 * one webContents. Shared by the main page and popup windows. */
export class PageInput {
  private readonly target: InputTarget;
  private lastX = 0;
  private lastY = 0;
  private lastSentX = 0;
  private lastSentY = 0;
  private pressed = new Set<"left" | "middle" | "right">();
  private click = { button: "none", at: 0, x: 0, y: 0, count: 0 };
  private activeClickCount = 1;
  private wheelRemainderX = 0;
  private wheelRemainderY = 0;
  private sentKeys = new Set<string>();

  constructor(target: InputTarget) {
    this.target = target;
  }

  pointer(event: PointerEvent) {
    this.target.focus();
    const scale = this.target.scale();
    const x = Math.max(0, Math.round(event.x / scale));
    const y = Math.max(0, Math.round(event.y / scale));
    this.lastX = x;
    this.lastY = y;
    const button = event.button === "none" ? undefined : event.button;
    if (event.kind === "down" && button) {
      this.pressed.add(button);
      this.activeClickCount = this.nextClickCount(button, x, y);
    }
    if (event.kind === "up" && button) this.pressed.delete(button);
    const modifiers = this.modifiers(event.mods);
    for (const pressed of this.pressed) modifiers.push(`${pressed}buttondown`);
    if (this.target.cdpInput) {
      void this.target.cdp("Input.dispatchMouseEvent", {
        type:
          event.kind === "down"
            ? "mousePressed"
            : event.kind === "up"
              ? "mouseReleased"
              : "mouseMoved",
        x,
        y,
        button: button ?? "none",
        buttons: cdpButtons(this.pressed),
        clickCount: event.kind === "move" ? 0 : this.activeClickCount,
        modifiers: cdpModifiers(event.mods),
        pointerType: "mouse",
      });
      this.lastSentX = x;
      this.lastSentY = y;
      return;
    }
    this.target.contents().sendInputEvent({
      type:
        event.kind === "down"
          ? "mouseDown"
          : event.kind === "up"
            ? "mouseUp"
            : "mouseMove",
      x,
      y,
      movementX: x - this.lastSentX,
      movementY: y - this.lastSentY,
      button,
      clickCount: event.kind === "move" ? 0 : this.activeClickCount,
      modifiers,
    });
    this.lastSentX = x;
    this.lastSentY = y;
  }

  wheel(event: WheelEvent) {
    this.target.focus();
    if (event.mods.ctrl && event.precise) {
      this.pinch(event);
      return;
    }
    const scale = this.target.scale();
    this.wheelRemainderX += -event.deltaX / scale;
    this.wheelRemainderY += -event.deltaY / scale;
    const deltaX = wholeDelta(this.wheelRemainderX);
    const deltaY = wholeDelta(this.wheelRemainderY);
    this.wheelRemainderX -= deltaX;
    this.wheelRemainderY -= deltaY;
    if (deltaX === 0 && deltaY === 0) return;
    if (this.target.cdpInput) {
      // the devtools protocol negates wheel deltas internally, so it takes
      // them with the DOM sign — opposite of sendInputEvent below
      void this.target.cdp("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: this.lastX,
        y: this.lastY,
        deltaX: -deltaX,
        deltaY: -deltaY,
        modifiers: cdpModifiers(event.mods),
        pointerType: "mouse",
      });
      return;
    }
    this.target.contents().sendInputEvent({
      type: "mouseWheel",
      x: this.lastX,
      y: this.lastY,
      deltaX,
      deltaY,
      // chromium exposes wheelTicks*120 to pages as the legacy wheelDelta;
      // js scrollers like monaco read only that, so zero ticks kill their
      // scrolling. real macOS trackpads report one tick per 40 pixels
      wheelTicksX: event.precise ? deltaX / 40 : Math.sign(deltaX),
      wheelTicksY: event.precise ? deltaY / 40 : Math.sign(deltaY),
      hasPreciseScrollingDeltas: event.precise,
      canScroll: true,
      // trackpad pinch reaches pages the way chromium delivers it natively:
      // as ctrl+wheel events (the engine already encodes pinch that way)
      modifiers: this.modifiers(event.mods),
    });
  }

  // A ctrl+precise wheel only ever means trackpad pinch (the engine encodes
  // pinch that way, and modified scrolls from the terminal are never precise).
  // Chromium delivers pinch to pages as a synthetic wheel built in
  // TouchpadPinchEventQueue: deltaY = 100*ln(scale), deltaX = 0, wheel ticks
  // carry only the sign, position pinned to the cursor. Pages recover the
  // scale with Math.exp(-deltaY/100). The engine encodes deltaY as
  // -magnification*100, so scale = 1 - deltaY/100.
  private pinch(event: WheelEvent) {
    const pinchScale = 1 - event.deltaY / 100;
    if (pinchScale <= 0) return;
    if (this.target.cdpInput) {
      void this.target.cdp("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: this.lastX,
        y: this.lastY,
        deltaX: 0,
        deltaY: -100 * Math.log(pinchScale),
        modifiers: 2,
        pointerType: "mouse",
      });
      return;
    }
    this.target.contents().sendInputEvent({
      type: "mouseWheel",
      x: this.lastX,
      y: this.lastY,
      deltaX: 0,
      deltaY: 100 * Math.log(pinchScale),
      wheelTicksX: 0,
      wheelTicksY: pinchScale > 1 ? 1 : -1,
      hasPreciseScrollingDeltas: true,
      canScroll: true,
      modifiers: ["ctrl"],
    });
  }

  key(event: EngineKeyEvent) {
    if (event.key === "enter") {
      void this.dispatchEnter(event).catch(() => {});
      return;
    }
    const commands = editingCommands(event);
    if (commands) {
      void this.dispatchEditing(event, commands).catch(() => {});
      return;
    }
    const keyCode = electronKey(event.key);
    if (event.kind === "release") {
      if (!keyCode || !this.sentKeys.delete(event.key)) return;
      const modifiers = this.modifiers(event.mods);
      if (event.key.startsWith("left")) modifiers.push("left");
      if (event.key.startsWith("right")) modifiers.push("right");
      this.target.contents().sendInputEvent({ type: "keyUp", keyCode, modifiers });
      return;
    }
    this.target.focus();
    if (!keyCode) {
      if (event.text) {
        this.target.contents().insertText(event.text);
      }
      return;
    }
    const modifiers = this.modifiers(event.mods);
    if (event.key.startsWith("left")) modifiers.push("left");
    if (event.key.startsWith("right")) modifiers.push("right");
    if (event.kind === "repeat") modifiers.push("isautorepeat");
    this.sentKeys.add(event.key);
    this.target.contents().sendInputEvent({ type: "rawKeyDown", keyCode, modifiers });
    const printable = !!event.text && !event.mods.ctrl && !event.mods.super && !event.mods.alt;
    if (printable) {
      this.target.contents().sendInputEvent({ type: "char", keyCode: event.text!, modifiers });
    }
  }

  paste(text: string) {
    this.target.focus();
    void this.target.contents().insertText(text);
  }

  /** The selected text, wherever it is: a frame's document, or an editable
   * field inside one. Empty when nothing is selected. */
  async selectionText(): Promise<string> {
    for (const frame of this.target.contents().mainFrame.framesInSubtree) {
      const text = await frame.executeJavaScript(SELECTION_SNIPPET).catch(() => "");
      if (typeof text === "string" && text) return text;
    }
    return "";
  }

  cut() {
    this.target.contents().cut();
  }

  /** A native paste() hands the page a trusted event with every clipboard
   * flavor, so it's preferred whenever the OS clipboard actually holds the
   * image; the other sources only have the bytes at image.path, which must
   * be staged onto the clipboard first. */
  pasteImage(image: PastedImage) {
    this.target.focus();
    switch (image.source) {
      case "clipboard":
        this.target.contents().paste();
        return;
      case "osc":
      case "file": {
        const staged = nativeImage.createFromPath(image.path);
        // createFromPath only decodes png/jpeg; pasting without staging
        // would deliver whatever stale content the clipboard holds
        if (staged.isEmpty()) return;
        clipboard.writeImage(staged);
        this.target.contents().paste();
        return;
      }
    }
  }

  releaseKeys() {
    for (const key of this.sentKeys) {
      const keyCode = electronKey(key);
      if (!keyCode) continue;
      const modifiers: Electron.InputEvent["modifiers"] = [];
      if (key.startsWith("left")) modifiers.push("left");
      if (key.startsWith("right")) modifiers.push("right");
      this.target.contents().sendInputEvent({ type: "keyUp", keyCode, modifiers });
    }
    this.sentKeys.clear();
  }
  /**
   * 
   * why are we hard coding huerestics for vscode web??
   * 
   */

  // vs code web never acts on Enter keydowns synthesized by sendInputEvent —
  // its quick-open accept keybinding ignores them (identical DOM events
  // dispatched over the devtools protocol work), so enter goes through the
  // debugger instead
  private async dispatchEnter(event: EngineKeyEvent) {
    const base = {
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      modifiers: cdpModifiers(event.mods),
    };
    if (event.kind === "release") {
      await this.target.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      return;
    }
    this.target.focus();
    await this.target.cdp("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      ...base,
      autoRepeat: event.kind === "repeat",
    });
    if (!event.mods.ctrl && !event.mods.super && !event.mods.alt) {
      await this.target.cdp("Input.dispatchKeyEvent", { type: "char", text: "\r", ...base });
    }
  }

  // synthesized key events skip the macOS responder chain that turns combos
  // like cmd+backspace into editing commands, so the renderer ignores them;
  // the devtools protocol lets us attach the command to the key event directly
  private async dispatchEditing(event: EngineKeyEvent, commands: string[]) {
    const info = EDITING_KEY_INFO[event.key];
    if (!info) return;
    const base = {
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.keyCode,
      nativeVirtualKeyCode: info.keyCode,
      modifiers: cdpModifiers(event.mods),
    };
    if (event.kind === "release") {
      await this.target.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      return;
    }
    this.target.focus();
    await this.target.cdp("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      ...base,
      autoRepeat: event.kind === "repeat",
      commands,
    });
  }

  private nextClickCount(button: "left" | "middle" | "right", x: number, y: number) {
    const now = Date.now();
    const close = Math.abs(x - this.click.x) <= 4 && Math.abs(y - this.click.y) <= 4;
    const count = this.click.button === button && now - this.click.at <= 500 && close
      ? Math.min(this.click.count + 1, 3)
      : 1;
    this.click = { button, at: now, x, y, count };
    return count;
  }

  private modifiers(mods: { shift: boolean; alt: boolean; ctrl: boolean; super: boolean }) {
    const result: Electron.InputEvent["modifiers"] = [];
    if (mods.shift) result.push("shift");
    if (mods.alt) result.push("alt");
    if (mods.ctrl) result.push("ctrl");
    if (mods.super) result.push("meta");
    return result;
  }
}

// input types like number and email throw when asked where their selection is
const SELECTION_SNIPPET = `(() => {
  const el = document.activeElement;
  try {
    if (el && "selectionStart" in el && el.selectionStart !== el.selectionEnd) {
      return el.value.slice(el.selectionStart, el.selectionEnd);
    }
  } catch {}
  return String(getSelection() ?? "");
})()`;

function wholeDelta(value: number) {
  return value < 0 ? Math.ceil(value) : Math.floor(value);
}

function cdpModifiers(mods: { shift: boolean; alt: boolean; ctrl: boolean; super: boolean }) {
  return (
    (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.super ? 4 : 0) | (mods.shift ? 8 : 0)
  );
}

function cdpButtons(pressed: Set<"left" | "middle" | "right">) {
  return (
    (pressed.has("left") ? 1 : 0) |
    (pressed.has("right") ? 2 : 0) |
    (pressed.has("middle") ? 4 : 0)
  );
}

const EDITING_KEY_INFO: Record<string, { key: string; code: string; keyCode: number }> = {
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  a: { key: "a", code: "KeyA", keyCode: 65 },
  b: { key: "b", code: "KeyB", keyCode: 66 },
  d: { key: "d", code: "KeyD", keyCode: 68 },
  e: { key: "e", code: "KeyE", keyCode: 69 },
  f: { key: "f", code: "KeyF", keyCode: 70 },
  k: { key: "k", code: "KeyK", keyCode: 75 },
  u: { key: "u", code: "KeyU", keyCode: 85 },
  w: { key: "w", code: "KeyW", keyCode: 87 },
  z: { key: "z", code: "KeyZ", keyCode: 90 },
};

/** blink editing command(s) macOS would attach to this key combo, or null
 * when the combo is not an editing shortcut and should use the normal path */
function editingCommands(event: EngineKeyEvent): string[] | null {
  const { key, mods } = event;
  if (process.platform === "darwin" && mods.ctrl) return controlEditingCommands(event);
  const select = mods.shift ? "AndModifySelection" : "";
  if (key === "backspace") {
    if (mods.super) return ["deleteToBeginningOfLine"];
    if (mods.alt) return ["deleteWordBackward"];
    return null;
  }
  if (key === "b" && mods.alt && !mods.super) return [`moveWordLeft${select}`];
  if (key === "f" && mods.alt && !mods.super) return [`moveWordRight${select}`];
  if (key === "left" || key === "right") {
    const end = key === "left" ? "moveToLeftEndOfLine" : "moveToRightEndOfLine";
    const word = key === "left" ? "moveWordLeft" : "moveWordRight";
    if (mods.super) return [`${end}${select}`];
    if (mods.alt) return [`${word}${select}`];
    return null;
  }
  if (key === "up" || key === "down") {
    const edge = key === "up" ? "moveToBeginningOfDocument" : "moveToEndOfDocument";
    if (mods.super && !mods.alt) return [`${edge}${select}`];
    return null;
  }
  if (mods.super && !mods.alt && !mods.shift && key === "a") return ["selectAll"];
  if (mods.super && !mods.alt && key === "z") return [mods.shift ? "redo" : "undo"];
  return null;
}

/**
 * 
 * this is extremly odd to me and makes 0 sense and reads as slop
 * 
 */
// Ghostty's default keybinds rewrite cmd+backspace into ctrl+u, cmd+left/right
// into ctrl+a/ctrl+e, and option+arrows into esc b/f before the engine sees
// them, so the mac editing combos arrive here as these control keys (mirrors
// the engine's own text input handling)
function controlEditingCommands(event: EngineKeyEvent): string[] | null {
  const { key, mods } = event;
  if (mods.super || mods.alt) return null;
  const select = mods.shift ? "AndModifySelection" : "";
  switch (key) {
    case "a":
      return [`moveToLeftEndOfLine${select}`];
    case "e":
      return [`moveToRightEndOfLine${select}`];
    case "b":
      return [`moveLeft${select}`];
    case "f":
      return [`moveRight${select}`];
    case "d":
      return ["deleteForward"];
    case "k":
      return ["deleteToEndOfLine"];
    case "w":
      return ["deleteWordBackward"];
    case "u":
      return ["deleteToBeginningOfLine"];
    default:
      return null;
  }
}

export function electronKey(key: string) {
  const special: Record<string, string> = {
    enter: "return",
    backspace: "backspace",
    delete: "delete",
    escape: "escape",
    tab: "tab",
    up: "up",
    down: "down",
    left: "left",
    right: "right",
    home: "home",
    end: "end",
    insert: "insert",
    pageup: "pageup",
    pagedown: "pagedown",
    leftshift: "shift",
    leftcontrol: "control",
    leftalt: "alt",
    leftsuper: "meta",
    rightshift: "shift",
    rightcontrol: "control",
    rightalt: "alt",
    rightsuper: "meta",
  };
  if (key === "unknown") return null;
  return special[key] ?? key;
}
