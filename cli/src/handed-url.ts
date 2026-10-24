// A host opening an address it did not write itself, like one an agent chose, hands it over in
// the environment so no shell on the way to this process ever parses it.
export const OPEN_URL_ENV = "TERMINAL_BROWSER_OPEN_URL";

export function takeHandedUrl(args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const handed = env[OPEN_URL_ENV];
  if (handed === undefined) return;
  delete env[OPEN_URL_ENV];
  if (handed) args.push(handed);
}
