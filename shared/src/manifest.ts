import path from "node:path";

import { parse as parseDomain } from "tldts";

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
  omnibox?: { keyword?: string };
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
}

export interface RequestedPermissions {
  api: string[];
  hosts: string[];
  // Content script matches: Chrome warns about them like hosts, but they
  // don't give API access to those sites.
  scriptableHosts?: string[];
}

// Permissions Chrome on macOS drops from a user-installed extension
// (_permission_features.json: ChromeOS only, or only for policy installs).
const UNAVAILABLE_PERMISSIONS = new Set([
  "audio",
  "certificateProvider",
  "documentScan",
  "enterprise.deviceAttributes",
  "enterprise.hardwarePlatform",
  "enterprise.kioskInput",
  "enterprise.login",
  "enterprise.networkingAttributes",
  "enterprise.platformKeys",
  "fileBrowserHandler",
  "fileSystemProvider",
  "login",
  "loginScreenStorage",
  "loginScreenUi",
  "loginState",
  "platformKeys",
  "printing",
  "printingMetrics",
  "vpnProvider",
  "wallpaper",
]);
const MV2_ONLY_PERMISSIONS = new Set(["webRequestBlocking"]);

function availableApi(manifest: Manifest, permission: string): boolean {
  if (isHostPattern(permission) || UNAVAILABLE_PERMISSIONS.has(permission)) return false;
  return manifest.manifest_version < 3 || !MV2_ONLY_PERMISSIONS.has(permission);
}

// Everything an install grants, like Chrome's PermissionsParser: some
// manifest keys add API permissions on top of the required ones.
export function grantedByInstall(manifest: Manifest): RequestedPermissions {
  const required = requiredPermissions(manifest);
  const implied = [
    ...(manifest.devtools_page ? ["devtools"] : []),
    ...(manifest.chrome_url_overrides?.newtab ? ["newTabPageOverride"] : []),
  ];
  return { ...required, api: [...new Set([...required.api, ...implied])] };
}

function contentScriptMatches(manifest: Manifest): string[] {
  const scripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  const matches = scripts.flatMap((script) =>
    Array.isArray(script?.matches) ? script.matches.filter((match): match is string => typeof match === "string") : [],
  );
  return [...new Set(matches)];
}

export function requiredPermissions(manifest: Manifest): RequestedPermissions {
  const raw = manifest.permissions ?? [];
  const hosts = manifest.manifest_version >= 3 ? [...(manifest.host_permissions ?? [])] : raw.filter(isHostPattern);
  return {
    api: raw.filter((p) => availableApi(manifest, p)),
    hosts: [...new Set(hosts)],
    scriptableHosts: contentScriptMatches(manifest),
  };
}

export function optionalPermissions(manifest: Manifest): RequestedPermissions {
  const raw = manifest.optional_permissions ?? [];
  const hosts =
    manifest.manifest_version >= 3 ? [...(manifest.optional_host_permissions ?? [])] : raw.filter(isHostPattern);
  return { api: raw.filter((p) => availableApi(manifest, p)), hosts };
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
  newTabPageOverride: "Replace the page you see when opening a new tab",
};

const FULL_URL_ACCESS_APIS = new Set(["debugger", "devtools", "pageCapture", "proxy", "tabCapture"]);

function effectivePatterns(requested: RequestedPermissions): MatchPattern[] {
  return [...requested.hosts, ...(requested.scriptableHosts ?? [])]
    .map(parseMatchPattern)
    .filter((pattern): pattern is MatchPattern => pattern !== null);
}

// Chrome's PermissiveGetHostRegistryLength, ignoring unknown and private registries.
function registryLength(host: string): number {
  const parsed = parseDomain(host, { allowPrivateDomains: false });
  return parsed.isIcann && parsed.domain && parsed.publicSuffix ? parsed.publicSuffix.length : 0;
}

function matchesAllUrls(pattern: MatchPattern): boolean {
  return pattern.all || (pattern.subdomains && pattern.host === "*");
}

// Chrome's URLPattern::MatchesEffectiveTld: <all_urls>, http://*/* or *.com.
function matchesEffectiveTld(pattern: MatchPattern): boolean {
  if (matchesAllUrls(pattern)) return true;
  if (!pattern.subdomains) return false;
  return registryLength(pattern.host) === 0 && registryLength(`notatld.${pattern.host}`) > 0;
}

function isFilePattern(pattern: MatchPattern): boolean {
  return !pattern.all && pattern.schemes.length === 1 && pattern.schemes[0] === "file";
}

function warnsAllHosts(requested: RequestedPermissions): boolean {
  return effectivePatterns(requested).some(matchesEffectiveTld) || requested.api.some((p) => FULL_URL_ACCESS_APIS.has(p));
}

function hasAccessToAllHosts(requested: RequestedPermissions): boolean {
  return effectivePatterns(requested).some(matchesAllUrls) || requested.api.some((p) => FULL_URL_ACCESS_APIS.has(p));
}

function displayHost(host: string): string {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return host;
  }
}

const PREFERRED_REGISTRIES = ["com", "net", "org"];

function betterRegistry(a: string, b: string): boolean {
  const rank = PREFERRED_REGISTRIES.indexOf(a);
  const other = PREFERRED_REGISTRIES.indexOf(b);
  return a !== b && rank !== -1 && (other === -1 || rank < other);
}

// Chrome's permission_message_util::GetDistinctHosts: example.com and
// example.de count as one site, shown with the best of their registries.
function distinctHosts(patterns: MatchPattern[], includeRegistry: boolean, excludeFiles: boolean): string[] {
  const seen: [string, string][] = [];
  for (const pattern of patterns) {
    if (excludeFiles && isFilePattern(pattern)) continue;
    const bare = pattern.host === "*" || isFilePattern(pattern) ? "" : displayHost(pattern.host);
    let host = pattern.subdomains ? `*.${bare}` : bare;
    let registry = "";
    const length = bare ? registryLength(bare) : 0;
    if (length > 0) {
      if (includeRegistry) registry = host.slice(host.length - length);
      host = host.slice(0, host.length - length);
    }
    const existing = seen.find(([name]) => name === host);
    if (!existing) seen.push([host, registry]);
    else if (includeRegistry && betterRegistry(registry, existing[1])) existing[1] = registry;
  }
  return [...new Set(seen.map(([host, registry]) => host + registry))].sort();
}

function hostWarning(requested: RequestedPermissions): string | null {
  const labels = distinctHosts(effectivePatterns(requested), true, true).map((host) =>
    host.startsWith("*.") ? `all ${host.slice(2)} sites` : host,
  );
  if (labels.length === 1) return `Read and change your data on ${labels[0]}`;
  if (labels.length === 2) return `Read and change your data on ${labels[0]} and ${labels[1]}`;
  if (labels.length === 3) return `Read and change your data on ${labels[0]}, ${labels[1]}, and ${labels[2]}`;
  if (labels.length > 3) return "Read and change your data on a number of websites";
  return null;
}

export function permissionWarnings(requested: RequestedPermissions): string[] {
  const warnings: string[] = [];
  const allHosts = warnsAllHosts(requested);
  const hosts = allHosts ? "Read and change all your data on all websites" : hostWarning(requested);
  if (hosts) warnings.push(hosts);
  for (const permission of requested.api) {
    const warning = API_WARNINGS[permission];
    if (!warning) continue;
    if (allHosts && warning === "Read your browsing history") continue;
    if (!warnings.includes(warning)) warnings.push(warning);
  }
  return warnings;
}

const HOSTS_ALL = "<hosts-all>";

// Chrome's IsAPIOrManifestPrivilegeIncrease: new API ids only count when they
// bring a warning the user hasn't seen.
function apiIncrease(granted: RequestedPermissions, requested: RequestedPermissions): boolean {
  const grantedIds = new Set([...granted.api, ...(warnsAllHosts(granted) ? [HOSTS_ALL] : [])]);
  const totalIds = new Set([...grantedIds, ...requested.api, ...(warnsAllHosts(requested) ? [HOSTS_ALL] : [])]);
  if ([...totalIds].every((id) => grantedIds.has(id))) return false;
  const messages = (ids: Set<string>) =>
    permissionWarnings({ api: [...ids].filter((id) => id !== HOSTS_ALL), hosts: ids.has(HOSTS_ALL) ? ["<all_urls>"] : [] });
  const seen = new Set(messages(grantedIds));
  return messages(totalIds).some((message) => !seen.has(message));
}

// Chrome's IsHostPrivilegeIncrease: moving from *.example.com to
// a.example.com is not an increase.
function hostIncrease(granted: RequestedPermissions, requested: RequestedPermissions): boolean {
  if (hasAccessToAllHosts(granted)) return false;
  if (hasAccessToAllHosts(requested)) return true;
  const grantedHosts = distinctHosts(effectivePatterns(granted), false, false);
  const newHosts = distinctHosts(effectivePatterns(requested), false, false).filter((host) => !grantedHosts.includes(host));
  return newHosts.some(
    (host) =>
      !grantedHosts.some((owned) => {
        if (owned.length <= 2 || !owned.startsWith("*.")) return false;
        const suffix = owned.slice(1);
        return host.endsWith(suffix) || host === suffix.slice(1);
      }),
  );
}

// Chrome's ChromePermissionMessageProvider::IsPrivilegeIncrease.
export function isPrivilegeIncrease(granted: RequestedPermissions, requested: RequestedPermissions): boolean {
  return hostIncrease(granted, requested) || apiIncrease(granted, requested);
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
