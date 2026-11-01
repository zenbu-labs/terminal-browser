import path from "node:path";

import type { DownloadRecord } from "shared";

import type { DownloadView } from "../ui/types";

function downloadView(record: DownloadRecord): DownloadView {
  return {
    id: record.id,
    name: path.basename(record.filename),
    percent: record.totalBytes > 0 ? Math.round((record.receivedBytes / record.totalBytes) * 100) : null,
    state: record.state === "complete" ? "done" : record.state === "interrupted" ? "failed" : "progressing",
    dangerous: record.state === "in_progress" && record.danger === "file",
  };
}

// The pane's corner shows one download at a time. A dangerous one waiting for
// Keep or Discard stays in front of other downloads' progress until it's handled.
export class DownloadCorner {
  private readonly held = new Map<number, DownloadView>();

  changed(record: DownloadRecord): DownloadView | null {
    if (!record.filename) return null;
    const view = downloadView(record);
    if (view.dangerous) this.held.set(view.id, view);
    else this.held.delete(view.id);
    return this.firstHeld() ?? view;
  }

  erased(id: number): DownloadView | null {
    this.held.delete(id);
    return this.firstHeld();
  }

  private firstHeld(): DownloadView | null {
    return this.held.values().next().value ?? null;
  }
}
