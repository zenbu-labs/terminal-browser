import path from "node:path";

import type { NativeEngine } from "./react/native";

export const BACKEND_ENV = "PIXEL_BACKEND";

export interface BackendOptions {
  name: string;
  sessionEnv: NodeJS.ProcessEnv;
}

export interface PixelBackend {
  createEngine(options: BackendOptions): NativeEngine;
}

export function loadBackend(env: NodeJS.ProcessEnv): PixelBackend | null {
  const specifier = env[BACKEND_ENV];
  if (!specifier) return null;
  const from = [process.cwd(), ...(process.argv[1] ? [path.dirname(process.argv[1])] : [])];
  return require(require.resolve(specifier, { paths: from })) as PixelBackend;
}
