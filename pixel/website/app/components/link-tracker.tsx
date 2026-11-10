"use client";

import { track } from "@vercel/analytics";
import { useEffect } from "react";

export default function LinkTracker() {
  useEffect(() => {
    function onClick(event: MouseEvent) {
      const link = (event.target as Element | null)?.closest("a[href]");
      if (!(link instanceof HTMLAnchorElement)) return;
      track("link_clicked", {
        href: link.href,
        text: (link.textContent ?? "").trim().slice(0, 60),
        area: link.closest("[data-area]")?.getAttribute("data-area") ?? "page",
      });
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  return null;
}
