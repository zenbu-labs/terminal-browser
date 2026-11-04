import fs from "node:fs";

import { sshForward } from "../ssh";
import type { SshRoute } from "../ssh";
import { startAuthProxy } from "./auth-proxy";
import type { AuthProxy, Upstream } from "./auth-proxy";

const SESSION_CHECK_MS = 2000;
const proxies = new Map<string, Promise<AuthProxy>>();
const running: AuthProxy[] = [];

export function runningSshProxy(port: number): AuthProxy | undefined {
  return running.find((proxy) => proxy.port === port);
}

// The credentials to answer a proxy challenge with: only those of the proxy
// the asking browser session was itself routed through.
export function sshProxyLogin(routedPort: number | undefined, challengedPort: number): AuthProxy | undefined {
  return routedPort === challengedPort ? runningSshProxy(challengedPort) : undefined;
}

// One loopback proxy per ssh connection. Once the connection's control socket is
// gone the proxy stops forwarding but keeps its port, answering 502, for as long
// as this process runs: its browser session (and any service worker in it) may
// still send requests there, so the port must never become free for someone else.
export function sshProxyFor(
  route: SshRoute,
  open: Upstream = (host, port) => sshForward(route, host, port),
  checkMs = SESSION_CHECK_MS,
): Promise<AuthProxy> {
  const key = `${route.controlPath}\0${route.destination}`;
  let proxy = proxies.get(key);
  if (proxy) return proxy;
  let retire = () => {};
  const forward: Upstream = (host, port) => {
    if (!fs.existsSync(route.controlPath)) {
      retire();
      // fixme: placeholder copy
      throw new Error(`the ssh connection to ${route.destination} is closed`);
    }
    return open(host, port);
  };
  proxy = startAuthProxy(forward).then((started) => {
    running.push(started);
    const watch = setInterval(() => {
      if (!fs.existsSync(route.controlPath)) retire();
    }, checkMs);
    watch.unref();
    retire = () => {
      clearInterval(watch);
      retire = () => {};
      started.retire();
      const index = running.indexOf(started);
      if (index !== -1) running.splice(index, 1);
    };
    return started;
  });
  proxies.set(key, proxy);
  return proxy;
}
