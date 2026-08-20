import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type BrowserName = "brave" | "chrome" | "chromium";

export interface ExportedCookie {
  domain: string;
  expires: number;
  httpOnly: boolean;
  name: string;
  partitionKey?: { topLevelSite?: string };
  path: string;
  sameSite?: "Strict" | "Lax" | "None";
  secure: boolean;
  session: boolean;
  value: string;
}

interface BrowserSource {
  executable: string;
  profile: string;
  root: string;
}

interface ImportOptions {
  browserPath?: string;
  importCookies(file: string, partition: string, replace: boolean): Promise<ImportResult>;
  replace: boolean;
  sourceDir?: string;
  sourceProfile?: string;
  targetProfile: string;
}

export interface ProfileSourceOptions {
  browserPath?: string;
  sourceDir?: string;
  sourceProfile?: string;
}

export interface ImportResult {
  imported: number;
  skippedInvalid: number;
  skippedPartitioned: number;
  skippedSession: number;
}

export interface ProfileImportResult extends ImportResult {
  source: ResolvedProfileSource;
}

export interface ResolvedProfileSource {
  browser: BrowserName;
  browserPath: string;
  sourceDir: string;
  sourceProfile: string;
}

export interface DiscoveredBrowserProfile extends ResolvedProfileSource {
  browserPath: string;
  displayName: string;
  lastUsed: boolean;
}

interface DevToolsReply {
  error?: { message?: string };
  id?: number;
  result?: { cookies?: ExportedCookie[] };
}

const BROWSERS: BrowserName[] = ["brave", "chrome", "chromium"];

export function browserName(value: string): BrowserName {
  if (BROWSERS.includes(value as BrowserName)) return value as BrowserName;
  throw new Error(`unknown browser ${value} (brave, chrome, chromium)`);
}

export function profileName(value: string): string {
  if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) return value;
  throw new Error("profile names use letters, numbers, dots, dashes, or underscores");
}

export function namedProfileName(value: string): string {
  const name = profileName(value);
  if (name === "default") throw new Error("default is the built-in profile and cannot be a named profile");
  return name;
}

export async function importBrowserProfile(
  browser: BrowserName,
  options: ImportOptions,
): Promise<ProfileImportResult> {
  const source = resolveBrowserSource(browser, options);
  assertBrowserClosed(source.root);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-browser-import-"));
  fs.chmodSync(temporaryRoot, 0o700);
  let child: ReturnType<typeof spawn> | null = null;
  let cookieFile: string | null = null;
  try {
    cloneCookieStore(source, temporaryRoot);
    child = spawn(
      source.executable,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${temporaryRoot}`,
        `--profile-directory=${source.profile}`,
        "--no-first-run",
        "--disable-extensions",
        "about:blank",
      ],
      { detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"] },
    );
    const websocket = await devToolsSocket(temporaryRoot, child);
    const cookies = await exportCookies(websocket);
    await stopBrowser(child);
    child = null;
    if (cookies.length === 0) {
      throw new Error(`no importable cookies found in ${browser} profile ${source.profile}`);
    }
    cookieFile = path.join(temporaryRoot, "cookies.json");
    fs.writeFileSync(cookieFile, JSON.stringify(cookies), { mode: 0o600 });
    const result = await options.importCookies(cookieFile, options.targetProfile, options.replace);
    return {
      ...result,
      source: {
        browser,
        browserPath: source.executable,
        sourceDir: source.root,
        sourceProfile: source.profile,
      },
    };
  } finally {
    if (child) await stopBrowser(child);
    if (cookieFile) fs.rmSync(cookieFile, { force: true });
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

export function resolveProfileSource(
  browser: BrowserName,
  options: ProfileSourceOptions = {},
): ResolvedProfileSource {
  const source = resolveBrowserSource(browser, options);
  return {
    browser,
    browserPath: source.executable,
    sourceDir: source.root,
    sourceProfile: source.profile,
  };
}

export function discoverBrowserProfiles(): DiscoveredBrowserProfile[] {
  const profiles: DiscoveredBrowserProfile[] = [];
  for (const browser of BROWSERS) {
    const browserPath = browserExecutables(browser).find(executableExists);
    if (!browserPath) continue;
    for (const sourceDir of browserRoots(browser)) {
      const state = localState(sourceDir);
      if (!state) continue;
      const names = new Set(Object.keys(state.profile?.info_cache ?? {}));
      if (state.profile?.last_used) names.add(state.profile.last_used);
      for (const active of state.profile?.last_active_profiles ?? []) names.add(active);
      try {
        for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
          if (entry.isDirectory() && /^(Default|Profile \d+)$/.test(entry.name)) names.add(entry.name);
        }
      } catch {}
      for (const sourceProfile of names) {
        if (!cookieStore(path.join(sourceDir, sourceProfile))) continue;
        const lastUsed =
          state.profile?.last_used === sourceProfile ||
          state.profile?.last_active_profiles?.[0] === sourceProfile;
        profiles.push({
          browser,
          browserPath,
          displayName: state.profile?.info_cache?.[sourceProfile]?.name ?? sourceProfile,
          lastUsed,
          sourceDir,
          sourceProfile,
        });
      }
    }
  }
  return profiles.sort((a, b) =>
    a.browser === b.browser
      ? Number(b.lastUsed) - Number(a.lastUsed) || a.sourceProfile.localeCompare(b.sourceProfile)
      : a.browser.localeCompare(b.browser),
  );
}

function resolveBrowserSource(browser: BrowserName, options: ProfileSourceOptions): BrowserSource {
  const root = options.sourceDir
    ? path.resolve(options.sourceDir)
    : browserRoots(browser).find((candidate) => fs.existsSync(path.join(candidate, "Local State")));
  if (!root) throw new Error(`could not find a ${browser} profile; pass --source-dir <path>`);
  const profile = selectedProfile(root, options.sourceProfile);
  const executable = options.browserPath
    ? path.resolve(options.browserPath)
    : browserExecutables(browser).find(executableExists);
  if (!executable || !executableExists(executable)) {
    throw new Error(`could not find ${browser}; pass --browser-path <path>`);
  }
  return { executable, profile, root };
}

function selectedProfile(root: string, requested: string | undefined): string {
  let selected = requested;
  if (!selected) {
    const profile = localState(root)?.profile;
    selected = profile?.last_used ?? profile?.last_active_profiles?.[0];
  }
  selected ??= "Default";
  if (path.basename(selected) !== selected || selected === "." || selected === "..") {
    throw new Error(`invalid source profile ${selected}`);
  }
  const directory = path.join(root, selected);
  if (!cookieStore(directory)) throw new Error(`profile ${selected} has no cookie store`);
  return selected;
}

interface BrowserLocalState {
  profile?: {
    info_cache?: Record<string, { name?: string }>;
    last_active_profiles?: string[];
    last_used?: string;
  };
}

function localState(root: string): BrowserLocalState | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "Local State"), "utf8")) as BrowserLocalState;
  } catch {
    return null;
  }
}

function cloneCookieStore(source: BrowserSource, targetRoot: string): void {
  const sourceProfile = path.join(source.root, source.profile);
  const sourceCookies = cookieStore(sourceProfile)!;
  const relativeCookies = path.relative(sourceProfile, sourceCookies);
  const targetCookies = path.join(targetRoot, source.profile, relativeCookies);
  fs.mkdirSync(path.dirname(targetCookies), { recursive: true });
  fs.copyFileSync(sourceCookies, targetCookies);
  const journal = `${sourceCookies}-journal`;
  if (fs.existsSync(journal)) fs.copyFileSync(journal, `${targetCookies}-journal`);
  const localState = path.join(source.root, "Local State");
  if (fs.existsSync(localState)) fs.copyFileSync(localState, path.join(targetRoot, "Local State"));
}

function cookieStore(profile: string): string | null {
  for (const relative of ["Cookies", path.join("Network", "Cookies")]) {
    const candidate = path.join(profile, relative);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function assertBrowserClosed(root: string): void {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    if (pathExists(path.join(root, name))) {
      throw new Error(`close the source browser before importing (${name} is present)`);
    }
  }
}

async function stopBrowser(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  signalBrowser(child, "SIGTERM");
  const deadline = Date.now() + 2000;
  while (child.exitCode === null && Date.now() < deadline) await delay(50);
  if (child.exitCode !== null) return;
  signalBrowser(child, "SIGKILL");
  const killed = Date.now() + 1000;
  while (child.exitCode === null && Date.now() < killed) await delay(50);
}

function signalBrowser(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {}
}

function pathExists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

async function devToolsSocket(
  root: string,
  child: ReturnType<typeof spawn>,
): Promise<string> {
  const activePort = path.join(root, "DevToolsActivePort");
  let errors = "";
  let launchError: Error | null = null;
  child.once("error", (error) => {
    launchError = error;
  });
  child.stderr?.on("data", (chunk) => {
    errors = `${errors}${String(chunk)}`.slice(-4000);
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (fs.existsSync(activePort)) {
      const [port, endpoint] = fs.readFileSync(activePort, "utf8").trim().split(/\r?\n/);
      if (port && endpoint) return `ws://127.0.0.1:${port}${endpoint}`;
    }
    if (child.exitCode !== null) {
      throw new Error(
        `${path.basename(child.spawnfile)} exited before profile import${errors ? `: ${errors.trim()}` : ""}`,
      );
    }
    await delay(100);
  }
  throw new Error(`${path.basename(child.spawnfile)} did not enable profile import within 15s`);
}

function exportCookies(url: string): Promise<ExportedCookie[]> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("source browser did not return cookies within 15s"));
    }, 15_000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method: "Storage.getCookies" }));
    });
    socket.addEventListener("message", (event) => {
      const reply = JSON.parse(String(event.data)) as DevToolsReply;
      if (reply.id !== 1) return;
      clearTimeout(timer);
      if (reply.error) reject(new Error(reply.error.message ?? "source browser refused cookie export"));
      else {
        socket.send(JSON.stringify({ id: 2, method: "Browser.close" }));
        resolve(reply.result?.cookies ?? []);
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("could not connect to the source browser"));
    });
  });
}

function browserRoots(browser: BrowserName): string[] {
  const home = os.homedir();
  if (process.platform === "darwin") {
    const support = path.join(home, "Library", "Application Support");
    return {
      brave: [path.join(support, "BraveSoftware", "Brave-Browser")],
      chrome: [path.join(support, "Google", "Chrome")],
      chromium: [path.join(support, "Chromium")],
    }[browser];
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return {
      brave: [path.join(local, "BraveSoftware", "Brave-Browser", "User Data")],
      chrome: [path.join(local, "Google", "Chrome", "User Data")],
      chromium: [path.join(local, "Chromium", "User Data")],
    }[browser];
  }
  const config = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  return {
    brave: [
      path.join(config, "BraveSoftware", "Brave-Browser"),
      path.join(
        home,
        ".var",
        "app",
        "com.brave.Browser",
        "config",
        "BraveSoftware",
        "Brave-Browser",
      ),
    ],
    chrome: [
      path.join(config, "google-chrome"),
      path.join(home, ".var", "app", "com.google.Chrome", "config", "google-chrome"),
    ],
    chromium: [
      path.join(config, "chromium"),
      path.join(home, ".var", "app", "org.chromium.Chromium", "config", "chromium"),
    ],
  }[browser];
}

function browserExecutables(browser: BrowserName): string[] {
  if (process.platform === "darwin") {
    const applications = ["/Applications", path.join(os.homedir(), "Applications")];
    const relative = {
      brave: path.join("Brave Browser.app", "Contents", "MacOS", "Brave Browser"),
      chrome: path.join("Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      chromium: path.join("Chromium.app", "Contents", "MacOS", "Chromium"),
    }[browser];
    return applications.map((directory) => path.join(directory, relative));
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? "";
    const programs = process.env.PROGRAMFILES ?? "";
    const programsX86 = process.env["PROGRAMFILES(X86)"] ?? "";
    const roots = [local, programs, programsX86].filter(Boolean);
    const relative = {
      brave: path.join("BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      chrome: path.join("Google", "Chrome", "Application", "chrome.exe"),
      chromium: path.join("Chromium", "Application", "chrome.exe"),
    }[browser];
    return roots.map((directory) => path.join(directory, relative));
  }
  return {
    brave: pathCommands(["brave", "brave-browser"]),
    chrome: pathCommands(["google-chrome-stable", "google-chrome"]),
    chromium: pathCommands(["chromium", "chromium-browser"]),
  }[browser];
}

function pathCommands(names: string[]): string[] {
  const directories = (process.env.PATH ?? "").split(path.delimiter);
  return names.flatMap((name) => directories.map((directory) => path.join(directory, name)));
}

function executableExists(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
