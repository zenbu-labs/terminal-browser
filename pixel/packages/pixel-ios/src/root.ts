import { createRoot as createDeviceRoot, registerHostComponents } from "@zenbu-labs/pixel/device";
import type { DeviceRoot, DeviceRootOptions } from "@zenbu-labs/pixel/device";

import { makeInput } from "./components/input";
import { makeVideo } from "./components/video";
import { makeWebView } from "./components/web-view";
import { Pixel } from "./native-module";

export function createRoot(options: DeviceRootOptions = {}): DeviceRoot {
  const root = createDeviceRoot({ displayScale: Pixel.displayScale(), ...options });
  registerHostComponents({ Input: makeInput(root), WebView: makeWebView(root), Video: makeVideo(root) });
  return root;
}
