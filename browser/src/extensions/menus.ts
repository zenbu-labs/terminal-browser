import { extensionIcon } from "./action";
import type { LoadedExtension } from "./loaded";
import { PatternSet, parseMatchPattern } from "./manifest";
import type { Caller } from "./router";
import type { ExtensionService } from "./service";
import type { ExtensionWindow } from "./window";

export interface ExtensionMenuItem {
  key: string;
  extensionId: string;
  title: string;
  type: "normal" | "checkbox" | "radio" | "separator";
  checked: boolean;
  enabled: boolean;
  icon: string | null;
  children: ExtensionMenuItem[];
}

export type MenuContext = "page" | "action";

type MenuItemId = string | number;
type ItemType = ExtensionMenuItem["type"];

const CONTEXTS = [
  "all",
  "page",
  "frame",
  "selection",
  "link",
  "editable",
  "image",
  "video",
  "audio",
  "launcher",
  "browser_action",
  "page_action",
  "action",
  "tab",
] as const;
type ContextType = (typeof CONTEXTS)[number];

interface StoredItem {
  id: MenuItemId;
  extensionId: string;
  title: string;
  type: ItemType;
  checked: boolean;
  enabled: boolean;
  visible: boolean;
  contexts: Set<ContextType>;
  documentUrlPatterns: PatternSet | null;
  targetUrlPatterns: PatternSet | null;
  parent: StoredItem | null;
  children: StoredItem[];
}

interface MenuProperties {
  id?: string;
  generatedId?: number;
  type?: ItemType;
  title?: string;
  checked?: boolean;
  contexts?: string[];
  visible?: boolean;
  enabled?: boolean;
  parentId?: MenuItemId;
  documentUrlPatterns?: string[];
  targetUrlPatterns?: string[];
  onclick?: boolean;
}

export const ACTION_MENU_TOP_LEVEL_LIMIT = 6;
const MAX_ITEMS_PER_EXTENSION = 1000;
const MAX_TITLE_LENGTH = 75;
const MAX_SELECTION_LENGTH = 50;

function idString(id: MenuItemId): string {
  return String(id);
}

function itemKey(extensionId: string, id: MenuItemId): string {
  return `${extensionId}/${typeof id === "number" ? "n" : "s"}:${id}`;
}

function parseItemKey(key: string): { extensionId: string; id: MenuItemId } | null {
  const match = /^([a-p]{32})\/([ns]):(.*)$/s.exec(key);
  if (!match) return null;
  return { extensionId: match[1], id: match[2] === "n" ? Number(match[3]) : match[3] };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}

function patterns(sources: string[] | undefined): PatternSet | null {
  if (sources === undefined) return null;
  for (const source of sources) {
    if (!parseMatchPattern(source)) throw new Error(`Invalid url pattern '${source}'`);
  }
  return new PatternSet(sources);
}

function patternMatch(set: PatternSet | null, url: string): boolean {
  return !set || set.size === 0 || set.matches(url);
}

function contextsFrom(values: string[] | undefined): Set<ContextType> {
  const contexts = new Set<ContextType>();
  for (const value of values ?? ["page"]) {
    if (!(CONTEXTS as readonly string[]).includes(value)) throw new Error(`Invalid value for argument 1. Property 'contexts': Value must be one of ${CONTEXTS.join(", ")}.`);
    contexts.add(value as ContextType);
  }
  return contexts;
}

// Chrome's ExtensionContextAndPatternMatch + MenuItemMatchesParams.
function matchesParams(item: StoredItem, params: Electron.ContextMenuParams): boolean {
  const { contexts } = item;
  const hasLink = params.linkURL !== "";
  const hasSelection = params.selectionText !== "";
  const inSubframe = params.frame ? params.frame.parent !== null : params.frameURL !== "";
  let matched =
    contexts.has("all") ||
    (hasSelection && contexts.has("selection")) ||
    (params.isEditable && contexts.has("editable")) ||
    (inSubframe && contexts.has("frame"));
  if (!matched && hasLink && contexts.has("link") && patternMatch(item.targetUrlPatterns, params.linkURL)) matched = true;
  const media = params.mediaType;
  if (!matched && (media === "image" || media === "video" || media === "audio")) {
    matched = contexts.has(media) && patternMatch(item.targetUrlPatterns, params.srcURL);
  }
  const plainMedia = media === "none" || media === "canvas" || media === "file" || media === "plugin";
  if (!matched && !hasLink && !hasSelection && !params.isEditable && plainMedia && contexts.has("page")) matched = true;
  if (!matched) return false;
  return patternMatch(item.documentUrlPatterns, params.frameURL || params.pageURL);
}

function actionType(extension: LoadedExtension): ContextType {
  if (extension.manifest.action || extension.manifest.manifest_version >= 3) return "action";
  if (extension.manifest.browser_action) return "browser_action";
  return "page_action";
}

// chrome.contextMenus items, grouped per extension the way Chrome shows them.
export class MenuStore {
  private readonly menus = new Map<string, StoredItem[]>();
  private readonly byKey = new Map<string, StoredItem>();

  constructor(private readonly service: ExtensionService) {
    service.onUnload((id) => this.clear(id));
  }

  items(_window: ExtensionWindow, params: Electron.ContextMenuParams | null, context: MenuContext, extensionId?: string): ExtensionMenuItem[] {
    if (context === "action") {
      const extension = extensionId ? this.service.get(extensionId) : null;
      if (!extension) return [];
      return this.actionItems(extension);
    }
    if (!params) return [];
    const selection = truncate(params.selectionText, MAX_SELECTION_LENGTH);
    const groups: { title: string; item: ExtensionMenuItem }[] = [];
    for (const extension of this.service.loaded.values()) {
      if (extensionId && extension.id !== extensionId) continue;
      const relevant = (this.menus.get(extension.id) ?? []).filter((item) => matchesParams(item, params));
      if (relevant.length === 0) continue;
      const filter = (item: StoredItem) => matchesParams(item, params);
      const icon = extensionIcon(extension, 16);
      const grouped = relevant.length > 1 || relevant[0].type !== "normal";
      const children = this.render(grouped ? relevant : relevant[0].children.filter(filter), selection, filter);
      const single = relevant[0];
      if (!grouped && !single.visible) continue;
      if (grouped && !children.some((child) => child.type !== "separator")) continue;
      const item: ExtensionMenuItem = grouped
        ? { key: `${extension.id}/group`, extensionId: extension.id, title: extension.name, type: "normal", checked: false, enabled: true, icon, children }
        : { ...this.view(single, selection), icon, children };
      groups.push({ title: item.title, item });
    }
    return groups.sort((a, b) => a.title.localeCompare(b.title)).map((group) => group.item);
  }

  click(window: ExtensionWindow, key: string, params: Electron.ContextMenuParams | null) {
    const parsed = parseItemKey(key);
    const item = this.byKey.get(key);
    const extension = parsed ? this.service.get(parsed.extensionId) : null;
    if (!parsed || !item || !extension || !item.enabled) return;
    if (item.type === "radio") this.selectRadio(item);
    const info: Record<string, unknown> = { menuItemId: item.id };
    if (item.parent) info.parentMenuItemId = item.parent.id;
    if (params) {
      if (params.mediaType === "image" || params.mediaType === "video" || params.mediaType === "audio") info.mediaType = params.mediaType;
      if (params.linkURL) info.linkUrl = params.linkURL;
      if (params.srcURL) info.srcUrl = params.srcURL;
      if (params.pageURL) info.pageUrl = params.pageURL;
      if (params.frameURL) info.frameUrl = params.frameURL;
      if (params.selectionText) info.selectionText = params.selectionText;
      if (params.frame && !params.frame.isDestroyed()) info.frameId = params.frame.parent ? params.frame.frameTreeNodeId : 0;
    }
    info.editable = params?.isEditable ?? false;
    if (item.type === "checkbox" || item.type === "radio") {
      info.wasChecked = item.checked;
      item.checked = item.type === "radio" || !item.checked;
      info.checked = item.checked;
    }
    const tab = window.host.tabs.active;
    let tabInfo: chrome.tabs.Tab | Record<string, never> = {};
    if (tab && tab.contentsId !== null) {
      this.service.grantActiveTab(extension, tab);
      const shown = this.service.tabInfo(extension, { window, tab });
      // Chrome doesn't scrub the tab here: the user picked this extension on this page.
      tabInfo = { ...shown, url: tab.state.url, title: tab.state.title || tab.state.url };
    } else {
      extension.noteUserGesture();
    }
    this.service.dispatch(extension.id, "contextMenus.onclick", [info, tabInfo]);
    this.service.dispatch(extension.id, "contextMenus.onClicked", [info, tabInfo]);
    this.service.changed();
  }

  private actionItems(extension: LoadedExtension): ExtensionMenuItem[] {
    const type = actionType(extension);
    const filter = (item: StoredItem) => item.contexts.has("all") || item.contexts.has(type);
    const top = (this.menus.get(extension.id) ?? []).filter(filter);
    const rendered = this.render(top, "", filter);
    const limited: ExtensionMenuItem[] = [];
    let visible = 0;
    for (const item of rendered) {
      if (item.type !== "separator" && visible >= ACTION_MENU_TOP_LEVEL_LIMIT) break;
      if (item.type !== "separator") visible++;
      limited.push(item);
    }
    return limited;
  }

  private view(item: StoredItem, selection: string): ExtensionMenuItem {
    return {
      key: itemKey(item.extensionId, item.id),
      extensionId: item.extensionId,
      title: truncate(item.title.replaceAll("%s", selection), MAX_TITLE_LENGTH),
      type: item.type,
      checked: item.checked,
      enabled: item.enabled,
      icon: null,
      children: [],
    };
  }

  // Chrome's RecursivelyAppendExtensionItems: radio runs get separators around them.
  private render(items: StoredItem[], selection: string, filter: (item: StoredItem) => boolean): ExtensionMenuItem[] {
    const out: ExtensionMenuItem[] = [];
    let last: ItemType = "normal";
    let separators = 0;
    const separator = (extensionId: string): ExtensionMenuItem => ({
      key: `${extensionId}/separator-${separators++}`,
      extensionId,
      title: "",
      type: "separator",
      checked: false,
      enabled: true,
      icon: null,
      children: [],
    });
    items.forEach((item, index) => {
      if (last === "radio" && item.type !== "radio") {
        out.push(separator(item.extensionId));
        last = "separator";
      }
      if (item.type === "radio" && index > 0 && last !== "radio") out.push(separator(item.extensionId));
      last = item.type;
      if (!item.visible) return;
      const view = this.view(item, selection);
      if (item.type === "normal") view.children = this.render(item.children.filter(filter), selection, filter);
      out.push(view);
    });
    while (out[0]?.type === "separator") out.shift();
    while (out[out.length - 1]?.type === "separator") out.pop();
    return out.filter((item, index) => !(item.type === "separator" && out[index - 1]?.type === "separator"));
  }

  private clear(extensionId: string) {
    this.menus.delete(extensionId);
    for (const key of [...this.byKey.keys()]) {
      if (key.startsWith(`${extensionId}/`)) this.byKey.delete(key);
    }
  }

  private siblings(item: StoredItem): StoredItem[] {
    return item.parent ? item.parent.children : (this.menus.get(item.extensionId) ?? []);
  }

  private selectRadio(item: StoredItem) {
    const list = this.siblings(item);
    const at = list.indexOf(item);
    for (let i = at - 1; i >= 0 && list[i].type === "radio"; i--) list[i].checked = false;
    for (let i = at + 1; i < list.length && list[i].type === "radio"; i++) list[i].checked = false;
  }

  // Each run of adjacent radio items keeps exactly one checked item.
  private sanitizeRadios(list: StoredItem[]) {
    let i = 0;
    while (i < list.length) {
      if (list[i].type !== "radio") {
        i++;
        continue;
      }
      let lastChecked = -1;
      let j = i;
      for (; j < list.length && list[j].type === "radio"; j++) {
        if (list[j].checked) lastChecked = j;
        list[j].checked = false;
      }
      list[lastChecked >= 0 ? lastChecked : i].checked = true;
      i = j;
    }
  }

  private count(extensionId: string): number {
    let total = 0;
    const walk = (items: StoredItem[]) => {
      for (const item of items) {
        total++;
        walk(item.children);
      }
    };
    walk(this.menus.get(extensionId) ?? []);
    return total;
  }

  private find(extensionId: string, id: MenuItemId): StoredItem {
    const item = this.byKey.get(itemKey(extensionId, id));
    if (!item) throw new Error(`Cannot find menu item with id ${idString(id)}`);
    return item;
  }

  private parentFor(extensionId: string, parentId: MenuItemId): StoredItem {
    const parent = this.find(extensionId, parentId);
    if (parent.type !== "normal") throw new Error('Parent items must have type "normal"');
    return parent;
  }

  private create(caller: Caller, properties: MenuProperties) {
    const extension = caller.extension;
    const lazy = Boolean(extension.manifest.background?.service_worker) || extension.manifest.background?.persistent === false;
    let id: MenuItemId;
    if (properties.id !== undefined) {
      id = String(properties.id);
    } else {
      if (lazy) throw new Error("Extensions using event pages or Service Workers must pass an id parameter to chrome.contextMenus.create");
      if (typeof properties.generatedId !== "number") throw new Error("Invalid value for argument 1.");
      id = properties.generatedId;
    }
    if (this.count(extension.id) >= MAX_ITEMS_PER_EXTENSION) {
      throw new Error(`An extension can create a maximum of ${MAX_ITEMS_PER_EXTENSION} menu items.`);
    }
    if (this.byKey.has(itemKey(extension.id, id))) throw new Error(`Cannot create item with duplicate id ${idString(id)}`);
    if (lazy && properties.onclick) {
      throw new Error(
        "Extensions using event pages or Service Workers cannot pass an onclick parameter to chrome.contextMenus.create. Instead, use the chrome.contextMenus.onClicked event.",
      );
    }
    const contexts = contextsFrom(properties.contexts);
    if (contexts.has("launcher")) throw new Error("Only packaged apps are allowed to use 'launcher' context");
    const type = properties.type ?? "normal";
    const title = properties.title ?? "";
    if (!title && type !== "separator") throw new Error("All menu items except for separators must have a title");
    const item: StoredItem = {
      id,
      extensionId: extension.id,
      title,
      type,
      checked: properties.checked ?? false,
      enabled: properties.enabled ?? true,
      visible: properties.visible ?? true,
      contexts,
      documentUrlPatterns: patterns(properties.documentUrlPatterns),
      targetUrlPatterns: patterns(properties.targetUrlPatterns),
      parent: null,
      children: [],
    };
    if (properties.parentId !== undefined) {
      const parent = this.parentFor(extension.id, properties.parentId);
      item.parent = parent;
      parent.children.push(item);
      if (item.type === "radio") this.sanitizeRadios(parent.children);
    } else {
      const top = this.menus.get(extension.id) ?? [];
      this.menus.set(extension.id, top);
      top.push(item);
      if (item.type === "radio") {
        if (item.checked) this.selectRadio(item);
        else this.sanitizeRadios(top);
      }
    }
    this.byKey.set(itemKey(extension.id, id), item);
    this.service.changed();
  }

  private isDescendant(item: StoredItem, ancestor: StoredItem): boolean {
    for (let at = item.parent; at; at = at.parent) if (at === ancestor) return true;
    return false;
  }

  private update(caller: Caller, id: MenuItemId, properties: MenuProperties) {
    const extensionId = caller.extension.id;
    const item = this.find(extensionId, id);
    let radioChanged = false;
    if (properties.type && properties.type !== item.type) {
      radioChanged = properties.type === "radio" || item.type === "radio";
      item.type = properties.type;
    }
    if (properties.title !== undefined) {
      if (!properties.title && item.type !== "separator") throw new Error("All menu items except for separators must have a title");
      item.title = properties.title;
    }
    if (properties.checked !== undefined) {
      if (properties.checked && item.type !== "checkbox" && item.type !== "radio") {
        throw new Error('Only items with type "radio" or "checkbox" can be checked');
      }
      if ((item.type === "radio" && properties.checked) || item.type === "checkbox") {
        item.checked = properties.checked;
        radioChanged = true;
      }
    }
    if (properties.visible !== undefined) item.visible = properties.visible;
    if (properties.enabled !== undefined) item.enabled = properties.enabled;
    if (properties.contexts !== undefined) {
      const contexts = contextsFrom(properties.contexts);
      if (contexts.has("launcher")) throw new Error("Only packaged apps are allowed to use 'launcher' context");
      item.contexts = contexts;
    }
    if (properties.parentId !== undefined) {
      const parent = this.parentFor(extensionId, properties.parentId);
      if (parent === item || this.isDescendant(parent, item)) throw new Error("Cannot update menu item.");
      const from = this.siblings(item);
      from.splice(from.indexOf(item), 1);
      this.sanitizeRadios(from);
      item.parent = parent;
      parent.children.push(item);
      this.sanitizeRadios(parent.children);
      radioChanged = false;
    }
    if (properties.documentUrlPatterns !== undefined) item.documentUrlPatterns = patterns(properties.documentUrlPatterns);
    if (properties.targetUrlPatterns !== undefined) item.targetUrlPatterns = patterns(properties.targetUrlPatterns);
    if (radioChanged && item.type === "radio" && item.checked) this.selectRadio(item);
    this.service.changed();
  }

  private remove(caller: Caller, id: MenuItemId) {
    const item = this.find(caller.extension.id, id);
    const list = this.siblings(item);
    list.splice(list.indexOf(item), 1);
    this.sanitizeRadios(list);
    const drop = (removed: StoredItem) => {
      this.byKey.delete(itemKey(removed.extensionId, removed.id));
      removed.children.forEach(drop);
    };
    drop(item);
    this.service.changed();
  }

  install(service: ExtensionService) {
    const { router } = service;
    const permission = "contextMenus";
    const asId = (value: unknown): MenuItemId => {
      if (typeof value === "number" && Number.isInteger(value)) return value;
      if (typeof value === "string") return value;
      throw new Error("Invalid value for argument 1. Value must be one of: [integer, string].");
    };
    router.handle("contextMenus.create", (caller, properties) => this.create(caller, (properties ?? {}) as MenuProperties), { permission });
    router.handle("contextMenus.update", (caller, id, properties) => this.update(caller, asId(id), (properties ?? {}) as MenuProperties), {
      permission,
    });
    router.handle("contextMenus.remove", (caller, id) => this.remove(caller, asId(id)), { permission });
    router.handle(
      "contextMenus.removeAll",
      (caller) => {
        this.clear(caller.extension.id);
        service.changed();
      },
      { permission },
    );
  }
}
