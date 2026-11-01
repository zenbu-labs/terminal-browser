import fs from "node:fs";
import path from "node:path";

import { app } from "electron";
import type { WebContents } from "electron";


import { browsing } from "../../browsing";
import { writeImageData } from "../action";
import type { LoadedExtension } from "../loaded";
import { pickIcon, resolveExtensionPath } from "../manifest";
import type { ExtensionService } from "../service";
import { urlFilterMatches } from "../url-filter";
import type { UrlFilter } from "../url-filter";
import type { TabRef } from "../window";

const MATCHER = "declarativeContent.PageStateMatcher";
const SHOW_ACTIONS = new Set(["declarativeContent.ShowAction", "declarativeContent.ShowPageAction"]);
const SET_ICON = "declarativeContent.SetIcon";
const CONTENT_SCRIPT = "declarativeContent.RequestContentScript";
const ACTIONS = new Set([...SHOW_ACTIONS, SET_ICON, CONTENT_SCRIPT]);
const DEFAULT_PRIORITY = 100;
const CSS_WORLD = 1014;
const ICON_PX = 32;

type Bitmap = { width: number; height: number; data: Uint8Array };

interface Condition {
  instanceType: string;
  pageUrl?: UrlFilter;
  css?: string[];
  isBookmarked?: boolean;
}

interface Action {
  instanceType: string;
  imageData?: Bitmap | Record<string, Bitmap>;
  path?: string | Record<string, string>;
  css?: string[];
  js?: string[];
  allFrames?: boolean;
  matchAboutBlank?: boolean;
}

export interface ContentRule {
  id: string;
  priority: number;
  conditions: Condition[];
  actions: Action[];
  tags?: string[];
}

interface PageState {
  css: Set<string>;
  watching: string;
  generation: number;
  injected: Set<string>;
}

function rulesDir(): string {
  const dir = path.join(app.getPath("userData"), "extension-content-rules");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Chrome keeps an extension's rules across restarts, until it's uninstalled.
function rulesFile(extensionId: string): string {
  return path.join(rulesDir(), `${extensionId}.json`);
}

function checkRule(raw: unknown, extension: LoadedExtension): Omit<ContentRule, "id" | "priority"> & { id?: unknown; priority?: unknown } {
  const rule = (raw ?? {}) as Record<string, unknown>;
  // fixme: placeholder copy
  if (!Array.isArray(rule.conditions) || !Array.isArray(rule.actions)) throw new Error("Invalid rule.");
  for (const condition of rule.conditions as Condition[]) {
    // fixme: placeholder copy
    if (condition?.instanceType !== MATCHER) throw new Error(`A condition has an invalid instanceType: ${condition?.instanceType}`);
    if (condition.isBookmarked !== undefined && !extension.hasApiPermission("bookmarks")) {
      throw new Error("Property 'isBookmarked' requires 'bookmarks' permission.");
    }
  }
  for (const action of rule.actions as Action[]) {
    // fixme: placeholder copy
    if (!ACTIONS.has(action?.instanceType)) throw new Error(`An action has an invalid instanceType: ${action?.instanceType}`);
  }
  return rule as unknown as ContentRule;
}

// chrome.declarativeContent: rules that show an extension's action (or change its
// icon, or add content scripts) while a page matches.
export class DeclarativeContentStore {
  private readonly rules = new Map<string, ContentRule[]>();
  private readonly pages = new Map<number, PageState>();
  private nextRuleId = 0;

  constructor(private readonly service: ExtensionService) {
    service.onUnload((id) => {
      this.rules.delete(id);
      service.actions.clearDeclarative(id);
    });
    service.onUninstall((id) => fs.rmSync(rulesFile(id), { force: true }));
    service.onActivate(() => {
      service.onTabContents((contents) => this.watch(contents));
      browsing().bookmarks.any.add(() => this.evaluateAll());
    });
  }

  private load(extensionId: string): ContentRule[] {
    let rules = this.rules.get(extensionId);
    if (!rules) {
      try {
        rules = JSON.parse(fs.readFileSync(rulesFile(extensionId), "utf8")) as ContentRule[];
      } catch {
        rules = [];
      }
      this.rules.set(extensionId, rules);
    }
    return rules;
  }

  private save(extensionId: string, rules: ContentRule[]) {
    this.rules.set(extensionId, rules);
    if (rules.length === 0) fs.rmSync(rulesFile(extensionId), { force: true });
    else fs.writeFileSync(rulesFile(extensionId), JSON.stringify(rules));
    this.evaluateAll();
  }

  add(extension: LoadedExtension, raw: unknown): ContentRule[] {
    // fixme: placeholder copy
    if (!Array.isArray(raw)) throw new Error("Invalid rule.");
    const existing = this.load(extension.id);
    const added: ContentRule[] = [];
    for (const entry of raw) {
      const rule = checkRule(entry, extension);
      const id = typeof rule.id === "string" && rule.id ? rule.id : `_${this.nextRuleId++}_`;
      if ([...existing, ...added].some((other) => other.id === id)) throw new Error(`Duplicate rule ID: ${id}`);
      added.push({
        id,
        priority: typeof rule.priority === "number" ? rule.priority : DEFAULT_PRIORITY,
        conditions: rule.conditions,
        actions: rule.actions.map((action) => this.prepareAction(extension, action)),
        ...(Array.isArray(rule.tags) && rule.tags.length > 0 ? { tags: rule.tags } : {}),
      });
    }
    this.save(extension.id, [...existing, ...added]);
    return added;
  }

  get(extension: LoadedExtension, ids: unknown): ContentRule[] {
    const rules = this.load(extension.id);
    return Array.isArray(ids) ? rules.filter((rule) => ids.includes(rule.id)) : rules;
  }

  remove(extension: LoadedExtension, ids: unknown) {
    const rules = this.load(extension.id);
    this.save(extension.id, Array.isArray(ids) ? rules.filter((rule) => !ids.includes(rule.id)) : []);
  }

  private prepareAction(extension: LoadedExtension, action: Action): Action {
    if (action.instanceType !== SET_ICON) return action;
    const { imageData, path: iconPath } = action;
    let icon: string | null = null;
    if (imageData) {
      const bitmaps = "data" in imageData ? [imageData as Bitmap] : Object.values(imageData as Record<string, Bitmap>);
      const largest = bitmaps.sort((a, b) => b.width - a.width)[0];
      if (largest) icon = writeImageData(extension.id, { ...largest, data: new Uint8Array(largest.data) });
    } else if (iconPath) {
      const picked = pickIcon(iconPath, ICON_PX);
      icon = picked ? resolveExtensionPath(extension.path, picked.replace(extension.baseUrl, "")) : null;
    }
    if (!icon) throw new Error("Icon invalid.");
    return { instanceType: SET_ICON, path: icon };
  }

  private page(contentsId: number): PageState {
    let page = this.pages.get(contentsId);
    if (!page) {
      page = { css: new Set(), watching: "", generation: 0, injected: new Set() };
      this.pages.set(contentsId, page);
    }
    return page;
  }

  private watch(contents: WebContents) {
    contents.on("did-navigate", () => {
      const page = this.page(contents.id);
      page.css.clear();
      page.injected.clear();
      page.watching = "";
      page.generation++;
      this.evaluateTab(contents.id);
    });
    contents.on("dom-ready", () => this.watchCss(contents));
    contents.once("destroyed", () => this.pages.delete(contents.id));
    this.evaluateTab(contents.id);
  }

  private selectors(): string[] {
    const all = new Set<string>();
    for (const extensionId of this.service.loaded.keys()) {
      for (const rule of this.load(extensionId)) for (const condition of rule.conditions) for (const css of condition.css ?? []) all.add(css);
    }
    return [...all].sort();
  }

  // Keeps a watcher in the page that answers once the set of matching selectors changes.
  private watchCss(contents: WebContents) {
    const selectors = this.selectors();
    const page = this.page(contents.id);
    const key = selectors.join("\n");
    if (selectors.length === 0 || page.watching === key || contents.isDestroyed()) return;
    page.watching = key;
    const generation = ++page.generation;
    const loop = (known: string[]) => {
      const code = `new Promise((resolve) => {
        const selectors = ${JSON.stringify(selectors)};
        const known = ${JSON.stringify(known.join("\n"))};
        const check = () => selectors.filter((s) => { try { return !!document.querySelector(s); } catch { return false; } });
        const first = check();
        if (first.join("\\n") !== known) return resolve(first);
        let timer = 0;
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            const now = check();
            if (now.join("\\n") === known) return;
            observer.disconnect();
            resolve(now);
          }, 100);
        });
        observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      })`;
      contents
        .executeJavaScriptInIsolatedWorld(CSS_WORLD, [{ code }])
        .then((found: unknown) => {
          if (page.generation !== generation || !Array.isArray(found)) return;
          page.css = new Set(found as string[]);
          this.evaluateTab(contents.id);
          loop(found as string[]);
        })
        .catch(() => {
          if (page.generation === generation) page.watching = "";
        });
    };
    loop([]);
  }

  private conditionMatches(condition: Condition, url: string, page: PageState): boolean {
    if (condition.pageUrl && !urlFilterMatches(condition.pageUrl, url)) return false;
    if (condition.css && !condition.css.every((selector) => page.css.has(selector))) return false;
    if (condition.isBookmarked !== undefined) {
      const bookmarked = browsing().bookmarks.search({ url }).length > 0;
      if (bookmarked !== condition.isBookmarked) return false;
    }
    return true;
  }

  private evaluateAll() {
    for (const { tab } of this.service.allTabs()) if (tab.contentsId !== null) this.evaluateTab(tab.contentsId);
    for (const { tab } of this.service.allTabs()) {
      const contents = this.service.contentsOf(tab);
      if (contents) this.watchCss(contents);
    }
  }

  private evaluateTab(contentsId: number) {
    const ref = this.service.tabRef(contentsId);
    if (!ref) return;
    const url = ref.tab.state.url;
    const page = this.page(contentsId);
    for (const extension of this.service.loaded.values()) {
      const rules = this.load(extension.id);
      const matching = rules.filter((rule) => rule.conditions.some((condition) => this.conditionMatches(condition, url, page)));
      const shown = matching.some((rule) => rule.actions.some((action) => SHOW_ACTIONS.has(action.instanceType)));
      const icon = [...matching]
        .sort((a, b) => b.priority - a.priority)
        .flatMap((rule) => rule.actions)
        .find((action) => action.instanceType === SET_ICON)?.path as string | undefined;
      this.service.actions.setDeclarative(extension.id, contentsId, shown || icon ? { shown, icon: icon ?? null } : null);
      for (const rule of matching) this.requestContentScripts(extension, ref, rule, page);
    }
  }

  // The extension's own worker injects the files, so they run in its content script world.
  private requestContentScripts(extension: LoadedExtension, ref: TabRef, rule: ContentRule, page: PageState) {
    if (page.injected.has(`${extension.id}:${rule.id}`)) return;
    const scripts = rule.actions.filter((action) => action.instanceType === CONTENT_SCRIPT);
    if (scripts.length === 0 || !extension.hasHostAccess(ref.tab.state.url)) return;
    page.injected.add(`${extension.id}:${rule.id}`);
    for (const script of scripts) {
      this.service.dispatch(extension.id, "declarativeContent.inject", [
        ref.tab.contentsId,
        { js: script.js ?? [], css: script.css ?? [], allFrames: script.allFrames === true, matchAboutBlank: script.matchAboutBlank === true },
      ]);
    }
  }
}

export function installDeclarativeContent(service: ExtensionService) {
  const { router, declarativeContent } = service;
  const options = { permission: "declarativeContent" };
  router.handle("declarativeContent.addRules", (caller, rules) => declarativeContent.add(caller.extension, rules), options);
  router.handle("declarativeContent.getRules", (caller, ids) => declarativeContent.get(caller.extension, ids), options);
  router.handle("declarativeContent.removeRules", (caller, ids) => declarativeContent.remove(caller.extension, ids), options);
}
