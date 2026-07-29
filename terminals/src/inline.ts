import { Backend, Pane, callerTty } from "./shared";

export function createInline(reason: string): Backend {
  const tty = callerTty() ?? "inline";
  const self: Pane = { window: "inline", tab: tty, pane: tty, title: "", self: true };
  return {
    app: "inline",
    async panes() {
      return [self];
    },
    async listAll() {
      return [{ window: self.window, tab: self.tab, pane: self.pane, title: self.title }];
    },
    async split() {
      throw new Error(reason);
    },
    async focusPane() {
      return false;
    },
    async focusSelf() {
      return true;
    },
    async sendText() {
      return false;
    },
  };
}
