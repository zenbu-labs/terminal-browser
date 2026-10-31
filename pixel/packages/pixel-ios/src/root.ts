import { createRoot as createDeviceRoot } from "@zenbu-labs/pixel/device";
import type { DeviceRoot, DeviceRootOptions } from "@zenbu-labs/pixel/device";

import { Pixel } from "./native-module";

export function createRoot(options: DeviceRootOptions = {}): DeviceRoot {
  return createDeviceRoot({ displayScale: Pixel.displayScale(), ...options });
}
