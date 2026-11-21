import { PAIRED_ENV } from "../terminal/stream";

export { attach } from "./attach";
export type { AttachError, AttachOptions, Attached, Attachment, PairTerminal } from "./attach";
export { host } from "./host";
export type { HostLaunch, HostOptions, Hosted, Started } from "./host";
export { PROTOCOL, trace, type ProtocolRange } from "./wire";

export function paired(env: NodeJS.ProcessEnv = process.env): { meta: unknown } | null {
  if (!env[PAIRED_ENV]) return null;
  try {
    return JSON.parse(env[PAIRED_ENV]) as { meta: unknown };
  } catch {
    return null;
  }
}
