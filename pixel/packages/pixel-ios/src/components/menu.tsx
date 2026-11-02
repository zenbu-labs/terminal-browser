import { useEffect } from "react";
import { Box } from "@zenbu-labs/pixel/device";
import type { DeviceRoot, NativeMenuProps } from "@zenbu-labs/pixel/device";

import { useNativeView } from "../native-views";

export function makeMenu(root: DeviceRoot) {
  return function NativeMenu({ items, onSelect, children, style }: NativeMenuProps) {
    const view = useNativeView(root, "menu", (event) => {
      if (event.type === "select") onSelect(String(event.item));
    });
    useEffect(() => view.configure({ items }), [view.id, JSON.stringify(items)]);
    return (
      <Box style={style} surface={view.surface}>
        {children}
      </Box>
    );
  };
}
