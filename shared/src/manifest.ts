import path from "node:path";

export interface ManifestIcons {
  [size: string]: string;
}

export interface ManifestAction {
  default_icon?: string | ManifestIcons;
  default_title?: string;
  default_popup?: string;
}

export interface ManifestCommand {
  suggested_key?: string | Record<string, string>;
  description?: string;
  global?: boolean;
}

export interface Manifest {
  manifest_version: number;
  name: string;
  short_name?: string;
  version: string;
  version_name?: string;
  description?: string;
  default_locale?: string;
  key?: string;
  icons?: ManifestIcons;
  action?: ManifestAction;
  browser_action?: ManifestAction;
  page_action?: ManifestAction;
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  background?: { service_worker?: string; scripts?: string[]; page?: string; persistent?: boolean; type?: string };
  content_scripts?: { matches?: string[] }[];
  options_page?: string;
  options_ui?: { page?: string; open_in_tab?: boolean };
  side_panel?: { default_path?: string };
  chrome_url_overrides?: { newtab?: string; history?: string; bookmarks?: string };
  commands?: Record<string, ManifestCommand>;
  devtools_page?: string;
  homepage_url?: string;
  update_url?: string;
  incognito?: string;
}

export function asManifest(raw: unknown): Manifest {
  return raw as Manifest;
}

export function manifestAction(manifest: Manifest): ManifestAction | null {
  return manifest.action ?? manifest.browser_action ?? manifest.page_action ?? null;
}

export function optionsPage(manifest: Manifest): string | null {
  return manifest.options_ui?.page ?? manifest.options_page ?? null;
}

const SCHEMES = ["http", "https", "file", "ftp", "ws", "wss", "urn", "chrome-extension"];

export function isHostPattern(value: string): boolean {
  if (value === "<all_urls>") return true;
  const scheme = value.split("://")[0];
  return value.includes("://") && (scheme === "*" || SCHEMES.includes(scheme));
}

export interface MatchPattern {
  all: boolean;
  schemes: string[];
  host: string;
  subdomains: boolean;
  path: RegExp;
  source: string;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function parseMatchPattern(source: string): MatchPattern | null {
  if (source === "<all_urls>") {
    return { all: true, schemes: ["http", "https", "file", "ftp", "ws", "wss", "urn"], host: "*", subdomains: true, path: /.*/, source };
  }
  const match = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/.exec(source);
  if (!match) return null;
  const [, scheme, rawHost, rawPath] = match;
  if (scheme !== "*" && !SCHEMES.includes(scheme)) return null;
  if (scheme !== "file" && !rawHost) return null;
  const host = rawHost.split(":")[0].toLowerCase();
  if (host.includes("*") && host !== "*" && !host.startsWith("*.")) return null;
  if (host.slice(2).includes("*")) return null;
  const subdomains = host === "*" || host.startsWith("*.");
  return {
    all: false,
    schemes: scheme === "*" ? ["http", "https", "ws", "wss"] : [scheme],
    host: host === "*" ? "*" : host.replace(/^\*\./, ""),
    subdomains,
    path: globToRegExp(rawPath ?? "/*"),
    source,
  };
}

export function patternMatches(pattern: MatchPattern, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const scheme = parsed.protocol.slice(0, -1);
  if (!pattern.schemes.includes(scheme)) return false;
  if (scheme !== "file" && pattern.host !== "*") {
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const exact = host === pattern.host;
    const sub = pattern.subdomains && host.endsWith(`.${pattern.host}`);
    if (!exact && !sub) return false;
  }
  return pattern.path.test(`${parsed.pathname}${parsed.search}`);
}

export class PatternSet {
  private readonly patterns: MatchPattern[];

  constructor(sources: Iterable<string>) {
    this.patterns = [...sources].map(parseMatchPattern).filter((p): p is MatchPattern => p !== null);
  }

  matches(url: string): boolean {
    return this.patterns.some((pattern) => patternMatches(pattern, url));
  }

  get size(): number {
    return this.patterns.length;
  }

  get sources(): string[] {
    return this.patterns.map((pattern) => pattern.source);
  }

  coversAllHosts(): boolean {
    return this.patterns.some((p) => p.all || (p.host === "*" && p.schemes.includes("https")));
  }
}

export interface RequestedPermissions {
  api: string[];
  hosts: string[];
}

export function requiredPermissions(manifest: Manifest): RequestedPermissions {
  const raw = manifest.permissions ?? [];
  const hosts = manifest.manifest_version >= 3 ? [...(manifest.host_permissions ?? [])] : raw.filter(isHostPattern);
  return {
    api: raw.filter((p) => !isHostPattern(p)),
    hosts: [...new Set(hosts)],
  };
}

export function optionalPermissions(manifest: Manifest): RequestedPermissions {
  const raw = manifest.optional_permissions ?? [];
  const hosts =
    manifest.manifest_version >= 3 ? [...(manifest.optional_host_permissions ?? [])] : raw.filter(isHostPattern);
  return { api: raw.filter((p) => !isHostPattern(p)), hosts };
}

// Chrome's own wording for install prompts (chrome/app/generated_resources.grd).
const API_WARNINGS: Record<string, string> = {
  bookmarks: "Read and change your bookmarks",
  clipboardRead: "Read data you copy and paste",
  clipboardWrite: "Modify data you copy and paste",
  contentSettings: "Change your settings that control websites' access to features such as cookies, JavaScript, and camera",
  debugger: "Access the page debugger backend",
  declarativeNetRequest: "Block content on any page",
  declarativeNetRequestFeedback: "Read your browsing history",
  desktopCapture: "Capture content of your screen",
  downloads: "Manage your downloads",
  "downloads.open": "Open downloaded files",
  favicon: "Read the icons of the websites you visit",
  geolocation: "Detect your physical location",
  history: "Read and change your browsing history",
  "identity.email": "Know your email address",
  management: "Manage your apps, extensions, and themes",
  nativeMessaging: "Communicate with cooperating native applications",
  notifications: "Display notifications",
  pageCapture: "Read and change all your data on all websites",
  privacy: "Change your privacy-related settings",
  proxy: "Read and change all your data on all websites",
  readingList: "Read and change entries in the reading list",
  sessions: "Read your browsing history",
  tabCapture: "Read and change all your data on all websites",
  tabs: "Read your browsing history",
  topSites: "Read a list of your most frequently visited websites",
  webNavigation: "Read your browsing history",
  "system.storage": "Identify and eject storage devices",
  ttsEngine: "Read all text spoken using synthesized speech",
};

export function hostLabel(pattern: string): string | null {
  const parsed = parseMatchPattern(pattern);
  if (!parsed) return null;
  if (parsed.all || parsed.host === "*") return null;
  return parsed.subdomains ? `all ${parsed.host} sites` : parsed.host;
}

export function permissionWarnings(requested: RequestedPermissions): string[] {
  const warnings: string[] = [];
  const hosts = new PatternSet(requested.hosts);
  const allHosts = hosts.coversAllHosts() || requested.api.some((p) => ["debugger", "pageCapture", "proxy", "tabCapture"].includes(p));
  if (allHosts) {
    warnings.push("Read and change all your data on all websites");
  } else if (requested.hosts.length > 0) {
    const labels = [...new Set(requested.hosts.map(hostLabel).filter((l): l is string => l !== null))];
    if (labels.length === 1) warnings.push(`Read and change your data on ${labels[0]}`);
    else if (labels.length === 2) warnings.push(`Read and change your data on ${labels[0]} and ${labels[1]}`);
    else if (labels.length === 3) warnings.push(`Read and change your data on ${labels[0]}, ${labels[1]}, and ${labels[2]}`);
    else if (labels.length > 3) warnings.push("Read and change your data on a number of websites");
  }
  for (const permission of requested.api) {
    const warning = API_WARNINGS[permission];
    if (!warning) continue;
    if (allHosts && warning === "Read and change all your data on all websites") continue;
    if (allHosts && warning === "Read your browsing history") continue;
    if (!warnings.includes(warning)) warnings.push(warning);
  }
  return warnings;
}

export function resolveExtensionPath(root: string, relative: string): string | null {
  const resolved = path.resolve(root, relative.replace(/^\//, ""));
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

export function pickIcon(icons: string | ManifestIcons | undefined, size: number): string | null {
  if (!icons) return null;
  if (typeof icons === "string") return icons;
  const sizes = Object.keys(icons)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (sizes.length === 0) return null;
  const best = sizes.find((n) => n >= size) ?? sizes[sizes.length - 1];
  return icons[String(best)] ?? null;
}
