const readline = require("node:readline");

const { Vt } = require("../dist/terminal/vt.js");

const [cols, rows, cellWidth, cellHeight] = process.argv.slice(2).map(Number);
const vt = new Vt(cols, rows, { scrollback: 10_000 });

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const [kind, ...rest] = line.split(" ");
  if (kind === "write") vt.write(Buffer.from(rest[0] ?? "", "base64"));
  else if (kind === "resize") vt.resize(Number(rest[0]), Number(rest[1]), cellWidth, cellHeight);
  else if (kind === "cursor") {
    const info = vt.info();
    process.stdout.write(`${info.cursorY} ${info.cursorX}\n`);
  }
});
