import { signAsync } from "@electron/osx-sign";

const [app, identity, keychain, entitlements, appEntitlements] = process.argv.slice(2);
if (!appEntitlements) {
  // fixme: placeholder copy
  console.error("usage: sign-app.mjs <app> <identity> <keychain> <entitlements> <app-entitlements>");
  process.exit(1);
}

await signAsync({
  app,
  identity,
  keychain,
  // The bundle's own signature is the main executable's, so both get the app entitlements; helpers keep the base set.
  optionsForFile: (file) => ({
    entitlements: file === app || file === `${app}/Contents/MacOS/terminal-browser` ? appEntitlements : entitlements,
    hardenedRuntime: true,
  }),
});
