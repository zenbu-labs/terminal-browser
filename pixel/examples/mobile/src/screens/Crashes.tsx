import { Box, Text } from "@zenbu-labs/pixel/device";
import { crashReports } from "@zenbu-labs/pixel-ios";
import type { CrashReport } from "@zenbu-labs/pixel-ios";
import { useState } from "react";

import { useMetrics } from "../metrics";
import { colors } from "../theme";
import { Button, Section } from "../ui";

function summary(report: CrashReport): string {
  try {
    const body = JSON.parse(report.body) as { kind?: string; signal?: number; message?: string; reason?: string };
    return [body.kind, body.signal != null ? `signal ${body.signal}` : body.message ?? body.reason].filter(Boolean).join(" · ");
  } catch {
    return report.name;
  }
}

export function Crashes() {
  const { pt } = useMetrics();
  const [reports, setReports] = useState(() => crashReports.pending());
  return (
    <Box style={{ flexGrow: 1, flexBasis: 0, flexDirection: "column", padding: { left: 16 * pt, right: 16 * pt } }}>
      <Section title="Crash the app">
        <Text style={{ color: colors.muted, fontSize: 15 * pt }}>The app aborts. Open it again and the report written at the crash is listed below.</Text>
        <Box style={{ flexDirection: "row" }}>
          <Button label="Crash now" onPress={() => crashReports.crash()} style={{ background: [210, 70, 70, 255] }} />
        </Box>
      </Section>
      <Section title={`Reports from earlier launches (${reports.length})`}>
        {reports.length === 0 ? <Text style={{ color: colors.muted, fontSize: 15 * pt }}>No crash reports</Text> : null}
        {reports.map((report) => (
          <Box key={report.name} style={{ flexDirection: "column", gap: 4 * pt, padding: 12 * pt, cornerRadius: 12 * pt, background: colors.raised }}>
            <Text style={{ color: colors.text, fontSize: 15 * pt }}>{summary(report)}</Text>
            <Text style={{ color: colors.muted, fontSize: 13 * pt }}>{report.name}</Text>
          </Box>
        ))}
        {reports.length > 0 ? (
          <Box style={{ flexDirection: "row" }}>
            <Button
              label="Clear"
              onPress={() => {
                for (const report of reports) crashReports.remove(report.name);
                setReports(crashReports.pending());
              }}
            />
          </Box>
        ) : null}
      </Section>
    </Box>
  );
}
