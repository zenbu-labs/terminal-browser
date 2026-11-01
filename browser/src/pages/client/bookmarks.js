import { api, h, hostOf, linkButton, live, mount } from "./dom.js";

const COPY = {
  title: "Bookmarks",
  addPage: "Add page",
  addFolder: "Add folder",
  name: "Name",
  url: "URL",
  save: "Save",
  cancel: "Cancel",
  remove: "Remove",
  empty: "No bookmarks",
  newFolder: "New folder",
};

const state = { roots: [], current: null, adding: null, error: "", loaded: false };

async function load() {
  const data = await api.tree();
  state.roots = data.roots;
  state.current = data.current;
  state.loaded = true;
  render();
}

function folders(nodes, depth = 0) {
  return nodes.flatMap((node) =>
    node.url === undefined ? [{ id: node.id, title: `${"  ".repeat(depth)}${node.title}` }, ...folders(node.children ?? [], depth + 1)] : [],
  );
}

function startAdding(kind) {
  state.adding = {
    kind,
    title: kind === "page" ? (state.current?.title ?? "") : COPY.newFolder,
    url: kind === "page" ? (state.current?.url ?? "") : "",
    parentId: state.roots[0]?.id ?? "1",
  };
  state.error = "";
  render();
}

async function save() {
  const adding = state.adding;
  try {
    if (adding.kind === "page") await api.add({ parentId: adding.parentId, title: adding.title, url: adding.url });
    else await api.addFolder({ parentId: adding.parentId, title: adding.title });
    state.adding = null;
    state.error = "";
  } catch (error) {
    state.error = error.message;
  }
  render();
}

function form() {
  const adding = state.adding;
  const field = (id, key, placeholder) =>
    h("input", {
      id,
      type: "text",
      class: "grow",
      placeholder,
      value: adding[key],
      oninput: (event) => {
        adding[key] = event.target.value;
      },
      onkeydown: (event) => {
        if (event.key === "Enter") save();
        if (event.key === "Escape") {
          state.adding = null;
          render();
        }
      },
    });
  setTimeout(() => {
    if (!document.activeElement?.closest(".popover")) document.getElementById("bookmark-title")?.focus();
  }, 0);
  return h(
    "div",
    { class: "popover" },
    h(
      "div",
      { class: "row" },
      field("bookmark-title", "title", COPY.name),
      adding.kind === "page" ? field("bookmark-url", "url", COPY.url) : null,
      h(
        "select",
        { onchange: (event) => { adding.parentId = event.target.value; } },
        folders(state.roots).map((folder) => h("option", { value: folder.id, selected: folder.id === adding.parentId }, folder.title)),
      ),
      h("button", { onclick: save }, COPY.save),
      linkButton(COPY.cancel, () => {
        state.adding = null;
        render();
      }, "quiet"),
    ),
    state.error ? h("p", { class: "error" }, state.error) : null,
  );
}

function nodeRow(node) {
  const remove = linkButton(COPY.remove, () => api.remove(node.id), "quiet hover-only");
  if (node.url === undefined) {
    return [
      h("li", { class: "row" }, h("span", { class: "grow clip" }, node.title), remove),
      node.children?.length ? h("li", null, h("ul", { style: "padding-left: 20px" }, node.children.flatMap(nodeRow))) : null,
    ];
  }
  return h(
    "li",
    { class: "row" },
    h(
      "a",
      {
        class: "grow clip",
        href: node.url,
        title: node.url,
        onclick: (event) => {
          event.preventDefault();
          api.open(node.url, event.metaKey || event.ctrlKey);
        },
      },
      node.title || node.url,
    ),
    h("span", { class: "muted clip", style: "max-width: 220px" }, hostOf(node.url)),
    remove,
  );
}

function render() {
  mount(
    h(
      "header",
      null,
      h("h1", null, COPY.title),
      h("button", { class: "opens-form", onclick: () => startAdding("page") }, COPY.addPage),
      h("button", { class: "opens-form", onclick: () => startAdding("folder") }, COPY.addFolder),
      state.adding ? form() : null,
    ),
    state.roots.map((root) =>
      h(
        "section",
        null,
        h("h2", null, root.title),
        root.children?.length ? h("ul", null, root.children.flatMap(nodeRow)) : h("p", { class: "empty" }, COPY.empty),
      ),
    ),
  );
}

// Re-rendered after the click is handled, so the clicked control still gets it.
document.addEventListener("click", (event) => {
  if (state.adding && !event.target.closest(".popover, .opens-form")) {
    state.adding = null;
    setTimeout(render, 0);
  }
}, true);

live(load);
