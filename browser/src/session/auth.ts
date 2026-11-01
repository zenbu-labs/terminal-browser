import type {
  AuthGate,
  CertificateErrorRequest,
  ClientCertificateRequest,
  LoginCredentials,
  LoginRequest,
  PasskeyAccountRequest,
} from "@zenbu-labs/pixel";

import type { AuthPromptView } from "../ui/types";
import { PROMPT_ARMING_MS } from "./permissions";

type Pending =
  | { kind: "login"; request: LoginRequest; resolve(answer: LoginCredentials | null): void }
  | { kind: "certificateError"; request: CertificateErrorRequest; resolve(answer: boolean): void }
  | { kind: "clientCertificate"; request: ClientCertificateRequest; resolve(answer: string | null): void }
  | { kind: "passkeyAccount"; request: PasskeyAccountRequest; resolve(answer: string | null): void };

type Prompt = Pending & {
  key: number;
  tabId: number;
  shownAt: number | null;
  index: number;
  field: "username" | "password";
  advanced: boolean;
};

export interface AuthHost {
  requestRender(): void;
  leaveUnsafePage(tabId: number, left: () => void): void;
}

export class AuthPrompts {
  private pending: Prompt[] = [];
  private nextKey = 1;
  private lastInputAt = 0;
  private leaving = new Map<number, AuthPromptView>();

  constructor(private readonly host: AuthHost) {}

  gate(tabId: number): AuthGate {
    return {
      login: (request) => this.ask(tabId, { kind: "login", request }, null),
      certificateError: (request) => this.ask(tabId, { kind: "certificateError", request }, false),
      clientCertificate: (request) => this.ask(tabId, { kind: "clientCertificate", request }, null),
      passkeyAccount: (request) => this.ask(tabId, { kind: "passkeyAccount", request }, null),
    };
  }

  private ask<T>(tabId: number, pending: { kind: Pending["kind"]; request: Pending["request"] }, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
      const prompt = {
        ...pending,
        resolve,
        key: this.nextKey++,
        tabId,
        shownAt: null,
        index: 0,
        field: "username",
        advanced: false,
      } as Prompt;
      this.pending.push(prompt);
      pending.request.signal.addEventListener("abort", () => this.finish(prompt, fallback));
      this.host.requestRender();
    });
  }

  hasPending(tabId: number): boolean {
    return this.current(tabId) !== null || this.leaving.has(tabId);
  }

  view(tabId: number): AuthPromptView | null {
    const prompt = this.current(tabId);
    if (!prompt) return this.leaving.get(tabId) ?? null;
    prompt.shownAt ??= Date.now();
    switch (prompt.kind) {
      case "login": {
        const { request } = prompt;
        return {
          kind: "login",
          key: prompt.key,
          origin: request.isProxy ? `${request.host}:${request.port}` : originOf(request.url),
          proxy: request.isProxy,
          field: prompt.field,
        };
      }
      case "certificateError":
        return {
          kind: "certificateError",
          key: prompt.key,
          url: prompt.request.url,
          host: prompt.request.host,
          error: prompt.request.error,
          advanced: prompt.advanced,
        };
      case "clientCertificate":
        return {
          kind: "clientCertificate",
          key: prompt.key,
          host: prompt.request.host,
          index: prompt.index,
          rows: prompt.request.certificates.map((certificate) => ({
            label: certificate.subject,
            detail: certificate.issuer,
          })),
        };
      case "passkeyAccount":
        return {
          kind: "passkeyAccount",
          key: prompt.key,
          host: prompt.request.relyingPartyId,
          index: prompt.index,
          rows: prompt.request.accounts.map((account) => ({
            label: account.name || account.displayName || account.credentialId,
            detail: account.displayName && account.displayName !== account.name ? account.displayName : "",
          })),
        };
    }
  }

  noteInput() {
    this.lastInputAt = Date.now();
  }

  // Typing a password and pressing Enter straight away is normal, so the sign in form only waits out the opening.
  private armed(prompt: Prompt): boolean {
    const now = Date.now();
    if (prompt.shownAt === null || now - prompt.shownAt < PROMPT_ARMING_MS) return false;
    return prompt.kind === "login" || now - this.lastInputAt >= PROMPT_ARMING_MS;
  }

  submitLogin(tabId: number, credentials: LoginCredentials) {
    const prompt = this.current(tabId);
    if (prompt?.kind !== "login" || !this.armed(prompt)) return;
    this.finish(prompt, credentials);
  }

  accept(tabId: number) {
    const prompt = this.current(tabId);
    if (!prompt || prompt.kind === "login" || !this.armed(prompt)) return;
    if (prompt.kind === "certificateError") {
      if (prompt.advanced) this.finish(prompt, true);
    }
    else if (prompt.kind === "clientCertificate")
      this.finish(prompt, prompt.request.certificates[prompt.index]?.fingerprint ?? null);
    else this.finish(prompt, prompt.request.accounts[prompt.index]?.credentialId ?? null);
  }

  enter(tabId: number) {
    const prompt = this.current(tabId);
    if (prompt?.kind === "certificateError") this.cancel(tabId);
    else if (prompt && prompt.kind !== "login") this.accept(tabId);
  }

  cancel(tabId: number) {
    const prompt = this.current(tabId);
    if (!prompt) return;
    if (prompt.kind === "certificateError") {
      // The warning stays up until the tab is back on the page it came from, so the refused page never shows.
      const shown = this.view(tabId);
      if (shown) this.leaving.set(tabId, shown);
      this.host.leaveUnsafePage(tabId, () => {
        if (this.leaving.get(tabId) !== shown) return;
        this.leaving.delete(tabId);
        this.host.requestRender();
      });
      this.finish(prompt, false);
    } else this.finish(prompt, null);
  }

  toggleAdvanced(tabId: number) {
    const prompt = this.current(tabId);
    if (prompt?.kind !== "certificateError") return;
    prompt.advanced = !prompt.advanced;
    this.host.requestRender();
  }

  pick(tabId: number, index: number) {
    const prompt = this.current(tabId);
    if (!prompt || (prompt.kind !== "clientCertificate" && prompt.kind !== "passkeyAccount")) return;
    const count =
      prompt.kind === "clientCertificate" ? prompt.request.certificates.length : prompt.request.accounts.length;
    prompt.index = (index + count) % count;
    this.host.requestRender();
  }

  step(tabId: number, by: number) {
    const prompt = this.current(tabId);
    if (prompt) this.pick(tabId, prompt.index + by);
  }

  focusField(tabId: number, field: "username" | "password") {
    const prompt = this.current(tabId);
    if (prompt?.kind !== "login" || prompt.field === field) return;
    prompt.field = field;
    this.host.requestRender();
  }

  toggleField(tabId: number) {
    const prompt = this.current(tabId);
    if (prompt?.kind === "login") this.focusField(tabId, prompt.field === "username" ? "password" : "username");
  }

  closed(tabId: number) {
    this.leaving.delete(tabId);
    for (const prompt of this.pending.filter((candidate) => candidate.tabId === tabId)) {
      this.finish(prompt, prompt.kind === "certificateError" ? false : null);
    }
  }

  private current(tabId: number): Prompt | null {
    return this.pending.find((prompt) => prompt.tabId === tabId) ?? null;
  }

  private finish(prompt: Prompt, answer: unknown) {
    const at = this.pending.indexOf(prompt);
    if (at === -1) return;
    this.pending.splice(at, 1);
    (prompt.resolve as (answer: unknown) => void)(answer);
    this.host.requestRender();
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
