export type HintOutcome =
  | { type: "none" }
  | { type: "cancelled" }
  | { type: "done" }
  | { type: "openTab"; url: string };

export interface HintOptions {
  newTab: boolean;
  alphabet: string;
  labels: (count: number, alphabet: string) => string[];
}

export const CANCEL_HINTS = "window.__terminalBrowserHints?.()";

export function showHints(options: HintOptions): Promise<HintOutcome> {
  const scope = window as unknown as { __terminalBrowserHints?: () => void };
  if (scope.__terminalBrowserHints) {
    scope.__terminalBrowserHints();
    return Promise.resolve({ type: "cancelled" });
  }

  const selector = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "summary",
    "label[for]",
    "[contenteditable='']",
    "[contenteditable=true]",
    "[onclick]",
    "[tabindex]:not([tabindex='-1'])",
    "[role=button]",
    "[role=link]",
    "[role=tab]",
    "[role=checkbox]",
    "[role=menuitem]",
    "[role=option]",
  ].join(",");

  const visibleBox = (element: Element): DOMRect | null => {
    if ((element as HTMLButtonElement).disabled) return null;
    for (const box of element.getClientRects()) {
      if (box.width <= 0 || box.height <= 0) continue;
      if (box.bottom <= 0 || box.right <= 0 || box.top >= innerHeight || box.left >= innerWidth) continue;
      const x = Math.min(Math.max(box.left + box.width / 2, 0), innerWidth - 1);
      const y = Math.min(Math.max(box.top + box.height / 2, 0), innerHeight - 1);
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === element || element.contains(hit))) return box;
    }
    return null;
  };

  const targets: { element: HTMLElement; box: DOMRect }[] = [];
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    const box = visibleBox(element);
    if (box) targets.push({ element, box });
  }
  if (targets.length === 0) return Promise.resolve({ type: "none" });

  const codes = options.labels(targets.length, options.alphabet);
  const host = document.createElement("div");
  host.setAttribute(
    "style",
    "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;",
  );
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `.hint {
    position: fixed;
    padding: 0 3px;
    background: #ffd76e;
    color: #302505;
    border: 1px solid #c38a22;
    border-radius: 3px;
    font: bold 11px/1.4 ui-monospace, monospace;
    text-transform: uppercase;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  }
  .typed { color: #a8862a; }`;
  root.appendChild(style);

  const hints = targets.map((target, index) => {
    const label = document.createElement("span");
    label.className = "hint";
    label.style.left = `${Math.max(0, target.box.left)}px`;
    label.style.top = `${Math.max(0, target.box.top)}px`;
    root.appendChild(label);
    return { ...target, code: codes[index]!, label };
  });

  let typed = "";
  const paint = () => {
    for (const hint of hints) {
      const matches = hint.code.startsWith(typed);
      hint.label.style.display = matches ? "" : "none";
      if (!matches) continue;
      const done = document.createElement("span");
      done.className = "typed";
      done.textContent = typed;
      hint.label.replaceChildren(done, hint.code.slice(typed.length));
    }
  };
  paint();
  document.documentElement.appendChild(host);

  return new Promise<HintOutcome>((resolve) => {
    const finish = (outcome: HintOutcome) => {
      host.remove();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", cancel, true);
      window.removeEventListener("resize", cancel, true);
      delete scope.__terminalBrowserHints;
      resolve(outcome);
    };
    const cancel = () => finish({ type: "cancelled" });

    const isField = (element: HTMLElement) =>
      element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName);

    const act = (element: HTMLElement) => {
      if (isField(element)) {
        element.focus();
        return finish({ type: "done" });
      }
      const anchor = element.closest("a[href]") as HTMLAnchorElement | null;
      if (options.newTab && anchor) return finish({ type: "openTab", url: anchor.href });
      finish({ type: "done" });
      element.click();
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") return cancel();
      if (event.key === "Backspace") {
        typed = typed.slice(0, -1);
        return paint();
      }
      const next = typed + event.key.toLowerCase();
      if (event.key.length !== 1 || !hints.some((hint) => hint.code.startsWith(next))) return;
      typed = next;
      const exact = hints.find((hint) => hint.code === typed);
      if (exact) return act(exact.element);
      paint();
    };

    const focused = document.activeElement;
    if (focused instanceof HTMLIFrameElement) focused.blur();
    scope.__terminalBrowserHints = cancel;
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", cancel, true);
    window.addEventListener("resize", cancel, true);
  });
}
