import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type Run = (bin: string, args: string[], input?: string) => Promise<string>;

export function shellIn(env: NodeJS.ProcessEnv): Run {
  return async (bin, args, input) => {
    const running = exec(bin, args, { env, maxBuffer: 4 * 1024 * 1024, timeout: 8000 });
    if (input !== undefined) running.child.stdin?.end(input);
    const { stdout } = await running;
    return stdout;
  };
}
