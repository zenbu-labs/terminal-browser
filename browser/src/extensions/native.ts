import type { Session, WebContents } from "electron";

export interface NativePermissions {
  permissions: string[];
  origins: string[];
}

// Added to Session.extensions by pixel's Electron patches; they update the permissions Chromium itself
// checks in scripting, tabs.sendMessage, webRequest, declarativeNetRequest and userScripts.
interface PatchedExtensions {
  grantActiveTab(extensionId: string, contents: WebContents): boolean;
  revokeActiveTab(extensionId: string, contents: WebContents): void;
  setRuntimePermissions(extensionId: string, granted: NativePermissions): Promise<void>;
  getActivePermissions(extensionId: string): NativePermissions | null;
  setUserScriptsAllowed(extensionId: string, allowed: boolean): boolean;
}

function patched(session: Session): PatchedExtensions {
  return session.extensions as unknown as PatchedExtensions;
}

export function grantNativeActiveTab(session: Session, extensionId: string, contents: WebContents): boolean {
  if (contents.isDestroyed()) return false;
  return patched(session).grantActiveTab(extensionId, contents);
}

export function revokeNativeActiveTab(session: Session, extensionId: string, contents: WebContents) {
  if (contents.isDestroyed()) return;
  patched(session).revokeActiveTab(extensionId, contents);
}

export async function setNativeRuntimePermissions(session: Session, extensionId: string, granted: NativePermissions) {
  await patched(session).setRuntimePermissions(extensionId, granted);
}

export function nativeActivePermissions(session: Session, extensionId: string): NativePermissions | null {
  return patched(session).getActivePermissions(extensionId);
}

export function setNativeUserScriptsAllowed(session: Session, extensionId: string, allowed: boolean): boolean {
  return patched(session).setUserScriptsAllowed(extensionId, allowed);
}
