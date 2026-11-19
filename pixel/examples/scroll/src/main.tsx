import { Box, Text, createRoot } from "@zenbu-labs/pixel";

const root = createRoot({
  name: "scroll",
  onKey(event) {
    if (event.kind === "press" && event.mods.ctrl && event.key === "c") {
      root.stop();
      return true;
    }
  },
});

const rem = root.info.basePx;
const COLUMNS = ["id", "name", "email", "city", "country", "plan", "joined", "last seen", "orders", "spent"];
const ROWS = 200;

function cell(row: number, column: string): string {
  return column === "id" ? String(row + 1) : `${column} ${row + 1}`;
}

function Row({ index }: { index: number }) {
  return (
    <Box style={{ flexShrink: 0, background: index % 2 ? "#ffffff0a" : undefined }}>
      {COLUMNS.map((column) => (
        <Text key={column} style={{ width: rem * 9, flexShrink: 0, padding: { left: rem * 0.5, top: rem * 0.15, bottom: rem * 0.15 } }}>
          {cell(index, column)}
        </Text>
      ))}
    </Box>
  );
}

function App() {
  return (
    <Box style={{ flexDirection: "column", width: "100%", height: "100%", background: "#16181d", color: "#d8dde6" }}>
      <Box style={{ padding: rem * 0.5, border: { bottom: [1, "#ffffff22"] } }}>
        {/* fixme: placeholder copy */}
        <Text>customers.db</Text>
      </Box>
      <Box style={{ flexGrow: 1 }}>
        <Box style={{ flexDirection: "column", width: rem * 10, flexShrink: 0, overflow: "scroll", border: { right: [1, "#ffffff22"] } }}>
          {["customers", "orders", "products", "invoices", "events"].map((table) => (
            <Text key={table} style={{ padding: rem * 0.4 }}>
              {table}
            </Text>
          ))}
        </Box>
        <Box style={{ flexDirection: "column", flexGrow: 1 }}>
          <Box style={{ flexDirection: "column", flexGrow: 1, overflow: "scroll" }}>
            <Box style={{ flexShrink: 0, background: "#ffffff14" }}>
              {COLUMNS.map((column) => (
                <Text key={column} style={{ width: rem * 9, flexShrink: 0, padding: { left: rem * 0.5, top: rem * 0.3, bottom: rem * 0.3 } }}>
                  {column}
                </Text>
              ))}
            </Box>
            {Array.from({ length: ROWS }, (_, index) => (
              <Row key={index} index={index} />
            ))}
          </Box>
          <Box style={{ padding: rem * 0.4, border: { top: [1, "#ffffff22"] } }}>
            {/* fixme: placeholder copy */}
            <Text>{`${ROWS} rows · ${COLUMNS.length} columns`}</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

root.render(<App />);
