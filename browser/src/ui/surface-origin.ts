import { getDomain } from "tldts";
import { displayUrl } from "../url";

// A web address split the way Chrome's location bar draws it: the registrable
// domain (example.co.uk in login.example.co.uk) is the part to emphasise.
export interface WebLocation {
  before: string;
  domain: string;
  after: string;
}

export type SurfaceHeading = { kind: "text"; text: string } | { kind: "web"; location: WebLocation };

export function webLocation(url: string, withPath: boolean): WebLocation | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname;
  const registrable = getDomain(host, { allowPrivateDomains: true });
  const domain = registrable && host.endsWith(`.${registrable}`) ? registrable : host;
  const rest = withPath ? `${parsed.pathname}${parsed.search}${parsed.hash}` : "";
  return {
    before: host.slice(0, host.length - domain.length),
    domain,
    after: `${parsed.port ? `:${parsed.port}` : ""}${rest === "/" ? "" : rest}`,
  };
}

function ownPage(url: string, extensionId: string): boolean {
  return url.startsWith(`chrome-extension://${extensionId}/`);
}

function blank(url: string): boolean {
  return url === "" || url === "about:blank";
}

// What the side panel header shows next to the extension's name: where the
// panel's page comes from, unless it is one of the extension's own pages.
export function sidePanelOrigin(url: string, extensionId: string): SurfaceHeading | null {
  if (ownPage(url, extensionId) || blank(url)) return null;
  const location = webLocation(url, false);
  return location ? { kind: "web", location } : { kind: "text", text: displayUrl(url) };
}

// A popup window's title bar: the address of a web page, otherwise the
// extension's name for its own pages in an auth popup, or the page's title.
export function popupWindowHeading(
  url: string,
  title: string,
  popup: { extensionId: string; extensionName: string; showsLocation: boolean },
): SurfaceHeading {
  const location = webLocation(url, true);
  if (location) return { kind: "web", location };
  if (ownPage(url, popup.extensionId)) return { kind: "text", text: popup.showsLocation ? popup.extensionName : title };
  if (blank(url) && !popup.showsLocation) return { kind: "text", text: title };
  return { kind: "text", text: displayUrl(url) };
}
