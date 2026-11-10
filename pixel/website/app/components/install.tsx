"use client";

import { track } from "@vercel/analytics";
import { useState } from "react";
import PixelCopyIcon from "./pixel-copy-icon";

const MANAGERS = [
  { name: "npm", command: "npm create @zenbu-labs/pixel@latest" },
  { name: "pnpm", command: "pnpm create @zenbu-labs/pixel" },
  { name: "bun", command: "bun create @zenbu-labs/pixel" },
];

export default function Install() {
  const [manager, setManager] = useState(0);
  const [copied, setCopied] = useState(false);
  const command = MANAGERS[manager].command;

  function copy() {
    navigator.clipboard.writeText(command);
    track("install_copied", { manager: MANAGERS[manager].name });
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="install">
      <div className="managers">
        {MANAGERS.map((m, i) => (
          <button key={m.name} className={i === manager ? "on" : undefined} onClick={() => {
              setManager(i);
              track("package_manager_selected", { manager: m.name });
            }}>
            {m.name}
          </button>
        ))}
      </div>
      <div className="box">
        <code>{command}</code>
        <button className="copy" onClick={copy} aria-label={copied ? "copied" : "copy"}>
          <PixelCopyIcon done={copied} />
        </button>
      </div>
    </div>
  );
}
