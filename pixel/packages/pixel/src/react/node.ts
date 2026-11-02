import { requestFrameRate } from "../web/frame-rate";
import { installConsoleCapture } from "./devtools/console-capture";
import { exportProfile, setProfileDirectory } from "./devtools/export-profile";
import { createEngineRoot } from ".";
import type { PixelRoot, RootOptions, RootPlatform } from ".";

const nodePlatform: RootPlatform = {
  installConsoleCapture,
  setProfileDirectory,
  exportProfile,
  requestFrameRate,
  onTerminalResize(listener) {
    process.stdout.on("resize", listener);
    return () => process.stdout.off("resize", listener);
  },
  onProcessExit(listener) {
    process.on("exit", listener);
    return () => process.off("exit", listener);
  },
  exitWithEngine(error) {
    if (error) process.stderr.write(`pixel-react: engine exited: ${error}\n`);
    process.exit(error ? 1 : 0);
  },
};

export function createRoot(options: RootOptions = {}): PixelRoot {
  return createEngineRoot(options, nodePlatform);
}

export { Link } from "./link";
export type { LinkProps } from "./link";
