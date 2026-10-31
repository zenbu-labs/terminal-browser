import { useEffect } from "react";
import { Box } from "@zenbu-labs/pixel/device";
import type { DeviceRoot, VideoProps } from "@zenbu-labs/pixel/device";

import { useNativeView } from "../native-views";

export function makeVideo(root: DeviceRoot) {
  return function Video({ src, headers, paused = false, muted, loop, timeMs, onTime, onEnd, style }: VideoProps) {
    const view = useNativeView(root, "video", (event) => {
      if (event.type === "time") onTime?.(Number(event.timeMs), Number(event.durationMs));
      if (event.type === "end") onEnd?.();
    });
    useEffect(() => view.configure({ source: src, headers: headers ?? {} }), [view.id, src, JSON.stringify(headers)]);
    useEffect(() => view.configure({ paused, muted: muted ?? false, loop: loop ?? false }), [view.id, paused, muted, loop]);
    useEffect(() => {
      if (timeMs != null) view.configure({ timeMs });
    }, [view.id, timeMs]);
    return <Box style={{ flexShrink: 0, ...style }} surface={view.surface} />;
  };
}
