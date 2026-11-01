const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const models = require("../../dist/ai/models.js");

const claudeList = require("../../test-support/fixtures/claude-models.json");
const codexList = require("../../test-support/fixtures/codex-models.json");

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pxsh-models-"));
  return path.join(dir, "nested", "ai.json");
}

test("claude rows are named by the model their alias resolves to", () => {
  const parsed = models.claudeModels(claudeList);
  assert.deepEqual(
    parsed.map((m) => [m.id, m.name, m.hint]),
    [
      ["default", "Default", "Opus 5.5"],
      ["opus", "Opus 5.5", undefined],
      ["claude-fable-5-1[1m]", "Fable 5.1 (1M)", undefined],
      ["sonnet", "Sonnet 5.5", undefined],
      ["haiku", "Haiku 5.5", undefined],
    ],
  );
});

test("claude details drop the leading name and keep the rest of the description", () => {
  const [defaultRow, opus] = models.claudeModels(claudeList);
  assert.deepEqual(opus.details, ["Best for everyday, complex tasks", "$4/$20 per Mtok"]);
  assert.deepEqual(defaultRow.details, ["Use the default model (currently Opus 5.5)", "$4/$20 per Mtok"]);
});

test("claude effort levels and fast mode come from the model list", () => {
  const parsed = models.claudeModels(claudeList);
  const opus = parsed.find((m) => m.id === "opus");
  const sonnet = parsed.find((m) => m.id === "sonnet");
  assert.deepEqual(
    opus.efforts.map((e) => e.level),
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.equal(opus.fastTier, "fast");
  assert.equal(sonnet.fastTier, null);
  assert.equal(sonnet.preferred, true);
});

test("codex rows carry their reasoning efforts, default effort and fast tier", () => {
  const parsed = models.codexModels(codexList.models.data);
  const sol = parsed[0];
  assert.equal(sol.id, "gpt-6.1-sol");
  assert.equal(sol.name, "GPT-6.1-Sol");
  assert.equal(sol.preferred, true);
  assert.equal(sol.fastTier, "priority");
  assert.equal(sol.defaultEffort, codexList.models.data[0].defaultReasoningEffort);
  assert.ok(sol.efforts.some((e) => e.level === "high" && e.description.length > 0));
});

test("hidden codex models are left out", () => {
  const hidden = { ...codexList.models.data[1], model: "secret", hidden: true };
  assert.ok(!models.codexModels([...codexList.models.data, hidden]).some((m) => m.id === "secret"));
});

test("the last pick is saved and read back", () => {
  const file = tempFile();
  assert.equal(models.readChoice(file), null);
  models.saveChoice({ harness: "codex", model: "gpt-6-luna", effort: "low", fast: true }, file);
  assert.deepEqual(models.readChoice(file), { harness: "codex", model: "gpt-6-luna", effort: "low", fast: true });
  models.saveChoice({ harness: "claude", model: "opus", effort: null, fast: false }, file);
  assert.deepEqual(models.readChoice(file), { harness: "claude", model: "opus", effort: null, fast: false });
});

test("saving models keeps the choice and the other harness's models", () => {
  const file = tempFile();
  models.saveChoice({ harness: "claude", model: "haiku", effort: "low", fast: false }, file);
  models.saveModels("claude", { models: models.claudeModels(claudeList), signedIn: true }, file);
  models.saveModels("codex", { models: models.codexModels(codexList.models.data), signedIn: false }, file);
  const saved = models.readModels(file);
  assert.equal(saved.claude.models.length, 5);
  assert.equal(saved.codex.signedIn, false);
  assert.equal(models.readChoice(file).model, "haiku");
});

test("a broken or foreign state file reads as nothing saved", () => {
  const file = tempFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{not json");
  assert.equal(models.readChoice(file), null);
  assert.deepEqual(models.readModels(file), {});
  fs.writeFileSync(file, JSON.stringify({ choice: { harness: "gemini", model: "x" }, models: { claude: { models: [] } } }));
  assert.equal(models.readChoice(file), null);
  assert.deepEqual(models.readModels(file), {});
});

test("the saved pick is the default while its harness is installed", () => {
  const saved = { harness: "codex", model: "gpt-6-luna", effort: "high", fast: false };
  assert.deepEqual(models.resolveChoice(saved, ["claude", "codex"], {}), saved);
  assert.deepEqual(models.resolveChoice(saved, ["claude"], {}), { harness: "claude", model: "sonnet", effort: null, fast: false });
  assert.deepEqual(models.resolveChoice(null, ["codex"], { codex: { models: models.codexModels(codexList.models.data), signedIn: true } }), {
    harness: "codex",
    model: "gpt-6.1-sol",
    effort: null,
    fast: false,
  });
  assert.equal(models.resolveChoice(saved, [], {}), null);
});

test("an executable is found on the search path or in the extra directories", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pxsh-bin-"));
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "pxsh-extra-"));
  fs.writeFileSync(path.join(dir, "notexec"), "");
  fs.writeFileSync(path.join(extra, "codex"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(models.findExecutable("notexec", dir), null);
  assert.equal(models.findExecutable("codex", dir), null);
  assert.equal(models.findExecutable("codex", dir, [extra]), path.join(extra, "codex"));
});

test("the trigger names the model, its effort and fast mode", () => {
  const known = { claude: { models: models.claudeModels(claudeList), signedIn: true }, codex: { models: models.codexModels(codexList.models.data), signedIn: true } };
  assert.equal(models.choiceLabel({ harness: "claude", model: "sonnet", effort: null, fast: false }, known), "Sonnet 5.5");
  assert.equal(models.choiceLabel({ harness: "claude", model: "default", effort: "xhigh", fast: true }, known), "Opus 5.5 Extra high Fast");
  assert.equal(models.choiceLabel({ harness: "codex", model: "gpt-6-luna", effort: null, fast: false }, known), `GPT-6-Luna ${models.effortLabel(codexList.models.data[1].defaultReasoningEffort)}`);
  assert.equal(models.choiceLabel({ harness: "codex", model: "gone", effort: "low", fast: false }, known), "gone Low");
});
