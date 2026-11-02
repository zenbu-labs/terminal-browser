import { forwardRef, useEffect, useImperativeHandle } from "react";
import { Box } from "@zenbu-labs/pixel/device";
import type { DeviceRoot, WebViewHandle, WebViewProps } from "@zenbu-labs/pixel/device";

import { useNativeView } from "../native-views";

export function makeWebView(root: DeviceRoot) {
  return forwardRef<WebViewHandle, WebViewProps>(function WebView({ src, inline = false, style, hidden, onContentHeight, onFocusChange }, ref) {
    const view = useNativeView(root, "web", (event) => {
      if (event.type === "contentHeight") onContentHeight?.(Math.ceil(Number(event.height) * root.displayScale));
      if (event.type === "focus") onFocusChange?.(Boolean(event.focused));
    });
    useEffect(() => view.configure({ source: src, inline }), [view.id, src, inline]);
    useImperativeHandle(ref, () => ({ focus() {}, blur: () => view.configure({ blur: true }) }), [view.id]);
    return <Box style={{ flexShrink: 0, ...style }} hidden={hidden} surface={view.surface} />;
  });
}
