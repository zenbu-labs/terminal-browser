import { api, clock, dayLabel, dayStart, groupByDay, h, hostOf, linkButton, live, mount } from "./dom.js";

const COPY = {
  title: "History",
  search: "Search history",
  clear: "Clear browsing data",
  empty: "No history",
  noResults: "No results",
  remove: "Remove",
  more: "Show more",
};

const DAY_MS = 24 * 60 * 60 * 1000;

const state = { text: "", visits: [], more: false, loaded: false, limit: 1 };

let searchTimer = null;

async function load() {
  const visits = [];
  let before;
  let more = false;
  for (let page = 0; page < state.limit; page++) {
    const result = await api.list({ text: state.text, before });
    visits.push(...result.visits);
    more = result.more;
    if (!more) break;
    before = result.visits[result.visits.length - 1].time;
  }
  state.visits = visits;
  state.more = more;
  state.loaded = true;
  render();
}

function entries() {
  const seen = new Set();
  const unique = [];
  for (const visit of state.visits) {
    const key = `${dayStart(visit.time)} ${visit.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(visit);
  }
  return unique;
}

function entryRow(visit) {
  const start = dayStart(visit.time);
  return h(
    "li",
    { class: "row" },
    h("span", { class: "muted" }, clock(visit.time)),
    h(
      "a",
      {
        class: "grow clip",
        href: visit.url,
        title: visit.url,
        onclick: (event) => {
          event.preventDefault();
          api.open(visit.url, event.metaKey || event.ctrlKey);
        },
      },
      visit.title || visit.url,
    ),
    h("span", { class: "muted clip", style: "max-width: 220px" }, hostOf(visit.url)),
    linkButton(COPY.remove, () => api.remove(visit.url, start, start + DAY_MS), "quiet hover-only"),
  );
}

function render() {
  const groups = groupByDay(entries(), (visit) => visit.time);
  const search = h("input", {
    id: "search",
    type: "search",
    placeholder: COPY.search,
    value: state.text,
    oninput: (event) => {
      state.text = event.target.value;
      state.limit = 1;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(load, 150);
    },
  });
  mount(
    h("header", null, h("h1", null, COPY.title), search, h("a", { href: "terminal-browser://settings/clearBrowserData" }, COPY.clear)),
    state.loaded && groups.length === 0 ? h("p", { class: "empty" }, state.text ? COPY.noResults : COPY.empty) : null,
    groups.map((group) =>
      h("section", null, h("h2", null, dayLabel(group.start)), h("ul", null, group.items.map(entryRow))),
    ),
    state.more
      ? h("p", null, linkButton(COPY.more, () => {
          state.limit += 1;
          load();
        }))
      : null,
  );
}

live(load);
