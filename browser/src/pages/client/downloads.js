import { api, bytes, dayLabel, groupByDay, h, linkButton, live, mount } from "./dom.js";

const COPY = {
  title: "Downloads",
  search: "Search downloads",
  clearAll: "Clear all",
  empty: "No downloads",
  noResults: "No results",
  show: navigator.platform.includes("Mac") ? "Show in Finder" : "Show in folder",
  pause: "Pause",
  resume: "Resume",
  cancel: "Cancel",
  retry: "Retry",
  remove: "Remove",
  paused: "Paused",
  canceled: "Canceled",
  failed: "Failed",
  deleted: "Deleted",
  progress: (received, total) => (total > 0 ? `${bytes(received)} of ${bytes(total)}` : bytes(received)),
};

const state = { text: "", downloads: [], loaded: false };

async function load() {
  state.downloads = await api.list();
  state.loaded = true;
  render();
}

function basename(file) {
  return file.split(/[\\/]/).pop() || file;
}

function status(download) {
  if (download.state === "complete") return download.exists ? bytes(download.totalBytes) : COPY.deleted;
  if (download.state === "interrupted") return download.error === "USER_CANCELED" ? COPY.canceled : COPY.failed;
  const progress = COPY.progress(download.receivedBytes, download.totalBytes);
  return download.paused ? `${COPY.paused}, ${progress}` : progress;
}

function progressBar(download) {
  if (download.state !== "in_progress" || !(download.totalBytes > 0)) return null;
  const percent = Math.min(100, Math.round((download.receivedBytes / download.totalBytes) * 100));
  return h("div", { class: "bar" }, h("div", { style: `width: ${percent}%` }));
}

function actions(download) {
  const quiet = (label, action, extra = "") => linkButton(label, () => action().catch(() => {}), extra);
  if (download.state === "complete") {
    return download.exists ? [quiet(COPY.show, () => api.show(download.id))] : [];
  }
  if (download.state === "in_progress") {
    return [
      download.paused ? quiet(COPY.resume, () => api.resume(download.id)) : quiet(COPY.pause, () => api.pause(download.id)),
      quiet(COPY.cancel, () => api.cancel(download.id)),
    ];
  }
  return [
    download.canResume ? quiet(COPY.resume, () => api.resume(download.id)) : quiet(COPY.retry, () => api.openUrl(download.url)),
  ];
}

function downloadRow(download) {
  const finished = download.state === "complete" && download.exists;
  const name = basename(download.filename);
  return h(
    "li",
    { class: "row", "data-id": String(download.id) },
    h(
      "div",
      { class: "grow" },
      h(
        "div",
        { class: "clip" },
        finished
          ? h("a", { href: "#", onclick: (event) => { event.preventDefault(); api.open(download.id); } }, name)
          : h("span", { class: download.state === "interrupted" ? "muted" : "" }, name),
      ),
      h("div", { class: "muted clip", title: download.url }, download.url),
      h("div", { class: download.state === "interrupted" && download.error !== "USER_CANCELED" ? "error" : "muted" }, status(download)),
      progressBar(download),
    ),
    h("div", { class: "actions" }, actions(download), linkButton(COPY.remove, () => api.remove(download.id), "quiet hover-only")),
  );
}

function render() {
  const words = state.text.toLowerCase().split(/\s+/).filter(Boolean);
  const matched = state.downloads.filter((download) =>
    words.every((word) => `${download.filename} ${download.url}`.toLowerCase().includes(word)),
  );
  const groups = groupByDay(matched, (download) => download.startTime);
  mount(
    h(
      "header",
      null,
      h("h1", null, COPY.title),
      h("input", {
        id: "search",
        type: "search",
        placeholder: COPY.search,
        value: state.text,
        oninput: (event) => {
          state.text = event.target.value;
          render();
        },
      }),
      state.downloads.some((download) => download.state !== "in_progress") ? linkButton(COPY.clearAll, () => api.clear()) : null,
    ),
    state.loaded && groups.length === 0 ? h("p", { class: "empty" }, state.text ? COPY.noResults : COPY.empty) : null,
    groups.map((group) => h("section", null, h("h2", null, dayLabel(group.start)), h("ul", null, group.items.map(downloadRow)))),
  );
}

live(load);
