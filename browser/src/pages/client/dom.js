export const api = window.terminalBrowser;

// Builds DOM nodes. Strings become text nodes, so page data is never parsed as HTML.
export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "class") node.className = value;
    else if (key === "style") node.style.cssText = value;
    else if (key === "value") node.value = value;
    else if (key === "checked") node.checked = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function mount(...children) {
  const root = document.getElementById("app");
  const focused = document.activeElement?.id;
  const selection = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  root.replaceChildren();
  append(root, children);
  if (focused) {
    const again = document.getElementById(focused);
    if (again) {
      again.focus();
      if (selection && typeof again.setSelectionRange === "function") again.setSelectionRange(...selection);
    }
  }
}

export function toggle(checked, onChange, label) {
  return h("button", {
    class: "switch",
    role: "switch",
    "aria-checked": checked ? "true" : "false",
    "aria-label": label,
    onclick: (event) => {
      event.stopPropagation();
      onChange(!checked);
    },
  });
}

export function linkButton(text, onClick, extra = "") {
  return h("button", { class: `link ${extra}`.trim(), onclick: onClick }, text);
}

export function bytes(count) {
  if (!(count > 0)) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = count;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function dayStart(time) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function dayLabel(time) {
  const start = dayStart(time);
  const today = dayStart(Date.now());
  const long = new Date(time).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  if (start === today) return `Today - ${long}`;
  if (start === dayStart(today - 1)) return `Yesterday - ${long}`;
  return long;
}

export function clock(time) {
  return new Date(time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function groupByDay(items, timeOf) {
  const groups = [];
  for (const item of items) {
    const start = dayStart(timeOf(item));
    const last = groups[groups.length - 1];
    if (last && last.start === start) last.items.push(item);
    else groups.push({ start, items: [item] });
  }
  return groups;
}

export function live(load) {
  api.onChange(() => load());
  load();
}
