export const RELAUNCH_FD_ENV = "PIXEL_RELAUNCH_FD";
export const RELAUNCH_FD = 3;

export interface RelaunchRequest {
  args: string[];
  env?: Record<string, string>;
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

export function parseRelaunchRequest(text: string): RelaunchRequest | null {
  let parsed: { args?: unknown; env?: unknown };
  try {
    parsed = JSON.parse(text) as { args?: unknown; env?: unknown };
  } catch {
    return null;
  }
  if (!strings(parsed.args)) return null;
  const env = parsed.env ?? {};
  if (typeof env !== "object" || env === null || !strings(Object.values(env))) return null;
  return { args: parsed.args, env: env as Record<string, string> };
}
