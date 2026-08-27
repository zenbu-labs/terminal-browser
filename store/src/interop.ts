import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

const HOME = os.homedir();

function interopRoot(kind: "state" | "share"): string {
  const override = process.env.TERMINAL_BROWSER_INTEROP_DIR;
  if (override && path.isAbsolute(override)) return override;
  return path.join(HOME, ".local", kind, "terminal-browser-interop");
}

export const INTEROP_INSTANCES_DIR = path.join(interopRoot("state"), "instances");
export const INTEROP_APPS_DIR = path.join(interopRoot("share"), "apps");

export const INTEROP_PROTOCOL_VERSIONS = [1];

export const openSpecSchema = z
  .object({
    url: z.string().optional(),
    app: z
      .object({
        id: z.string().min(1),
        name: z.string().optional(),
        partition: z.string().optional(),
        preload: z.string().optional(),
        mainScript: z.string().optional(),
      })
      .optional(),
  })
  .refine((spec) => !spec.app || spec.url !== undefined);
export type OpenSpec = z.infer<typeof openSpecSchema>;

export interface OpenResult {
  tab: number;
}

export const interopInstanceSchema = z.object({
  protocolVersions: z.array(z.number()),
  mode: z.enum(["browser", "app"]).catch("browser"),
  pid: z.number(),
  socket: z.string(),
  startedAt: z.number().catch(0),
});
export type InteropInstance = z.infer<typeof interopInstanceSchema>;

export function instanceKey(record: InteropInstance): string {
  return path.basename(record.socket, ".sock");
}

function instanceFile(key: string): string {
  return path.join(INTEROP_INSTANCES_DIR, `${key.replace(/[^\w-]/g, "_")}.json`);
}

export function advertiseInstance(key: string, record: InteropInstance): void {
  try {
    fs.mkdirSync(INTEROP_INSTANCES_DIR, { recursive: true });
    fs.writeFileSync(instanceFile(key), `${JSON.stringify(record)}\n`);
  } catch {}
}

export function withdrawInstance(key: string): void {
  try {
    fs.rmSync(instanceFile(key), { force: true });
  } catch {}
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export function listInteropInstances(): InteropInstance[] {
  let names: string[];
  try {
    names = fs.readdirSync(INTEROP_INSTANCES_DIR);
  } catch {
    return [];
  }
  const records: InteropInstance[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(INTEROP_INSTANCES_DIR, name);
    const parsed = interopInstanceSchema.safeParse(readJson(file));
    if (!parsed.success) continue;
    if (!alive(parsed.data.pid) || !fs.existsSync(parsed.data.socket)) {
      fs.rmSync(file, { force: true });
      continue;
    }
    records.push(parsed.data);
  }
  return records.sort((a, b) => b.startedAt - a.startedAt);
}

const APP_MANIFEST_VERSION = 1;

export const registeredAppSchema = z.object({
  version: z.number(),
  id: z.string(),
  name: z.string(),
  bin: z.string(),
  args: z.array(z.string()).catch([]),
  registeredAt: z.number().catch(0),
});
export type RegisteredApp = z.infer<typeof registeredAppSchema>;

function appFile(id: string): string {
  return path.join(INTEROP_APPS_DIR, `${id}.json`);
}

export function appId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "app";
}

export function registerApp(app: Omit<RegisteredApp, "version" | "registeredAt">): void {
  fs.mkdirSync(INTEROP_APPS_DIR, { recursive: true });
  fs.writeFileSync(
    appFile(app.id),
    `${JSON.stringify({ version: APP_MANIFEST_VERSION, registeredAt: Date.now(), ...app }, null, 2)}\n`,
  );
}

export function unregisterApp(id: string): boolean {
  const file = appFile(id);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

export function listApps(): RegisteredApp[] {
  let names: string[];
  try {
    names = fs.readdirSync(INTEROP_APPS_DIR);
  } catch {
    return [];
  }
  const apps: RegisteredApp[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const parsed = registeredAppSchema.safeParse(readJson(path.join(INTEROP_APPS_DIR, name)));
    if (!parsed.success || parsed.data.version > APP_MANIFEST_VERSION) continue;
    if (!fs.existsSync(parsed.data.bin)) continue;
    apps.push(parsed.data);
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}
