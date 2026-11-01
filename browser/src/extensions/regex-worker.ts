import { parentPort } from "node:worker_threads";

import { RE2JS } from "re2js";

import type { RegexReply, RegexRequest } from "./download-regex";

parentPort?.on("message", ({ id, filters }: RegexRequest) => {
  let reply: RegexReply;
  try {
    const results = filters.map(({ pattern, subjects }) => {
      const compiled = RE2JS.compile(pattern);
      return subjects.map((subject) => compiled.matcher(subject).find());
    });
    reply = { id, results };
  } catch {
    reply = { id, invalid: true };
  }
  parentPort?.postMessage(reply);
});
