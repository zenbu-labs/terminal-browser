import { api, backLink, bytes, h, icon as glyph, linkButton, live, mount, toggle } from "./dom.js";

const COPY = {
  title: "Extensions",
  shortcuts: "Keyboard shortcuts",
  developerMode: "Developer mode",
  loadUnpacked: "Load unpacked",
  update: "Update",
  updating: "Updating…",
  updated: (count) => (count === 0 ? "Up to date" : `Updated ${count}`),
  loadPlaceholder: "~/path/to/extension",
  load: "Load",
  cancel: "Cancel",
  empty: "No extensions installed",
  details: "Details",
  remove: "Remove",
  confirmRemove: "Confirm",
  reload: "Reload",
  errors: (count) => (count === 1 ? "1 error" : `${count} errors`),
  back: "Extensions",
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
  collectErrors: "Collect errors",
  pin: "Pin to toolbar",
  userScripts: "Allow User Scripts",
  options: "Extension options",
  openOptions: "Open",
  source: "Source",
  webStore: "Chrome Web Store",
  unpacked: "Unpacked",
  path: "Path",
  removeExtension: "Remove extension",
  notFound: "This extension isn't installed",
  noCommands: "No extensions have keyboard shortcuts",
  notSet: "Not set",
  pressKeys: "Press a shortcut…",
  enabled: "On",
};

const IMPORT_COPY = {
  link: "Import",
  title: "Import extensions",
  searching: "Searching…",
  noBrowsers: "No browsers found",
  nothing: "Nothing to import",
  import: "Import",
  installing: "Installing…",
  cancel: "Cancel",
  done: "Done",
  alreadyInstalled: "Already installed",
  offIn: (browser) => `Off in ${browser}`,
  unpacked: "Unpacked",
  not_on_store: "Not on the Chrome Web Store",
  installed: "Installed",
  installedOff: "Installed, off",
  failed: "Couldn't install",
  skipped: "Skipped",
};

const state = {
  developerMode: false,
  extensions: [],
  loaded: false,
  loadOpen: false,
  loadError: "",
  loadPath: "",
  updateStatus: "",
  confirming: null,
  recording: null,
  error: "",
};

const route = location.pathname.startsWith("/shortcuts")
  ? "shortcuts"
  : location.pathname.startsWith("/import")
    ? "import"
    : new URLSearchParams(location.search).get("id")
      ? "details"
      : "list";
const detailsId = new URLSearchParams(location.search).get("id");
const MAC = navigator.platform.includes("Mac");
const UPDATE_RESULT_MS = 2000;

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
        closeLoad();
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
    { class: "popover" },
    h(
      "div",
      { class: "row" },
      input,
      h("button", { onclick: () => submitLoad(input.value) }, COPY.load),
      linkButton(COPY.cancel, closeLoad, "quiet"),
    ),
    state.loadError ? h("p", { class: "error" }, state.loadError) : null,
  );
}

function closeLoad() {
  state.loadOpen = false;
  state.loadError = "";
  render();
}

// Re-rendered after the click is handled, so the clicked control still gets it.
document.addEventListener("click", (event) => {
  if (state.loadOpen && !event.target.closest(".popover, #load-unpacked")) {
    state.loadOpen = false;
    state.loadError = "";
    setTimeout(render, 0);
  }
}, true);

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

function developerButtons() {
  if (!state.developerMode) return null;
  return [
    h("button", { id: "load-unpacked", onclick: () => { state.loadOpen = !state.loadOpen; state.loadError = ""; render(); } }, COPY.loadUnpacked),
    h("button", {
      class: "fixed-status",
      disabled: Boolean(state.updateStatus),
      onclick: () => run(async () => {
        state.updateStatus = COPY.updating;
        render();
        try {
          state.updateStatus = COPY.updated(await api.update());
          render();
          await new Promise((resolve) => setTimeout(resolve, UPDATE_RESULT_MS));
        } finally {
          state.updateStatus = "";
          render();
        }
      }),
    }, state.updateStatus || COPY.update),
  ];
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
  }, `fixed-remove ${confirming ? "danger" : "quiet"}`);
}

document.addEventListener("click", (event) => {
  if (state.confirming && !event.target.closest(".fixed-remove")) {
    state.confirming = null;
    setTimeout(render, 0);
  }
}, true);

function extensionRow(extension) {
  const errors = extension.errors.length;
  return h(
    "li",
    { class: "row", "data-id": extension.id },
    icon(extension),
    h(
      "div",
      { class: "grow clip" },
      h("span", null, extension.name),
      " ",
      h("span", { class: "muted" }, extension.version),
      errors ? [" ", h("a", { class: "badge", href: `terminal-browser://extensions/?id=${extension.id}` }, COPY.errors(errors))] : null,
    ),
    h(
      "div",
      { class: "actions" },
      linkButton(COPY.reload, () => run(() => api.reload(extension.id)), `quiet${state.developerMode && extension.enabled ? "" : " invisible"}`),
      h("a", { href: `terminal-browser://extensions/?id=${extension.id}` }, COPY.details),
      removeButton(extension),
      toggle(extension.enabled, (on) => run(() => api.setEnabled(extension.id, on)), extension.name),
    ),
  );
}

function listView() {
  return [
    header(
      COPY.title,
      developerButtons(),
      h("a", { href: "terminal-browser://extensions/import" }, IMPORT_COPY.link),
      h("a", { href: "terminal-browser://extensions/shortcuts" }, COPY.shortcuts),
      developerToggle(),
      state.developerMode && state.loadOpen ? loadField() : null,
    ),
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
  const back = backLink("terminal-browser://extensions", COPY.back);
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
  if (state.developerMode) {
    rows.push([
      COPY.collectErrors,
      toggle(extension.collectErrors, (on) => run(() => api.setErrorCollection(extension.id, on)), COPY.collectErrors),
    ]);
  }
  rows.push([COPY.pin, toggle(extension.pinned, (on) => run(() => api.setPinned(extension.id, on)), COPY.pin)]);
  if (extension.userScripts.requested) {
    rows.push([
      COPY.userScripts,
      toggle(extension.userScripts.allowed, (on) => run(() => api.setUserScriptsAllowed(extension.id, on)), COPY.userScripts),
    ]);
  }
  if (extension.optionsUrl) {
    const open = linkButton(COPY.openOptions, () => run(() => api.openUrl(extension.optionsUrl)));
    open.disabled = !extension.enabled;
    rows.push([COPY.options, open]);
  }
  rows.push([
    COPY.source,
    extension.source === "webstore"
      ? linkButton(COPY.webStore, () => run(() => api.openUrl(`https://chromewebstore.google.com/detail/${extension.id}`)))
      : h("span", null, COPY.unpacked, h("br"), h("span", { class: "muted" }, extension.path)),
  ]);
  rows.push(["", removeButton(extension, COPY.removeExtension)]);
  // Last, so errors that arrive while the page is open don't push anything down.
  if (extension.errors.length) {
    rows.push([
      COPY.errorsLabel,
      h("div", null, list(extension.errors.map((error) => h("span", { class: "error" }, error)), ""),
        linkButton(COPY.clear, () => run(() => api.clearErrors(extension.id)))),
    ]);
  }
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
    h("p", null, backLink("terminal-browser://extensions", COPY.back)),
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
                class: recording ? "fixed-shortcut recording" : "fixed-shortcut",
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

// pick → install → done. Install goes through the chosen rows one at a time;
// Cancel lets the current one finish and skips the rest.
const imports = {
  phase: "loading",
  browsers: [],
  browser: null,
  profile: null,
  selected: new Set(),
  progress: new Map(),
  stopping: false,
};

function currentBrowser() {
  return imports.browsers.find((candidate) => candidate.key === imports.browser) ?? null;
}

function currentProfile() {
  return currentBrowser()?.profiles.find((candidate) => candidate.key === imports.profile) ?? null;
}

// Profiles with nothing left to import are hidden.
function shownProfiles(browser) {
  return browser.profiles.filter((profile) => profile.items.some((item) => item.status === "ready"));
}

function chooseSource(browserKey, profileKey) {
  const browser = imports.browsers.find((candidate) => candidate.key === browserKey);
  if (!browser) return;
  const profiles = shownProfiles(browser);
  const profile = profiles.find((candidate) => candidate.key === profileKey) ?? profiles[0] ?? null;
  imports.browser = browser.key;
  imports.profile = profile?.key ?? null;
  imports.selected = new Set(profile ? profile.items.filter((item) => item.status === "ready").map((item) => item.id) : []);
}

async function loadImports() {
  try {
    imports.browsers = await api.importFind();
    const browser = imports.browsers.find((candidate) => shownProfiles(candidate).length > 0) ?? imports.browsers[0];
    if (browser) chooseSource(browser.key);
    imports.phase = "pick";
  } catch (error) {
    state.error = error.message;
  }
  render();
}

function chips(options, selected, onPick, least = 2) {
  if (options.length < least) return null;
  return h(
    "div",
    { class: "chips" },
    options.map((option) =>
      h("button", {
        "aria-pressed": option.key === selected ? "true" : "false",
        disabled: imports.phase !== "pick",
        onclick: () => onPick(option.key),
      }, option.name),
    ),
  );
}

function spinner() {
  const svg = glyph("loader-circle");
  svg.classList.add("spinner");
  return svg;
}

function progressStatus(item, progress) {
  if (progress.state === "failed") {
    const text = `${IMPORT_COPY.failed}: ${progress.error}`;
    return h("span", { class: "error clip import-status", title: text }, text);
  }
  if (progress.state === "installing") return h("span", { class: "muted import-status" }, spinner());
  if (progress.state === "queued") return h("span", { class: "muted import-status" });
  const text = progress.state === "installed" ? (item.enabled ? IMPORT_COPY.installed : IMPORT_COPY.installedOff) : IMPORT_COPY[progress.state];
  return h("span", { class: "muted clip import-status" }, text);
}

function itemStatus(item) {
  const progress = imports.progress.get(item.id);
  if (progress) return progressStatus(item, progress);
  let text = item.enabled ? "" : IMPORT_COPY.offIn(currentBrowser()?.name ?? "");
  if (item.status === "installed") text = IMPORT_COPY.alreadyInstalled;
  else if (item.status === "unavailable") text = IMPORT_COPY[item.reason];
  return h("span", { class: "muted clip import-status" }, text);
}

function itemRow(item) {
  const ready = item.status === "ready";
  return h(
    "li",
    { class: "item" },
    h(
      "label",
      { class: `row${ready ? "" : " unavailable"}` },
      h("input", {
        type: "checkbox",
        checked: ready && imports.selected.has(item.id),
        disabled: !ready || imports.phase !== "pick",
        onchange: (event) => {
          if (event.target.checked) imports.selected.add(item.id);
          else imports.selected.delete(item.id);
          render();
        },
      }),
      icon(item),
      h("span", { class: "grow clip" }, item.name),
      itemStatus(item),
    ),
  );
}

function importButton(count) {
  if (imports.phase === "done") {
    return h("button", { id: "import-start", class: "fixed-import", onclick: () => { location.href = "terminal-browser://extensions"; } }, IMPORT_COPY.done);
  }
  const installing = imports.phase === "install";
  return h("button", { id: "import-start", class: "fixed-import", disabled: installing || count === 0, onclick: startImport },
    installing ? IMPORT_COPY.installing : IMPORT_COPY.import);
}

// The page re-renders as each row finishes, which would drop a click whose press
// and release land on different renders, so Cancel acts on press.
function cancelButton() {
  return h("button", { class: "link quiet", onpointerdown: cancelImport, onclick: cancelImport }, IMPORT_COPY.cancel);
}

function importView() {
  const profile = currentProfile();
  const browser = currentBrowser();
  const count = profile ? profile.items.filter((item) => item.status === "ready" && imports.selected.has(item.id)).length : 0;
  return [
    h("p", null, backLink("terminal-browser://extensions", COPY.back)),
    header(
      IMPORT_COPY.title,
      imports.phase === "install" && !imports.stopping ? cancelButton() : null,
      importButton(count),
    ),
    errorBanner(),
    imports.phase === "loading" ? h("p", { class: "empty" }, IMPORT_COPY.searching) : null,
    imports.phase !== "loading" && imports.browsers.length === 0 ? h("p", { class: "empty" }, IMPORT_COPY.noBrowsers) : null,
    chips(imports.browsers, imports.browser, (key) => {
      chooseSource(key);
      render();
    }, 1),
    browser ? chips(shownProfiles(browser), imports.profile, (key) => {
      chooseSource(browser.key, key);
      render();
    }) : null,
    browser && !profile ? h("p", { class: "empty" }, IMPORT_COPY.nothing) : null,
    profile && profile.items.length ? h("ul", { id: "import-items" }, profile.items.map(itemRow)) : null,
  ];
}

async function startImport() {
  const profile = currentProfile();
  if (!profile) return;
  const chosen = profile.items.filter((item) => item.status === "ready" && imports.selected.has(item.id));
  imports.phase = "install";
  imports.stopping = false;
  imports.progress = new Map(chosen.map((item) => [item.id, { state: "queued", error: "" }]));
  render();
  for (const item of chosen) {
    if (imports.stopping) break;
    const progress = imports.progress.get(item.id);
    progress.state = "installing";
    render();
    try {
      await api.importInstall(item.id, item.enabled);
      progress.state = "installed";
    } catch (error) {
      progress.state = "failed";
      progress.error = error.message;
    }
    render();
  }
  imports.phase = "done";
  render();
}

function cancelImport() {
  imports.stopping = true;
  for (const progress of imports.progress.values()) {
    if (progress.state === "queued") progress.state = "skipped";
  }
  render();
}

function render() {
  if (route === "details") mount(detailsView());
  else if (route === "shortcuts") mount(shortcutsView());
  else if (route === "import") mount(importView());
  else mount(listView());
}

if (route === "import") {
  render();
  loadImports();
} else {
  live(load);
}
