import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeStartupFiles } from "../zsh/startup";

interface Program {
  file: string;
  args: string[];
  argv0: string;
  env: NodeJS.ProcessEnv;
}

export interface ZshLaunch {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  dir: string;
  nonce: string;
}

function inheritedEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PXSH_")));
}

const EXEC_AS_LOGIN_SHELL = ["-f", "-c", 'exec -l -- "$0"'];

function zshPath(): string {
  return process.env.PXSH_ZSH ?? "/bin/zsh";
}

export function launch(): ZshLaunch {
  const nonce = randomBytes(6).toString("hex");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pxsh-"));
  writeStartupFiles(dir, nonce);
  const env: NodeJS.ProcessEnv = {
    ...inheritedEnv(),
    ZDOTDIR: dir,
    PXSH_USER_ZDOTDIR: process.env.ZDOTDIR ?? os.homedir(),
    PXSH_KEEP_ZDOTDIR: process.env.ZDOTDIR ? "1" : "",
  };
  delete env.INIT_CWD;
  delete env.SHLVL;
  const shell = zshPath();
  return {
    file: shell,
    args: [...EXEC_AS_LOGIN_SHELL, shell],
    cwd: process.env.PXSH_CWD ?? process.env.INIT_CWD ?? process.cwd(),
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    dir,
    nonce,
  };
}

export function fallback(args: string[]): Program {
  const shell = zshPath();
  return {
    file: shell,
    args,
    argv0: args.length ? shell : `-${shell}`,
    env: inheritedEnv(),
  };
}
