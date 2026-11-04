import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { app, webContents as allWebContents } from "electron";
import type { Certificate, Session, WebContents } from "electron";

import { runningSshProxy } from "./ssh-proxies";

export interface LoginRequest {
  url: string;
  host: string;
  port: number;
  realm: string;
  scheme: string;
  isProxy: boolean;
  signal: AbortSignal;
}

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface CertificateSummary {
  subject: string;
  issuer: string;
  validExpiry: number;
  fingerprint: string;
}

export interface ClientCertificateRequest {
  url: string;
  host: string;
  certificates: CertificateSummary[];
  signal: AbortSignal;
}

export interface CertificateErrorRequest {
  url: string;
  host: string;
  error: string;
  certificate: CertificateSummary;
  signal: AbortSignal;
}

export interface PasskeyAccount {
  credentialId: string;
  name: string | undefined;
  displayName: string | undefined;
}

export interface PasskeyAccountRequest {
  relyingPartyId: string;
  accounts: PasskeyAccount[];
  signal: AbortSignal;
}

export interface AuthGate {
  login(request: LoginRequest): Promise<LoginCredentials | null>;
  certificateError(request: CertificateErrorRequest): Promise<boolean>;
  clientCertificate(request: ClientCertificateRequest): Promise<string | null>;
  passkeyAccount(request: PasskeyAccountRequest): Promise<string | null>;
}

const authGates = new Map<number, AuthGate>();

export function onAuthFor(contents: WebContents, gate: AuthGate): void {
  authGates.set(contents.id, gate);
  contents.once("destroyed", () => authGates.delete(contents.id));
}

function summarize(certificate: Certificate): CertificateSummary {
  return {
    subject: certificate.subjectName,
    issuer: certificate.issuerName,
    validExpiry: certificate.validExpiry,
    fingerprint: certificate.fingerprint,
  };
}

// Client certificate requests name the server as host:port, without a scheme.
function hostOf(url: string): string {
  for (const candidate of [url, `https://${url}`]) {
    try {
      const host = new URL(candidate).host;
      if (host) return host;
    } catch {}
  }
  return "";
}

// The answer comes back false or null when the page navigates away or closes before the user answers.
function ask<T>(contents: WebContents, fallback: T, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const cancel = new AbortController();
  const leave = () => cancel.abort();
  contents.on("did-start-navigation", onNavigation);
  contents.once("destroyed", leave);
  function onNavigation(details: { isMainFrame: boolean; isSameDocument: boolean }) {
    if (details.isMainFrame && !details.isSameDocument) leave();
  }
  const aborted = new Promise<T>((resolve) => cancel.signal.addEventListener("abort", () => resolve(fallback)));
  return Promise.race([run(cancel.signal).catch(() => fallback), aborted]).finally(() => {
    contents.off("did-start-navigation", onNavigation);
    contents.off("destroyed", leave);
    cancel.abort();
  });
}

const allowedCertificates = new WeakMap<Session, Set<string>>();
const pendingCertificateErrors = new WeakMap<Session, Map<string, Promise<boolean>>>();

function certificateKey(host: string, error: string, certificate: Certificate): string {
  return `${host}|${error}|${certificate.fingerprint}`;
}

function certificateAllowed(session: Session, key: string): boolean {
  return allowedCertificates.get(session)?.has(key) ?? false;
}

function allowCertificate(session: Session, key: string) {
  let allowed = allowedCertificates.get(session);
  if (!allowed) allowedCertificates.set(session, (allowed = new Set()));
  allowed.add(key);
}

function pendingCertificateErrorsOf(session: Session): Map<string, Promise<boolean>> {
  let pending = pendingCertificateErrors.get(session);
  if (!pending) pendingCertificateErrors.set(session, (pending = new Map()));
  return pending;
}

let installed = false;

export function installAuthHandlers(): void {
  if (installed) return;
  installed = true;

  app.on("login", (event, contents, details, authInfo, callback) => {
    // Our ssh proxies are answered by browser-session.ts, and only for the session routed through them.
    if (authInfo.isProxy && authInfo.host === "127.0.0.1" && runningSshProxy(authInfo.port)) return;
    event.preventDefault();
    const gate = contents ? authGates.get(contents.id) : undefined;
    if (!contents || !gate) return callback();
    void ask(contents, null, (signal) =>
      gate.login({
        url: details.url,
        host: authInfo.host,
        port: authInfo.port,
        realm: authInfo.realm,
        scheme: authInfo.scheme,
        isProxy: authInfo.isProxy,
        signal,
      }),
    ).then((credentials) =>
      credentials ? callback(credentials.username, credentials.password) : callback(),
    );
  });

  app.on("certificate-error", (event, contents, url, error, certificate, callback, isMainFrame) => {
    event.preventDefault();
    const host = hostOf(url);
    const key = certificateKey(host, error, certificate);
    if (certificateAllowed(contents.session, key)) return callback(true);
    const gate = authGates.get(contents.id);
    if (!gate || !isMainFrame) return callback(false);
    const pending = pendingCertificateErrorsOf(contents.session);
    let answer = pending.get(key);
    if (!answer) {
      answer = ask(contents, false, (signal) =>
        gate.certificateError({ url, host, error, certificate: summarize(certificate), signal }),
      ).finally(() => pending.delete(key));
      pending.set(key, answer);
    }
    void answer.then((allowed) => {
      if (allowed) allowCertificate(contents.session, key);
      callback(allowed);
    });
  });

  app.on("select-client-certificate", (event, contents, url, certificates, callback) => {
    event.preventDefault();
    const gate = contents ? authGates.get(contents.id) : undefined;
    if (!contents || !gate || certificates.length === 0) return callback();
    void ask(contents, null, (signal) =>
      gate.clientCertificate({ url, host: hostOf(url), certificates: certificates.map(summarize), signal }),
    ).then((fingerprint) => {
      const chosen = certificates.find((certificate) => certificate.fingerprint === fingerprint);
      callback(chosen);
    });
  });

  void enableTouchId();
}

export function gatePasskeyAccounts(target: Session): void {
  target.on("select-webauthn-account", (event, details, callback) => {
    event.preventDefault();
    const contents = details.frame ? allWebContents.fromFrame(details.frame) : undefined;
    const gate = contents ? authGates.get(contents.id) : undefined;
    if (!contents || !gate) return callback();
    void ask(contents, null, (signal) =>
      gate.passkeyAccount({
        relyingPartyId: details.relyingPartyId,
        accounts: details.accounts.map(({ credentialId, name, displayName }) => ({ credentialId, name, displayName })),
        signal,
      }),
    ).then((credentialId) => callback(credentialId ?? undefined));
  });
}

// Touch ID passkeys live in a keychain group the app has to be signed for, so builds without that entitlement leave it off.
async function enableTouchId() {
  if (process.platform !== "darwin") return;
  const group = webAuthnAccessGroup(await signedEntitlements());
  if (!group) return;
  await app.whenReady();
  app.configureWebAuthn({ touchID: { keychainAccessGroup: group } });
}

async function signedEntitlements(): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)("codesign", ["-d", "--entitlements", "-", "--xml", process.execPath]);
    return stdout;
  } catch {
    return "";
  }
}

export function webAuthnAccessGroup(entitlementsXml: string): string | null {
  const groups = /<key>keychain-access-groups<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(entitlementsXml)?.[1] ?? "";
  for (const match of groups.matchAll(/<string>([^<]+)<\/string>/g)) {
    if (match[1].endsWith(".webauthn")) return match[1];
  }
  return null;
}
