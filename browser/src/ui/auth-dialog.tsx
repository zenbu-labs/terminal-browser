import { useLayoutEffect, useRef, useState } from "react";
import { Box, Input, Text } from "@zenbu-labs/pixel";
import type { NodeHandle } from "@zenbu-labs/pixel";

import { Icon } from "./icons";
import { applyMaskedEdit, masked } from "./masked-text";
import { mix } from "./theme";
import type { Theme } from "./theme";
import type { AuthActions, AuthPromptView, AuthRow, ChromeLayout } from "./types";

const COPY = {
  signIn: "Sign in",
  proxy: "Proxy",
  username: "Username",
  password: "Password",
  cancel: "Cancel",
  notPrivate: "Your connection is not private",
  backToSafety: "Back to safety",
  advanced: "Advanced",
  proceedTo: (host: string) => `Proceed to ${host} (unsafe)`,
  certificate: "Select a certificate",
  passkey: "Choose a passkey",
  ok: "OK",
  continue: "Continue",
};

export function AuthDialog({
  view,
  actions,
  layout,
  theme,
}: {
  view: AuthPromptView;
  actions: AuthActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  switch (view.kind) {
    case "login":
      return <LoginDialog key={view.key} view={view} actions={actions} layout={layout} theme={theme} />;
    case "certificateError":
      return <Interstitial view={view} actions={actions} layout={layout} theme={theme} />;
    case "clientCertificate":
    case "passkeyAccount":
      return (
        <Card
          layout={layout}
          theme={theme}
          title={view.kind === "clientCertificate" ? COPY.certificate : COPY.passkey}
          subtitle={view.host}
          onClose={actions.cancel}
        >
          <Rows rows={view.rows} index={view.index} rem={layout.rem} theme={theme} onPick={actions.pick} />
          <Buttons rem={layout.rem}>
            <DialogButton label={COPY.cancel} tone="neutral" rem={layout.rem} theme={theme} onClick={actions.cancel} />
            <DialogButton
              label={view.kind === "clientCertificate" ? COPY.ok : COPY.continue}
              tone="accent"
              rem={layout.rem}
              theme={theme}
              onClick={actions.accept}
            />
          </Buttons>
        </Card>
      );
  }
}

function Interstitial({
  view,
  actions,
  layout,
  theme,
}: {
  view: Extract<AuthPromptView, { kind: "certificateError" }>;
  actions: AuthActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const { page } = layout;
  const width = Math.min(rem * 34, page.width - rem * 4);
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: page.y, left: page.x },
        width: page.width,
        height: page.height,
        flexDirection: "column",
        alignItems: "center",
        padding: { top: Math.round(page.height * 0.18) },
        background: theme.overlay,
      }}
      onClick={() => {}}
    >
      <Box style={{ width, flexDirection: "column", gap: rem * 0.9 }}>
        <Icon icon="alert" size={rem * 3.2} color={theme.red} weight={2} />
        <Text style={{ fontSize: rem * 1.6, color: theme.fg, selectable: false }}>{COPY.notPrivate}</Text>
        <Box style={{ flexDirection: "column", gap: rem * 0.35 }}>
          <Text style={{ fontSize: rem, color: theme.fg, wrap: false, overflow: "hidden" }}>{view.host}</Text>
          <Text style={{ fontSize: rem * 0.85, color: theme.muted }}>{view.error.replace(/^net::/, "NET::")}</Text>
        </Box>
        <Box style={{ justifyContent: "space-between", alignItems: "center", padding: { top: rem * 1.2 } }}>
          <DialogButton label={COPY.advanced} tone="neutral" rem={rem} theme={theme} onClick={actions.advanced} />
          <DialogButton label={COPY.backToSafety} tone="accent" rem={rem} theme={theme} onClick={actions.cancel} />
        </Box>
        {view.advanced && (
          <Box style={{ padding: { top: rem * 0.4 } }}>
            <Box
              style={{
                padding: { left: rem * 0.2, right: rem * 0.2, top: rem * 0.2, bottom: rem * 0.2 },
                cornerRadius: rem * 0.3,
                hoverBackground: theme.hover,
              }}
              onClick={actions.accept}
            >
              <Text style={{ fontSize: rem * 0.95, color: theme.muted, wrap: false, selectable: false }}>
                {COPY.proceedTo(view.host)}
              </Text>
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
}

function LoginDialog({
  view,
  actions,
  layout,
  theme,
}: {
  view: Extract<AuthPromptView, { kind: "login" }>;
  actions: AuthActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const passwordRef = useRef(password);
  passwordRef.current = password;
  const usernameInput = useRef<NodeHandle | null>(null);
  const passwordInput = useRef<NodeHandle | null>(null);
  useLayoutEffect(() => {
    (view.field === "username" ? usernameInput : passwordInput).current?.focus();
  }, [view.field]);
  const submit = () => actions.login(username, passwordRef.current);
  return (
    <Card
      layout={layout}
      theme={theme}
      title={COPY.signIn}
      subtitle={view.proxy ? `${COPY.proxy} ${view.origin}` : view.origin}
      onClose={actions.cancel}
    >
      <Box style={{ flexDirection: "column", gap: rem * 0.6 }}>
        <Field label={COPY.username} focused={view.field === "username"} rem={rem} theme={theme} onFocus={() => actions.focusField("username")}>
          <Input
            ref={usernameInput}
            autoFocus
            value={username}
            style={{ flexGrow: 1, flexBasis: 0, wrap: false, fontSize: rem * 0.95 }}
            caretColor={theme.accent}
            selectionColor={theme.selection}
            onChange={setUsername}
            onSubmit={submit}
          />
        </Field>
        <Field label={COPY.password} focused={view.field === "password"} rem={rem} theme={theme} onFocus={() => actions.focusField("password")}>
          <Input
            ref={passwordInput}
            value={masked(password)}
            style={{ flexGrow: 1, flexBasis: 0, wrap: false, fontSize: rem * 0.95 }}
            caretColor={theme.accent}
            selectionColor={theme.selection}
            onChange={(shown, change) => {
              const next = applyMaskedEdit(passwordRef.current, shown, change.cursor);
              passwordRef.current = next;
              setPassword(next);
            }}
            onSubmit={submit}
          />
        </Field>
      </Box>
      <Buttons rem={rem}>
        <DialogButton label={COPY.cancel} tone="neutral" rem={rem} theme={theme} onClick={actions.cancel} />
        <DialogButton label={COPY.signIn} tone="accent" rem={rem} theme={theme} onClick={submit} />
      </Buttons>
    </Card>
  );
}

function Card({
  layout,
  theme,
  title,
  subtitle,
  onClose,
  children,
}: {
  layout: ChromeLayout;
  theme: Theme;
  title: string;
  subtitle: string;
  onClose(): void;
  children: React.ReactNode;
}) {
  const rem = layout.rem;
  const width = Math.min(rem * 26, layout.width - rem * 2);
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: layout.toolbarHeight + rem * 0.9, left: Math.round((layout.width - width) / 2) },
        width,
        flexDirection: "column",
        gap: rem * 0.9,
        padding: { left: rem * 1.2, right: rem * 1.2, top: rem * 1, bottom: rem * 1.1 },
        background: theme.overlay,
        cornerRadius: rem * 0.8,
        border: { width: 1, color: theme.fieldBorder },
      }}
      onClick={() => {}}
    >
      <Box style={{ flexDirection: "column", gap: rem * 0.25 }}>
        <Box style={{ alignItems: "center", gap: rem * 0.5 }}>
          <Text
            style={{ flexGrow: 1, flexBasis: 0, fontSize: rem * 1.15, color: theme.fg, wrap: false, selectable: false }}
          >
            {title}
          </Text>
          <Box
            style={{
              width: rem * 1.5,
              height: rem * 1.5,
              alignItems: "center",
              justifyContent: "center",
              cornerRadius: rem * 0.3,
              hoverBackground: theme.hover,
              flexShrink: 0,
            }}
            onClick={onClose}
          >
            <Icon icon="close" size={rem} color={theme.fg} />
          </Box>
        </Box>
        <Text style={{ fontSize: rem * 0.9, color: theme.muted, wrap: false, selectable: false, overflow: "hidden" }}>
          {subtitle}
        </Text>
      </Box>
      {children}
    </Box>
  );
}

function Field({
  label,
  focused,
  rem,
  theme,
  onFocus,
  children,
}: {
  label: string;
  focused: boolean;
  rem: number;
  theme: Theme;
  onFocus(): void;
  children: React.ReactNode;
}) {
  return (
    <Box style={{ alignItems: "center", gap: rem * 0.8 }}>
      <Text style={{ width: rem * 5.5, fontSize: rem * 0.95, color: theme.fg, wrap: false, selectable: false }}>
        {label}
      </Text>
      <Box
        style={{
          flexGrow: 1,
          flexBasis: 0,
          height: rem * 2,
          alignItems: "center",
          padding: { left: rem * 0.6, right: rem * 0.6 },
          cornerRadius: rem * 0.4,
          background: theme.field,
          border: { width: 1, color: focused ? theme.accent : theme.fieldBorder },
        }}
        onClick={onFocus}
      >
        {children}
      </Box>
    </Box>
  );
}

function Rows({
  rows,
  index,
  rem,
  theme,
  onPick,
}: {
  rows: AuthRow[];
  index: number;
  rem: number;
  theme: Theme;
  onPick(index: number): void;
}) {
  return (
    <Box style={{ flexDirection: "column", gap: rem * 0.2 }}>
      {rows.map((row, i) => (
        <Box
          key={i}
          style={{
            alignItems: "center",
            gap: rem * 0.7,
            padding: { left: rem * 0.5, right: rem * 0.5, top: rem * 0.45, bottom: rem * 0.45 },
            cornerRadius: rem * 0.4,
            background: i === index ? theme.hover : undefined,
            hoverBackground: theme.hover,
          }}
          onClick={() => onPick(i)}
        >
          <Box style={{ width: rem, height: rem, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            {i === index && <Icon icon="check" size={rem} color={theme.accent} weight={3} />}
          </Box>
          <Box style={{ flexGrow: 1, flexBasis: 0, flexDirection: "column", gap: rem * 0.1 }}>
            <Text style={{ fontSize: rem * 0.95, color: theme.fg, wrap: false, selectable: false, overflow: "hidden" }}>
              {row.label}
            </Text>
            {row.detail && (
              <Text style={{ fontSize: rem * 0.8, color: theme.muted, wrap: false, selectable: false, overflow: "hidden" }}>
                {row.detail}
              </Text>
            )}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function Buttons({ rem, children }: { rem: number; children: React.ReactNode }) {
  return <Box style={{ justifyContent: "end", gap: rem * 0.6, padding: { top: rem * 0.2 } }}>{children}</Box>;
}

function DialogButton({
  label,
  tone,
  rem,
  theme,
  onClick,
}: {
  label: string;
  tone: "neutral" | "accent";
  rem: number;
  theme: Theme;
  onClick(): void;
}) {
  return (
    <Box
      style={{
        height: rem * 1.9,
        alignItems: "center",
        padding: { left: rem * 1.1, right: rem * 1.1 },
        cornerRadius: rem * 0.35,
        background: tone === "accent" ? mix(theme.overlay, theme.accent, 0.22) : theme.field,
        hoverBackground: tone === "accent" ? mix(theme.overlay, theme.accent, 0.38) : theme.hoverStrong,
        flexShrink: 0,
      }}
      onClick={onClick}
    >
      <Text style={{ fontSize: rem * 0.95, color: theme.fg, wrap: false, selectable: false }}>{label}</Text>
    </Box>
  );
}
