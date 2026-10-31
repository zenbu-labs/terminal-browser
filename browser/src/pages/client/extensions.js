import { api, bytes, h, linkButton, live, mount, toggle } from "./dom.js";

const COPY = {
  title: "Extensions",
  shortcuts: "Keyboard shortcuts",
  developerMode: "Developer mode",
  loadUnpacked: "Load unpacked",
  loadPlaceholder: "~/path/to/extension",
  load: "Load",
  cancel: "Cancel",
  empty: "No extensions installed",
  details: "Details",
  remove: "Remove",
  confirmRemove: "Confirm",
  reload: "Reload",
  errors: (count) => (count === 1 ? "1 error" : `${count} errors`),
  back: "← Extensions",
  description: "Description",
  version: "Version",
  size: "Size",
  id: "ID",
  permissions: "Permissions",
  noPermissions: "No special permissions",
  siteAccess: "Site access",
  noSiteAccess: "None",
  errorsLabel: "Errors",
  clear: "Clear",
  pin: "Pin to toolbar",
  userScripts: "Allow User Scripts",
  options: "Extension options",
  openOptions: "Open",
  source: "Source",
  unpacked: "Unpacked",
  path: "Path",
  removeExtension: "Remove extension",
  notFound: "This extension isn't installed",
  noCommands: "No extensions have keyboard shortcuts",
  notSet: "Not set",
  pressKeys: "Press a shortcut…",
  enabled: "On",
};

const state = {
  developerMode: false,
  extensions: [],
  loaded: false,
  loadOpen: false,
  loadError: "",
  loadPath: "",
  confirming: null,
  recording: null,
  error: "",
};

const route = location.pathname.startsWith("/shortcuts") ? "shortcuts" : new URLSearchParams(location.search).get("id") ? "details" : "list";
const detailsId = new URLSearchParams(location.search).get("id");
const MAC = navigator.platform.includes("Mac");

async function load() {
  try {
    const data = await api.list();
    state.developerMode = data.developerMode;
    state.extensions = data.extensions;
    state.loaded = true;
    state.error = "";
  } catch (error) {
    state.error = error.message;
  }
  render();
}

async function run(action) {
  try {
    state.error = "";
    await action();
  } catch (error) {
    state.error = error.message;
    render();
  }
}

function icon(extension, size = 24) {
  return extension.icon
    ? h("img", { class: "icon", src: extension.icon, alt: "", width: size, height: size })
    : h("span", { class: "icon blank" });
}

function errorBanner() {
  return state.error ? h("p", { class: "error" }, state.error) : null;
}

function header(title, ...extra) {
  return h("header", null, h("h1", null, title), ...extra);
}

function developerToggle() {
  return h(
    "span",
    { class: "label" },
    h("span", { class: "muted" }, COPY.developerMode),
    toggle(state.developerMode, (on) => run(async () => {
      await api.setDeveloperMode(on);
      state.developerMode = on;
      state.loadOpen = false;
      render();
    }), COPY.developerMode),
  );
}

function commonPrefix(values) {
  return values.reduce((prefix, value) => {
    let end = 0;
    while (end < prefix.length && prefix[end] === value[end]) end++;
    return prefix.slice(0, end);
  });
}

function loadField() {
  const input = h("input", {
    id: "load-path",
    type: "text",
    placeholder: COPY.loadPlaceholder,
    value: state.loadPath,
    autocomplete: "off",
    spellcheck: "false",
    class: "grow",
    oninput: () => {
      state.loadPath = input.value;
    },
    onkeydown: async (event) => {
      if (event.key === "Escape") {
        state.loadOpen = false;
        state.loadError = "";
        render();
      } else if (event.key === "Tab") {
        event.preventDefault();
        const typed = input.value;
        const completions = await api.completePath(typed).catch(() => []);
        if (completions.length === 0 || input.value !== typed) return;
        const completed = commonPrefix(completions);
        if (completed.length > typed.length) input.value = state.loadPath = completed;
      } else if (event.key === "Enter") {
        submitLoad(input.value);
      }
    },
  });
  setTimeout(() => {
    if (document.activeElement !== input) input.focus();
  }, 0);
  return h(
    "div",
    { class: "row" },
    input,
    h("button", { onclick: () => submitLoad(input.value) }, COPY.load),
    linkButton(COPY.cancel, () => {
      state.loadOpen = false;
      state.loadError = "";
      render();
    }, "quiet"),
  );
}

async function submitLoad(path) {
  if (!path.trim()) return;
  try {
    await api.loadUnpacked(path);
    state.loadOpen = false;
    state.loadPath = "";
    state.loadError = "";
  } catch (error) {
    state.loadError = error.message;
  }
  await load();
}

function developerBar() {
  return h(
    "div",
    null,
    h(
      "div",
      { class: "row" },
      h("button", { onclick: () => { state.loadOpen = true; render(); } }, COPY.loadUnpacked),
    ),
    state.loadOpen ? loadField() : null,
    state.loadError ? h("p", { class: "error" }, state.loadError) : null,
  );
}

function removeButton(extension, label = COPY.remove) {
  const confirming = state.confirming === extension.id;
  return linkButton(confirming ? COPY.confirmRemove : label, () => {
    if (!confirming) {
      state.confirming = extension.id;
      render();
      return;
    }
    state.confirming = null;
    run(async () => {
      await api.remove(extension.id);
      if (route === "details") location.href = "terminal-browser://extensions";
    });
  }, confirming ? "danger" : "quiet");
}

function extensionRow(extension) {
  const errors = extension.errors.length;
  return h(
    "li",
    { class: "row", "data-id": extension.id },
    icon(extension),
    h(
      "div",
      { class: "grow" },
      h(
        "div",
        { class: "clip" },
        h("span", null, extension.name),
        " ",
        h("span", { class: "muted" }, extension.version),
        errors ? [" ", h("a", { class: "badge", href: `terminal-browser://extensions/?id=${extension.id}` }, COPY.errors(errors))] : null,
      ),
      state.developerMode
        ? h("div", { class: "muted clip" }, extension.id, extension.source === "unpacked" ? `  ${extension.path}` : "")
        : null,
    ),
    h(
      "div",
      { class: "actions" },
      state.developerMode && extension.enabled ? linkButton(COPY.reload, () => run(() => api.reload(extension.id)), "quiet") : null,
      h("a", { href: `terminal-browser://extensions/?id=${extension.id}` }, COPY.details),
      removeButton(extension),
      toggle(extension.enabled, (on) => run(() => api.setEnabled(extension.id, on)), extension.name),
    ),
  );
}

function listView() {
  return [
    header(COPY.title, h("a", { href: "terminal-browser://extensions/shortcuts" }, COPY.shortcuts), developerToggle()),
    state.developerMode ? developerBar() : null,
    errorBanner(),
    state.loaded && state.extensions.length === 0
      ? h("p", { class: "empty" }, COPY.empty)
      : h("ul", { id: "extensions" }, state.extensions.map(extensionRow)),
  ];
}

function list(items, empty) {
  return items.length ? h("ul", null, items.map((item) => h("li", null, item))) : h("span", { class: "muted" }, empty);
}

function detailsView() {
  const extension = state.extensions.find((candidate) => candidate.id === detailsId);
  const back = h("a", { href: "terminal-browser://extensions" }, COPY.back);
  if (!extension) {
    return [h("p", null, back), state.loaded ? h("p", { class: "empty" }, COPY.notFound) : null];
  }
  const rows = [
    [COPY.description, extension.description || "—"],
    [COPY.version, extension.version],
    [COPY.size, bytes(extension.size)],
    [COPY.id, extension.id],
    [COPY.permissions, list(extension.warnings, COPY.noPermissions)],
    [COPY.siteAccess, list(extension.hosts, COPY.noSiteAccess)],
  ];
  if (extension.errors.length) {
    rows.push([
      COPY.errorsLabel,
      h("div", null, list(extension.errors.map((error) => h("span", { class: "error" }, error)), ""),
        linkButton(COPY.clear, () => run(() => api.clearErrors(extension.id)))),
    ]);
  }
  rows.push([COPY.pin, toggle(extension.pinned, (on) => run(() => api.setPinned(extension.id, on)), COPY.pin)]);
  if (extension.userScripts.requested) {
    rows.push([
      COPY.userScripts,
      toggle(extension.userScripts.allowed, (on) => run(() => api.setUserScriptsAllowed(extension.id, on)), COPY.userScripts),
    ]);
  }
  if (extension.optionsUrl && extension.enabled) {
    rows.push([COPY.options, linkButton(COPY.openOptions, () => run(() => api.openUrl(extension.optionsUrl)))]);
  }
  rows.push([COPY.source, h("span", null, COPY.unpacked, h("br"), h("span", { class: "muted" }, extension.path))]);
  rows.push(["", removeButton(extension, COPY.removeExtension)]);
  return [
    h("p", null, back),
    h(
      "header",
      null,
      icon(extension, 32),
      h("h1", null, extension.name),
      toggle(extension.enabled, (on) => run(() => api.setEnabled(extension.id, on)), COPY.enabled),
    ),
    errorBanner(),
    h("div", { class: "kv" }, rows.flatMap(([label, value]) => [h("div", null, label), h("div", null, value)])),
  ];
}

const KEY_NAMES = {
  ",": "Comma",
  ".": "Period",
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
  Delete: "Delete",
  MediaTrackNext: "MediaNextTrack",
  MediaTrackPrevious: "MediaPrevTrack",
  MediaPlayPause: "MediaPlayPause",
  MediaStop: "MediaStop",
};

function shortcutFrom(event) {
  let key = KEY_NAMES[event.key];
  if (!key && /^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  if (!key && /^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
  if (!key && /^F([1-9]|1[0-2])$/.test(event.key)) key = event.key;
  if (!key) return null;
  if (key.startsWith("Media")) return key;
  const parts = [];
  if (event.metaKey) parts.push(MAC ? "Command" : "Ctrl");
  if (event.ctrlKey) parts.push(MAC ? "MacCtrl" : "Ctrl");
  if (event.altKey) parts.push("Alt");
  if (!parts.length) return null;
  if (event.shiftKey) parts.push("Shift");
  return [...new Set(parts), key].join("+");
}

document.addEventListener("keydown", (event) => {
  const recording = state.recording;
  if (!recording) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") {
    state.recording = null;
    render();
    return;
  }
  const shortcut = event.key === "Backspace" ? "" : shortcutFrom(event);
  if (shortcut === null) return;
  state.recording = null;
  run(async () => {
    await api.setShortcut(recording.id, recording.command, shortcut);
    await load();
  });
}, true);

function shortcutsView() {
  const withCommands = state.extensions.filter((extension) => extension.commands.length);
  return [
    h("p", null, h("a", { href: "terminal-browser://extensions" }, COPY.back)),
    header(COPY.shortcuts),
    errorBanner(),
    state.loaded && withCommands.length === 0 ? h("p", { class: "empty" }, COPY.noCommands) : null,
    withCommands.map((extension) =>
      h(
        "section",
        null,
        h("h2", { class: "label" }, icon(extension, 16), extension.name),
        h(
          "ul",
          null,
          extension.commands.map((command) => {
            const recording = state.recording?.id === extension.id && state.recording.command === command.name;
            return h(
              "li",
              { class: "row" },
              h("span", { class: "grow clip" }, command.description),
              h("button", {
                class: recording ? "recording" : "",
                onclick: () => {
                  state.recording = recording ? null : { id: extension.id, command: command.name };
                  render();
                },
              }, recording ? COPY.pressKeys : command.shortcut || COPY.notSet),
            );
          }),
        ),
      ),
    ),
  ];
}

function render() {
  if (route === "details") mount(detailsView());
  else if (route === "shortcuts") mount(shortcutsView());
  else mount(listView());
}

live(load);
