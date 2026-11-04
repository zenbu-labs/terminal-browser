import fs from "node:fs";

import { socketPair as nativeSocketPair } from "@zenbu-labs/pixel/native";

// Two connected Unix sockets made by the kernel directly, so no file on disk
// is ever there for another user to connect to or swap.
export function socketPair(): { pair: [number, number]; close(): void } {
  const pair = nativeSocketPair();
  return {
    pair,
    close: () => {
      for (const fd of pair) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    },
  };
}
