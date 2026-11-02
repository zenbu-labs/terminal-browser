import { requireNativeModule } from "expo-modules-core";
import { useEffect, useRef, useState } from "react";
import { Box } from "@zenbu-labs/pixel/device";
import type { DeviceRoot, ToolbarProps } from "@zenbu-labs/pixel/device";

import { useNativeView } from "../native-views";

interface ToolbarModule {
  setSystemBarItems(json: string): void;
  addListener(event: "onSystemBar", listener: (event: { type: string; active?: boolean; item?: string }) => void): { remove(): void };
}

const ITEM_PT = 44;
const HEIGHT_PT = 44;
const Toolbars = requireNativeModule<ToolbarModule>("PixelToolbar");
let systemBarActive = false;

export function makeToolbar(root: DeviceRoot) {
  function Capsule({ items, onPress, style }: ToolbarProps) {
    const view = useNativeView(root, "toolbar", (event) => {
      if (event.type === "press") onPress(String(event.item));
    });
    const config = JSON.stringify(items.map(({ id, symbol, label }) => ({ id, symbol, label })));
    useEffect(() => view.configure({ items: JSON.parse(config) }), [view.id, config]);
    const scale = root.displayScale;
    return <Box style={{ flexShrink: 0, ...style, width: (items.length * ITEM_PT + HEIGHT_PT * 0.4) * scale, height: HEIGHT_PT * scale }} surface={view.surface} />;
  }

  return function Toolbar(props: ToolbarProps) {
    const [inSystemBar, setInSystemBar] = useState(systemBarActive);
    const press = useRef(props.onPress);
    press.current = props.onPress;
    const items = JSON.stringify(props.items.map(({ id, symbol, label }) => ({ id, symbol, label })));
    useEffect(() => {
      const subscription = Toolbars.addListener("onSystemBar", (event) => {
        if (event.type === "active") {
          systemBarActive = Boolean(event.active);
          setInSystemBar(systemBarActive);
        } else if (event.type === "press" && event.item) {
          press.current(event.item);
        }
      });
      return () => subscription.remove();
    }, []);
    useEffect(() => Toolbars.setSystemBarItems(items), [items]);
    useEffect(() => () => Toolbars.setSystemBarItems("[]"), []);
    return inSystemBar ? null : <Capsule {...props} items={props.items.filter((item) => !item.roomy)} />;
  };
}
