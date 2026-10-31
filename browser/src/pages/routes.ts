import { escape } from "./scheme";
import type { PageContext } from "./scheme";
import { pageHtml } from "./shell";
import { renderStartPage } from "./start";
import { renderVersionPage } from "./version";

const TITLES = {
  extensions: "Extensions",
  history: "History",
  downloads: "Downloads",
  bookmarks: "Bookmarks",
  settings: "Settings",
  urls: "terminal-browser URLs",
  notFound: "Not found",
};

export const INTERNAL_PAGE_LIST = [
  "bookmarks",
  "downloads",
  "extensions",
  "history",
  "newtab",
  "settings",
  "start",
  "terminal-browser-urls",
  "version",
];

const CLIENT_PAGES = {
  extensions: TITLES.extensions,
  history: TITLES.history,
  downloads: TITLES.downloads,
  bookmarks: TITLES.bookmarks,
  settings: TITLES.settings,
} as const;

export function routeInternalPage(url: URL, context: PageContext): Response | Promise<Response> {
  const host = url.host;
  if (host === "start" || host === "newtab") return renderStartPage(url, context);
  if (host === "version" || host === "about") return renderVersionPage(context);
  if (host === "terminal-browser-urls" || host === "chrome-urls") return renderUrlsPage(context);
  if (Object.prototype.hasOwnProperty.call(CLIENT_PAGES, host)) {
    const page = host as keyof typeof CLIENT_PAGES;
    return pageHtml({ title: CLIENT_PAGES[page], theme: context.theme, script: page });
  }
  return renderNotFound(url, context);
}

function renderUrlsPage(context: PageContext): Response {
  const rows = INTERNAL_PAGE_LIST.map((page) => {
    const href = `terminal-browser://${page}`;
    return `<li class="row"><a href="${escape(href)}">${escape(href)}</a></li>`;
  }).join("");
  return pageHtml({
    title: TITLES.urls,
    theme: context.theme,
    body: `<main><header><h1>${escape(TITLES.urls)}</h1></header><ul>${rows}</ul></main>`,
  });
}

function renderNotFound(url: URL, context: PageContext): Response {
  return pageHtml({
    title: TITLES.notFound,
    theme: context.theme,
    body: `<main><header><h1>${escape(url.href)}</h1></header>
<p class="muted">This page doesn't exist.</p>
<p><a href="terminal-browser://terminal-browser-urls">terminal-browser://terminal-browser-urls</a></p></main>`,
  });
}
