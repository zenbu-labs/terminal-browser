import { signAsync } from "@electron/osx-sign";

const [app, identity, keychain, entitlements] = process.argv.slice(2);
if (!entitlements) {
  console.error("usage: sign-app.mjs <app> <identity> <keychain> <entitlements>");
  process.exit(1);
}

await signAsync({
  app,
  identity,
  keychain,
  optionsForFile: () => ({ entitlements, hardenedRuntime: true }),
});
