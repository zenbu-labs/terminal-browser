"use client";

import { track } from "@vercel/analytics";
import { useRef, type ReactNode } from "react";

export default function WipTag({ children, tooltip }: { children: ReactNode; tooltip: ReactNode }) {
  const seen = useRef(false);
  const viewed = () => {
    if (seen.current) return;
    seen.current = true;
    track("windows_wip_viewed");
  };

  return (
    <span className="wip" tabIndex={0} onMouseEnter={viewed} onFocus={viewed}>
      {children}
      <span className="tooltip" role="tooltip">
        {tooltip}
      </span>
    </span>
  );
}
