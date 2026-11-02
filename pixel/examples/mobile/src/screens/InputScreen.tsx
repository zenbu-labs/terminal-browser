import { Box, Input, Text } from "@zenbu-labs/pixel/device";
import type { MarkRef, NodeHandle } from "@zenbu-labs/pixel/device";
import { useRef, useState } from "react";

import { useMetrics } from "../metrics";
import { colors } from "../theme";
import { Section } from "../ui";

const ATTACHMENTS = [
  { id: "photo", title: "Photo", symbol: "photo" },
  { id: "file", title: "File", symbol: "doc" },
  { id: "link", title: "Link", symbol: "link" },
];

export function InputScreen() {
  const { pt, root } = useMetrics();
  const composer = useRef<NodeHandle>(null);
  const [sent, setSent] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [draft, setDraft] = useState("");
  const labels = useRef(new Map<number, string>());
  const next = useRef(1);
  const attach = (name: string) => {
    const entry = ATTACHMENTS.find((item) => item.id === name);
    if (!entry) return;
    const id = next.current++;
    labels.current.set(id, `${entry.title} ${id}`);
    composer.current?.addMark(id);
    root.haptic("light");
  };
  const send = (text: string, marks: MarkRef[]) => {
    const chips = marks.map((mark) => `[${labels.current.get(mark.id)}]`).join(" ");
    const message = [text.replace(/￼/g, "").trim(), chips].filter(Boolean).join(" ");
    if (message) setSent((list) => [...list, message]);
    setDraft("");
    root.haptic("success");
  };
  return (
    <Box style={{ flexGrow: 1, flexBasis: 0, flexDirection: "column", padding: { left: 16 * pt, right: 16 * pt, bottom: 34 * pt } }}>
      <Section title="Single line">
        <Input value={title} onChange={setTitle} style={{ fontSize: 17 * pt, color: colors.text, wrap: false }} />
        <Text style={{ color: colors.muted, fontSize: 14 * pt }}>{title ? `Title: ${title}` : "Tap the field: the keyboard follows focus"}</Text>
      </Section>
      <Section title="Sent">
        {sent.length === 0 ? <Text style={{ color: colors.muted, fontSize: 15 * pt }}>Nothing sent yet</Text> : null}
        {sent.map((message, i) => (
          <Box key={i} style={{ padding: 12 * pt, cornerRadius: 14 * pt, background: colors.raised }}>
            <Text style={{ color: colors.text, fontSize: 15 * pt }}>{message}</Text>
          </Box>
        ))}
      </Section>
      <Box style={{ flexGrow: 1 }} />
      <Input
        ref={composer}
        value={draft}
        onChange={setDraft}
        onSubmit={send}
        markLabel={(id) => labels.current.get(id) ?? ""}
        accessories={{ leading: "plus", trailing: "send" }}
        accessoryMenu={ATTACHMENTS}
        onAccessory={attach}
        style={{ fontSize: 17 * pt, color: colors.text }}
      />
    </Box>
  );
}
