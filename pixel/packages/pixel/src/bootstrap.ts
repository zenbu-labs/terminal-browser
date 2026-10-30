import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { app } from "electron";

import { debug } from "./debug";



const entry = process.argv[2];
if (!entry) {
  process.stderr.write("pixel bootstrap: missing entry path\n");
  app.exit(2);
}

function appName(): string {
  for (let dir = path.dirname(path.resolve(entry)); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const name = (JSON.parse(fs.readFileSync(candidate, "utf8")) as { name?: string }).name;
        if (name) return name.replace(/^@/, "").replace("/", "-");
      } catch {}
    }
    if (path.dirname(dir) === dir) return "pixel-app";
  }
}

function freePort(): Promise<number | null> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(null));
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(address && typeof address === "object" ? address.port : null));
    });
  });
}

process.on("uncaughtException", (error) => {
  process.stderr.write(`pixel: uncaught exception: ${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`pixel: unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}\n`);
});

app.setName(appName());
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-features", "FedCm");
if (process.env.PIXEL_DISABLE_GPU === "1") app.commandLine.appendSwitch("disable-gpu");
try {
  const logs = app.getPath("logs");
  fs.mkdirSync(logs, { recursive: true });
  app.commandLine.appendSwitch("enable-logging", "file");
  app.commandLine.appendSwitch("log-file", path.join(logs, "chromium.log"));
} catch {}

void (async () => {
  const port = await freePort();
  if (port != null) app.commandLine.appendSwitch("remote-debugging-port", String(port));
  await app.whenReady();
  debug("bootstrap", { entry, tty: process.env.PIXEL_TTY ?? null });
  if (process.platform === "darwin") app.dock?.hide();
  const chromiumSwitch = (arg: string) => arg.startsWith("--ozone-platform=") || arg.startsWith("--screen-info=");
  process.argv = [process.argv[0], path.resolve(entry), ...process.argv.slice(3).filter((arg) => !chromiumSwitch(arg))];
  require(path.resolve(entry));
})().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
