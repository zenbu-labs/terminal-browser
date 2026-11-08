import { setBinding } from "./binding";
import type { NativeBinding } from "./binding";

const NATIVE_PACKAGE = `@zenbu-labs/pixel-native-${process.platform}-${process.arch}`;

function loadBinding(): unknown {
  try {
    return require(`${NATIVE_PACKAGE}/pixel.node`);
  } catch (error) {
    const target = `${process.platform}-${process.arch} (${NATIVE_PACKAGE})`;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND"
        ? `no native build for ${target}: ${message}]`
        : `failed to load: ${message}]`,
    );
  }
}

if (process.platform === "darwin" && !process.env.NATIVE_SCROLL_HELPER) {
  try {
    process.env.NATIVE_SCROLL_HELPER = require.resolve(`${NATIVE_PACKAGE}/native-scroll-helper`);
  } catch {}
}

setBinding(loadBinding() as NativeBinding);
