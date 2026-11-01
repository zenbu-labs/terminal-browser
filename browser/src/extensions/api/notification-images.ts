import { net } from "electron";
import type { Session } from "electron";

export const IMAGE_LIMITS = { bytes: 8 * 1024 * 1024, timeoutMs: 15_000, redirects: 5 };

export interface ImageRequester {
  origin: string;
  hasHostAccess(url: string): boolean;
}

function corsAllows(headers: Record<string, string | string[]>, origin: string): boolean {
  const value = headers["access-control-allow-origin"];
  const allowed = Array.isArray(value) ? value[0] : value;
  return allowed === "*" || allowed === origin;
}

const isWeb = (url: string) => /^https?:\/\//i.test(url);

// Chrome loads notification images from the extension's own context: no
// cookies, and another site's image only with host access or that site's CORS consent.
export function fetchNotificationImage(session: Session, url: string, requester: ImageRequester): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let current = url;
    let hops = 0;
    let settled = false;
    const request = net.request({ session, url, method: "GET", credentials: "omit", redirect: "manual", origin: requester.origin });
    const finish = (result: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!result) request.abort();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), IMAGE_LIMITS.timeoutMs);
    const readable = (headers: Record<string, string | string[]>) => requester.hasHostAccess(current) || corsAllows(headers, requester.origin);

    request.on("redirect", (_status, _method, next, headers) => {
      if (++hops > IMAGE_LIMITS.redirects || !isWeb(next) || !readable(headers)) return finish(null);
      current = next;
      request.followRedirect();
    });
    request.on("response", (response) => {
      const declared = Number(response.headers["content-length"] ?? 0);
      if (response.statusCode < 200 || response.statusCode > 299 || !readable(response.headers) || declared > IMAGE_LIMITS.bytes) {
        return finish(null);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > IMAGE_LIMITS.bytes) return finish(null);
        chunks.push(chunk);
      });
      response.on("end", () => finish(Buffer.concat(chunks)));
      response.on("error", () => finish(null));
    });
    request.on("error", () => finish(null));
    request.end();
  });
}
