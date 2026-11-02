// Echo host for chrome.runtime.connectNative / sendNativeMessage. Chrome passes
// the caller's origin as the first argument.
const origin = process.argv[2];
let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length < 4 + length) break;
    const message = JSON.parse(buffer.subarray(4, 4 + length).toString());
    buffer = buffer.subarray(4 + length);
    if (message.exit) process.exit(0);
    send({ echo: message, origin });
  }
});
process.stdin.on("end", () => process.exit(0));
