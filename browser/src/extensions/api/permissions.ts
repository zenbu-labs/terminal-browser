import { updateExtension } from "shared";

import { extensionIcon } from "../action";
import type { LoadedExtension } from "../loaded";
import { optionalPermissions, parseMatchPattern, permissionWarnings, requiredPermissions } from "../manifest";
import type { MatchPattern } from "../manifest";
import { hasUserGesture } from "../router";
import type { Caller } from "../router";
import type { ExtensionService } from "../service";
import { frameForDocument } from "./web-navigation";

interface Permissions {
  permissions?: string[];
  origins?: string[];
}

function pathOf(source: string): string {
  return /^[^:]+:\/\/[^/]*(\/.*)?$/.exec(source)?.[1] ?? "/*";
}

// Whether every URL `inner` matches is also matched by `outer`.
export function patternCovers(outer: MatchPattern, inner: MatchPattern): boolean {
  if (inner.all) return outer.all;
  if (!inner.schemes.every((scheme) => outer.schemes.includes(scheme))) return false;
  if (outer.all) return true;
  if (outer.host !== "*") {
    if (inner.host === "*") return false;
    const sameHost = inner.host === outer.host;
    const subdomain = outer.subdomains && inner.host.endsWith(`.${outer.host}`);
    if (!sameHost && !subdomain) return false;
    if (inner.subdomains && !outer.subdomains) return false;
  }
  return outer.path.test(pathOf(inner.source));
}

function parseOrigins(origins: string[]): MatchPattern[] {
  return origins.map((origin) => {
    const parsed = parseMatchPattern(origin);
    if (!parsed) throw new Error(`Invalid value for origin pattern ${origin}: Invalid scheme.`);
    return parsed;
  });
}

function coveredBy(sources: string[], pattern: MatchPattern): boolean {
  return sources.some((source) => {
    const outer = parseMatchPattern(source);
    return outer !== null && patternCovers(outer, pattern);
  });
}

function contentScriptHosts(extension: LoadedExtension): string[] {
  return (extension.manifest.content_scripts ?? []).flatMap((script) => script.matches ?? []);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function installPermissions(service: ExtensionService) {
  const { router } = service;

  const read = (value: unknown) => {
    const request = (value ?? {}) as Permissions;
    const permissions = request.permissions ?? [];
    const origins = request.origins ?? [];
    return { permissions, origins, patterns: parseOrigins(origins) };
  };

  const save = async (extension: LoadedExtension, change: { grantedPermissions: string[]; grantedOrigins: string[] }) => {
    const record = updateExtension(extension.id, change);
    if (record) extension.record = record;
    await extension.refreshPermissions();
    service.changed();
  };

  router.handle("permissions.getAll", (caller) => {
    const extension = caller.extension;
    return { permissions: extension.apis, origins: unique([...extension.hosts, ...contentScriptHosts(extension)]) };
  });

  router.handle("permissions.contains", (caller, value) => {
    const extension = caller.extension;
    const { permissions, patterns } = read(value);
    const hosts = [...extension.hosts, ...contentScriptHosts(extension)];
    return permissions.every((permission) => extension.hasApiPermission(permission)) && patterns.every((pattern) => coveredBy(hosts, pattern));
  });

  router.handle("permissions.request", async (caller, value) => {
    if (!hasUserGesture(caller)) throw new Error("This function must be called during a user gesture");
    const extension = caller.extension;
    const { permissions, origins, patterns } = read(value);
    const required = requiredPermissions(extension.manifest);
    const optional = optionalPermissions(extension.manifest);
    const declaredApis = new Set([...required.api, ...optional.api]);
    const declaredHosts = [...required.hosts, ...optional.hosts];
    const unlisted = permissions.some((p) => !declaredApis.has(p)) || patterns.some((pattern) => !coveredBy(declaredHosts, pattern));
    if (unlisted) throw new Error("Only permissions specified in the manifest may be requested.");
    const newApis = permissions.filter((permission) => !extension.hasApiPermission(permission));
    const newOrigins = origins.filter((_origin, index) => !coveredBy(extension.hosts, patterns[index]));
    if (newApis.length === 0 && newOrigins.length === 0) return true;
    const warnings = permissionWarnings({ api: newApis, hosts: newOrigins });
    if (warnings.length > 0) {
      const window = service.currentWindow(caller);
      if (!window) throw new Error("Could not find an active window.");
      const accepted = await window.host.prompt({
        kind: "permissions",
        extensionId: extension.id,
        name: extension.name,
        icon: extensionIcon(extension, 48),
        warnings,
      });
      if (!accepted || !service.get(extension.id)) return false;
    }
    await save(extension, {
      grantedPermissions: unique([...extension.record.grantedPermissions, ...newApis]),
      grantedOrigins: unique([...extension.record.grantedOrigins, ...newOrigins]),
    });
    service.dispatch(extension.id, "permissions.onAdded", [{ permissions: newApis, origins: newOrigins }]);
    return true;
  });

  router.handle("permissions.remove", async (caller, value) => {
    const extension = caller.extension;
    const { permissions, patterns } = read(value);
    const required = requiredPermissions(extension.manifest);
    const optional = optionalPermissions(extension.manifest);
    const unlisted =
      permissions.some((p) => !required.api.includes(p) && !optional.api.includes(p)) ||
      patterns.some((pattern) => !coveredBy([...required.hosts, ...optional.hosts], pattern));
    if (unlisted) throw new Error("Only permissions specified in the manifest may be requested.");
    const touchesRequired = permissions.some((p) => required.api.includes(p)) || patterns.some((pattern) => coveredBy(required.hosts, pattern));
    if (touchesRequired) throw new Error("You cannot remove required permissions.");
    const removedApis = extension.record.grantedPermissions.filter((p) => permissions.includes(p));
    const removedOrigins = extension.record.grantedOrigins.filter((origin) => {
      const granted = parseMatchPattern(origin);
      return granted !== null && patterns.some((pattern) => patternCovers(pattern, granted));
    });
    if (removedApis.length === 0 && removedOrigins.length === 0) return true;
    await save(extension, {
      grantedPermissions: extension.record.grantedPermissions.filter((p) => !removedApis.includes(p)),
      grantedOrigins: extension.record.grantedOrigins.filter((origin) => !removedOrigins.includes(origin)),
    });
    service.dispatch(extension.id, "permissions.onRemoved", [{ permissions: removedApis, origins: removedOrigins }]);
    return true;
  });

  const hostAccessRequest = (caller: Caller, value: unknown, adding: boolean) => {
    const { tabId, documentId, pattern } = (value ?? {}) as { tabId?: number; documentId?: string; pattern?: string };
    if ((tabId === undefined) === (documentId === undefined)) throw new Error("Must specify either 'documentId' or 'tabId'.");
    let ref;
    if (documentId !== undefined) {
      const found = frameForDocument(service, documentId);
      ref = found ? service.tabRef(found.contents.id) : null;
      if (!ref) throw new Error(`No document with ID '${documentId}'.`);
    } else {
      ref = service.tabRef(tabId!);
      if (!ref) throw new Error(`No tab with ID '${tabId}'.`);
    }
    if (pattern !== undefined && !parseMatchPattern(pattern)) {
      throw new Error(
        adding
          ? "Extension cannot add a request with an invalid value for 'pattern'."
          : "Extension cannot remove a request with an invalid value for 'pattern'.",
      );
    }
    const extension = caller.extension;
    const declared = [...requiredPermissions(extension.manifest).hosts, ...optionalPermissions(extension.manifest).hosts];
    if (declared.length === 0) throw new Error("Extension cannot add a host access request when it does not have any host permissions.");
    if (!adding) throw new Error("Extension cannot remove a host access request that doesn't exist.");
    if (extension.hasHostAccess(ref.tab.state.url)) {
      throw new Error("Extension cannot add a host access request for a host it already has access to.");
    }
  };

  router.handle("permissions.addHostAccessRequest", (caller, value) => hostAccessRequest(caller, value, true));
  router.handle("permissions.removeHostAccessRequest", (caller, value) => hostAccessRequest(caller, value, false));
}
