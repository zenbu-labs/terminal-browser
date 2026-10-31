import { optionsPage } from "../manifest";
import { NativeMessaging } from "../native-messaging";
import type { ExtensionService } from "../service";

export function installRuntime(service: ExtensionService) {
  const { router } = service;
  const native = new NativeMessaging(service);

  router.handle("runtime.openOptionsPage", (caller) => {
    const page = optionsPage(caller.extension.manifest);
    const window = service.currentWindow(caller);
    if (!page || !window) throw new Error("Could not create an options page.");
    const url = caller.extension.url(page);
    const strip = (value: string) => value.replace(/#.*$/, "");
    const open = window.host.tabs.all().find((tab) => strip(tab.state.url || tab.url) === strip(url));
    if (open) window.host.tabs.activate(open.id);
    else window.host.tabs.create(url, true);
    window.host.activate();
  });

  router.handle("runtime.setUninstallURL", (caller, url) => {
    const value = String(url ?? "");
    if (value && !/^https?:$/.test(safeProtocol(value))) throw new Error(`Invalid URL: "${value}".`);
    service.manager.setUninstallUrl(caller.extension.id, value);
  });

  router.handle("runtime.requestUpdateCheck", () => ({ status: "no_update" }));

  router.handle("extension.isAllowedFileSchemeAccess", () => false);
  router.handle("extension.isAllowedIncognitoAccess", () => false);
  router.handle("extension.setUpdateUrlData", () => undefined);

  const permission = "nativeMessaging";
  router.handle("runtime.sendNativeMessage", (caller, name, message) => native.sendOnce(caller, name, message), { permission });
  router.handle("runtime.nativeConnect", (caller, portId, name) => native.connect(caller, portId, name), { permission });
  router.handle("runtime.nativePost", (caller, portId, message) => native.post(caller, portId, message), { permission });
  router.handle("runtime.nativeDisconnect", (caller, portId) => native.disconnect(caller, portId), { permission });
}

function safeProtocol(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return "";
  }
}
