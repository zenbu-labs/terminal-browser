import type { WebViewHandle } from "@zenbu-labs/pixel";
import { HINT_ALPHABET, hintLabels } from "./labels";
import { CANCEL_HINTS, showHints } from "./page";
import type { HintOutcome } from "./page";

const HINTS_WORLD_ID = 1014;

export interface LinkHintsHooks {
  openTab(url: string): void;
  empty(): void;
}

export class LinkHints {
  constructor(
    private readonly view: WebViewHandle,
    private readonly hooks: LinkHintsHooks,
  ) {}

  async start(newTab: boolean): Promise<void> {
    const options = `{ newTab: ${newTab}, alphabet: ${JSON.stringify(HINT_ALPHABET)}, labels: ${hintLabels} }`;
    const outcome = (await this.run(`(${showHints})(${options})`)) as HintOutcome | undefined;
    if (outcome?.type === "none") this.hooks.empty();
    if (outcome?.type === "openTab") this.hooks.openTab(outcome.url);
  }

  async cancel(): Promise<void> {
    await this.run(CANCEL_HINTS);
  }

  dispose(): void {
    void this.cancel();
  }

  private run(code: string): Promise<unknown> {
    return this.view.webContents
      .executeJavaScriptInIsolatedWorld(HINTS_WORLD_ID, [{ code }], true)
      .catch(() => undefined);
  }
}
