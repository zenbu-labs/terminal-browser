#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

import { connectSsh } from "@zenbu-labs/pixel/ssh";

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function main(): Promise<number> {
  const target = option("--ssh");
  const bundle = option("--bundle");
  const args = process.argv.slice(2);
  let url = args.find((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--ssh" && args[i - 1] !== "--bundle");
  const appArgs: string[] = [];
  if (target) {
    const session = await connectSsh({ target, bundle, status: (line) => process.stderr.write(`ssh: ${line}\n`) });
    appArgs.push(`--proxy=${session.view.proxy}`, `--partition=${session.view.partition}`);
    url ??= session.url;
  }
  if (url) appArgs.push(url);

  const launcher = path.join(path.dirname(require.resolve("@zenbu-labs/pixel/package.json")), "dist", "bin.js");
  const child = spawn(process.execPath, [launcher, path.join(__dirname, "main.js"), "--", ...appArgs], { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
  return new Promise<number>((resolve) => child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 0))));
}

void main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
