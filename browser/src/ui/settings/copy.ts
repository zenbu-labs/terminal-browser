import type { SettingsSection } from "../types";

export const copy = {
  sections: {
    general: "General",
    shortcuts: "Shortcuts",
    advanced: "Advanced",
  } satisfies Record<SettingsSection, string>,
  noMatches: "No matching shortcuts",
  recordPrompt: "Press desired key combination and then press ENTER.",
  unbound: "—",
  conflict: (labels: string[]) => `Also ${labels.join(", ")}`,
  reload: "Reload config",
  agent: "Configure with agent",
  version: "Version",
  update: (version: string, command: string) => `${version} is available. Run ${command}`,
  configFiles: "Config files",
};
