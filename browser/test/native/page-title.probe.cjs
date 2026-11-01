// A tab's title belongs to its document: after navigating to a page without a <title>, pixel's page state (which
// the tab strip and the tabs API read) holds no title, not the previous page's; back/forward brings the old one back.
const { PageHost } = require("../../../pixel/packages/pixel/dist/web/host.js");

const surface = () => new Proxy({}, { get: () => () => {} });

require("./harness.cjs").run("page-title", async ({ port, eq, check, sleep }) => {
  const states = [];
  const host = new PageHost(
    surface(),
    surface(),
    { x: 0, y: 0, width: 800, height: 600, scale: 1 },
    { url: "about:blank", background: "#fff", clipboardRead: false, proxy: null, browserWindowOptions: {} },
    (state) => states.push({ url: state.url, title: state.title }),
  );
  const contents = host.webContents;
  const settled = () => new Promise((resolve) => contents.once("did-stop-loading", resolve));
  const page = (body) => `data:text/html,${encodeURIComponent(body)}`;
  const titled = page("<!doctype html><title>Inbox (3) - alice@corp.example</title>");
  const untitled = `http://127.0.0.1:${port}/untitled`;

  let loaded = settled();
  host.navigate(titled);
  await loaded;
  await sleep(300);
  eq(states.at(-1), { url: titled, title: "Inbox (3) - alice@corp.example" }, "the titled page");

  loaded = settled();
  host.navigate(untitled);
  await loaded;
  await sleep(300);
  eq(states.at(-1), { url: untitled, title: "" }, "a page without a title");
  check(
    !states.some((state) => state.url === untitled && state.title.includes("alice")),
    `no state paired the new page with the old title: ${JSON.stringify(states)}`,
  );

  loaded = settled();
  contents.navigationHistory.goBack();
  await loaded;
  await sleep(300);
  eq(states.at(-1), { url: titled, title: "Inbox (3) - alice@corp.example" }, "back to the titled page");
  host.stop?.();
});
