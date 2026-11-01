const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tts-data-"));
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tb-tts-config-"));
const electron = require("./fake-electron.js");
electron.app.getLocale = () => "en-US";
const { Router } = require("../dist/extensions/router.js");
const { channelFor } = require("../dist/extensions/protocol.js");
const { installTts } = require("../dist/extensions/api/tts.js");
const speech = require("../dist/extensions/speech.js");
const { SilentSpeech, TtsController } = require("../dist/extensions/tts.js");

// Every test speaks through SilentSpeech, so nothing ever reaches the speakers.
const silent = new SilentSpeech([{ name: "Alex", lang: "en-US" }, { name: "Thomas", lang: "fr-FR" }], 1);
const spokenWith = [];
const speakSilently = silent.speak.bind(silent);
silent.speak = (speech, emit) => {
  spokenWith.push(speech.voiceName);
  speakSilently(speech, emit);
};
speech.useSpeechPlatform(silent);

const SPEAKER = "a".repeat(32);
const OTHER = "b".repeat(32);
const ENGINE = "c".repeat(32);
const LISTENER_ONLY = "d".repeat(32);
const NO_PERMISSION = "e".repeat(32);

function extension(id, permissions, manifest = {}) {
  return { id, manifest: { manifest_version: 3, name: id, version: "1", ...manifest }, hasApiPermission: (p) => permissions.includes(p) };
}

const engineManifest = { tts_engine: { voices: [{ voice_name: "Engine Voice", lang: "en-GB", event_types: ["start", "end", "word"] }] } };
const session = new electron.FakeSession("tts");
const loaded = new Map(
  [
    extension(SPEAKER, ["tts"]),
    extension(OTHER, ["tts", "ttsEngine"]),
    extension(ENGINE, ["ttsEngine"], engineManifest),
    extension(LISTENER_ONLY, ["ttsEngine"], { tts_engine: { voices: [{ voice_name: "Half Engine", event_types: ["end"] }] } }),
    extension(NO_PERMISSION, [], engineManifest),
  ].map((e) => [e.id, e]),
);
const listening = new Map([
  [ENGINE, new Set(["ttsEngine.onSpeak", "ttsEngine.onStop"])],
  [LISTENER_ONLY, new Set(["ttsEngine.onSpeak"])],
  [NO_PERMISSION, new Set(["ttsEngine.onSpeak", "ttsEngine.onStop", "tts.onVoicesChanged"])],
  [SPEAKER, new Set(["tts.onVoicesChanged"])],
]);
const sent = [];
const dispatched = [];
const unloads = [];
const router = new Router(session, (id) => loaded.get(id) ?? null);
const service = {
  router,
  loaded,
  get: (id) => loaded.get(id) ?? null,
  events: {
    hasListener: (id, event) => listening.get(id)?.has(event) ?? false,
    sendToFrame: (frame, event, args) => sent.push({ to: frame.processId, event, details: args[0] }),
    sendToWorker: (worker, event, args) => sent.push({ to: worker.scope, event, details: args[0] }),
  },
  dispatch: (id, event, args) => dispatched.push({ id, event, args }),
  broadcast(event, argsFor) {
    for (const ext of loaded.values()) {
      if (!this.events.hasListener(ext.id, event)) continue;
      const args = argsFor(ext);
      if (args) dispatched.push({ id: ext.id, event, args });
    }
  },
  onUnload: (listener) => unloads.push(listener),
};
const controller = installTts(service);
router.listen();

const frames = new Map([...loaded.keys()].map((id, index) => [id, index + 1]));
function call(id, method, ...args) {
  const frame = { origin: `chrome-extension://${id}`, processId: frames.get(id), routingId: 1 };
  return electron.invokeHandlers.get(channelFor(method))({ sender: { session, id: 9 }, senderFrame: frame }, ...args);
}

const eventsFor = (id) => sent.filter((entry) => entry.to === frames.get(id)).map((entry) => entry.details);
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
async function until(check, what) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${what}`);
}
async function idle() {
  await until(() => !controller.isSpeaking(), "speech to finish");
}
function reset() {
  sent.length = 0;
  dispatched.length = 0;
}

test("speak answers first, then the speaking page hears start, each word and a final end", async () => {
  await idle();
  reset();
  await call(SPEAKER, "tts.speak", "hello there", { srcId: 1 });
  assert.deepEqual(sent, []);
  await until(() => eventsFor(SPEAKER).some((e) => e.type === "end"), "end");
  assert.deepEqual(eventsFor(SPEAKER), [
    { charIndex: 0, isFinalEvent: false, srcId: 1, type: "start" },
    { charIndex: 0, isFinalEvent: false, length: 5, srcId: 1, type: "word" },
    { charIndex: 6, isFinalEvent: false, length: 5, srcId: 1, type: "word" },
    { charIndex: 11, isFinalEvent: true, srcId: 1, type: "end" },
  ]);
  assert.equal(await call(SPEAKER, "tts.isSpeaking"), false);
});

test("without an onEvent callback nothing is sent back, and desiredEventTypes filters what is", async () => {
  await idle();
  reset();
  await call(SPEAKER, "tts.speak", "quiet");
  await call(SPEAKER, "tts.speak", "picky words", { srcId: 2, enqueue: true, desiredEventTypes: ["end"] });
  await until(() => eventsFor(SPEAKER).length > 0, "end");
  await idle();
  assert.deepEqual(eventsFor(SPEAKER), [{ charIndex: 11, isFinalEvent: true, srcId: 2, type: "end" }]);
});

test("enqueue waits its turn, and a speak that doesn't enqueue interrupts the current one and cancels the queue", async () => {
  await idle();
  reset();
  await call(SPEAKER, "tts.speak", "one two three four five six", { srcId: 10 });
  await call(SPEAKER, "tts.speak", "queued", { srcId: 11, enqueue: true });
  await until(() => eventsFor(SPEAKER).some((e) => e.type === "word"), "first word");
  assert.equal(await call(SPEAKER, "tts.isSpeaking"), true);
  await call(SPEAKER, "tts.speak", "now", { srcId: 12 });
  await until(() => eventsFor(SPEAKER).some((e) => e.srcId === 12 && e.type === "end"), "the last utterance's end");
  const finals = eventsFor(SPEAKER).filter((e) => e.isFinalEvent).map((e) => `${e.srcId}:${e.type}`);
  assert.deepEqual(finals, ["10:interrupted", "11:cancelled", "12:end"]);
  assert.equal(eventsFor(SPEAKER).some((e) => e.srcId === 11 && e.type === "start"), false);
});

test("an extension only stops its own speech", async () => {
  await idle();
  reset();
  await call(SPEAKER, "tts.speak", "a b c d e f g h", { srcId: 20 });
  await until(() => eventsFor(SPEAKER).length > 0, "start");
  await call(OTHER, "tts.stop");
  assert.equal(await call(OTHER, "tts.isSpeaking"), true);
  await call(SPEAKER, "tts.stop");
  assert.equal(await call(SPEAKER, "tts.isSpeaking"), false);
  assert.deepEqual(eventsFor(SPEAKER).at(-1), { isFinalEvent: true, srcId: 20, type: "interrupted" });
});

test("pause holds speech and the queue until resume", async () => {
  await idle();
  reset();
  await call(SPEAKER, "tts.speak", "a b c d e f g h", { srcId: 30 });
  await until(() => eventsFor(SPEAKER).some((e) => e.type === "word"), "a word");
  await call(SPEAKER, "tts.pause");
  const paused = eventsFor(SPEAKER).length;
  assert.equal(eventsFor(SPEAKER).at(-1).type, "pause");
  await call(SPEAKER, "tts.speak", "later", { srcId: 31, enqueue: true });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(eventsFor(SPEAKER).length, paused);
  assert.equal(await call(SPEAKER, "tts.isSpeaking"), true);
  await call(SPEAKER, "tts.resume");
  await until(() => eventsFor(SPEAKER).some((e) => e.srcId === 31 && e.type === "end"), "the queued utterance");
  assert.ok(eventsFor(SPEAKER).some((e) => e.srcId === 30 && e.type === "resume"));
  assert.ok(eventsFor(SPEAKER).some((e) => e.srcId === 30 && e.type === "end"));
});

test("getVoices lists system voices and the engines that listen for both speak and stop, in Chrome's shape", async () => {
  const voices = await call(SPEAKER, "tts.getVoices");
  assert.deepEqual(voices, [
    { eventTypes: ["start", "end", "word", "pause", "resume"], lang: "en-US", remote: false, voiceName: "Alex" },
    { eventTypes: ["start", "end", "word", "pause", "resume"], lang: "fr-FR", remote: false, voiceName: "Thomas" },
    { eventTypes: ["start", "end", "word", "interrupted", "cancelled"], extensionId: ENGINE, lang: "en-GB", remote: false, voiceName: "Engine Voice" },
  ]);
});

test("a voice is picked by name, extension id and then language, like Chrome", async () => {
  await idle();
  reset();
  await call(SPEAKER, "tts.speak", "bonjour", { lang: "fr" });
  await call(SPEAKER, "tts.speak", "named", { voiceName: "Engine Voice", enqueue: true });
  await until(() => dispatched.some((d) => d.event === "ttsEngine.onSpeak"), "the engine's onSpeak");
  assert.equal(spokenWith.at(-1), "Thomas");
  const speak = dispatched.find((d) => d.event === "ttsEngine.onSpeak");
  assert.equal(speak.id, ENGINE);
  assert.equal(speak.args[0], "named");
  assert.deepEqual(speak.args[1], { lang: "en-GB", pitch: 1, rate: 1, voiceName: "Engine Voice", volume: 1 });
  await call(SPEAKER, "tts.stop");
  assert.ok(dispatched.some((d) => d.id === ENGINE && d.event === "ttsEngine.onStop"));
});

test("an engine's events reach the extension that spoke, and no other extension can send them", async () => {
  await idle();
  reset();
  await call(SPEAKER, "tts.speak", "through the engine", { extensionId: ENGINE, srcId: 40, requiredEventTypes: ["word"] });
  await until(() => dispatched.some((d) => d.event === "ttsEngine.onSpeak"), "the engine's onSpeak");
  const speak = dispatched.find((d) => d.event === "ttsEngine.onSpeak");
  assert.deepEqual(
    dispatched.filter((d) => d.event.startsWith("ttsEngine.")).map((d) => d.id),
    [ENGINE],
  );
  const requestId = speak.args[2];
  assert.equal(speak.args[1].extensionId, ENGINE);
  assert.equal(speak.args[1].srcId, undefined);
  assert.equal(speak.args[1].requiredEventTypes, undefined);

  await call(OTHER, "ttsEngine.updateVoices", [{ voiceName: "Other", eventTypes: ["end"] }]);
  await call(OTHER, "ttsEngine.sendTtsEvent", requestId, { type: "end" });
  assert.equal(await call(SPEAKER, "tts.isSpeaking"), true);

  await call(ENGINE, "ttsEngine.sendTtsEvent", requestId, { type: "word", charIndex: 4, length: 3 });
  await call(ENGINE, "ttsEngine.sendTtsEvent", requestId, { type: "end", charIndex: 18 });
  assert.deepEqual(eventsFor(SPEAKER), [
    { charIndex: 4, isFinalEvent: false, length: 3, srcId: 40, type: "word" },
    { charIndex: 18, isFinalEvent: true, srcId: 40, type: "end" },
  ]);
  assert.equal(await call(SPEAKER, "tts.isSpeaking"), false);
  await call(ENGINE, "ttsEngine.sendTtsEvent", requestId, { type: "end" });
  assert.equal(eventsFor(SPEAKER).length, 2);
});

test("an engine that only listens for speak, or lacks the permission, never gets an utterance", async () => {
  await idle();
  reset();
  await call(SPEAKER, "tts.speak", "half", { voiceName: "Half Engine", srcId: 50 });
  await until(() => eventsFor(SPEAKER).some((e) => e.type === "end"), "the system voice's end");
  await call(SPEAKER, "tts.speak", "none", { extensionId: NO_PERMISSION, srcId: 51 });
  await until(() => eventsFor(SPEAKER).some((e) => e.srcId === 51 && e.type === "end"), "the system voice's end");
  assert.deepEqual(dispatched.filter((d) => d.event.startsWith("ttsEngine.")), []);
});

test("calls without the tts or ttsEngine permission are refused", async () => {
  await assert.rejects(async () => call(NO_PERMISSION, "tts.speak", "x"), { message: "'tts' permission is required to use chrome.tts.speak" });
  await assert.rejects(async () => call(NO_PERMISSION, "tts.getVoices"), /'tts' permission is required/);
  await assert.rejects(async () => call(SPEAKER, "ttsEngine.updateVoices", []), {
    message: "'ttsEngine' permission is required to use chrome.ttsEngine.updateVoices",
  });
  await assert.rejects(async () => call(SPEAKER, "ttsEngine.sendTtsEvent", 1, { type: "end" }), /'ttsEngine' permission is required/);
});

test("bad arguments get Chrome's errors", async () => {
  const fails = (id, method, args, message) => assert.rejects(async () => call(id, method, ...args), { message });
  await fails(SPEAKER, "tts.speak", ["x".repeat(32769)], "Utterance length is too long.");
  await fails(SPEAKER, "tts.speak", ["é".repeat(16385)], "Utterance length is too long.");
  await fails(SPEAKER, "tts.speak", ["x", { lang: "x" }], "Invalid lang.");
  await fails(SPEAKER, "tts.speak", ["x", { rate: 10.5 }], "Invalid rate.");
  await fails(SPEAKER, "tts.speak", ["x", { pitch: 2.5 }], "Invalid pitch.");
  await fails(SPEAKER, "tts.speak", ["x", { volume: -0.1 }], "Invalid volume.");
  await fails(OTHER, "ttsEngine.updateVoices", [[{ voiceName: "v", lang: "not a tag" }]], "Invalid lang.");
  await fails(OTHER, "ttsEngine.updateVoices", [[{ voiceName: "v", extensionId: ENGINE }]], "Extension id mismatch.");
  await fails(ENGINE, "ttsEngine.sendTtsEvent", [1, { type: "sentence" }], "Cannot send an event type that is not declared in the extension manifest.");
  await call(SPEAKER, "tts.speak", "x".repeat(32768));
  await call(SPEAKER, "tts.stop");
});

test("updateVoices replaces the manifest's voices and tells listeners with the tts permission", async () => {
  reset();
  await call(ENGINE, "ttsEngine.updateVoices", [{ voiceName: "Renamed", lang: "de-DE", eventTypes: ["end", "sentence"] }]);
  assert.deepEqual(dispatched, [{ id: SPEAKER, event: "tts.onVoicesChanged", args: [] }]);
  const voices = await call(SPEAKER, "tts.getVoices");
  assert.deepEqual(voices.at(-1), {
    eventTypes: ["end", "sentence", "interrupted", "cancelled"],
    extensionId: ENGINE,
    lang: "de-DE",
    remote: false,
    voiceName: "Renamed",
  });
  await call(ENGINE, "ttsEngine.sendTtsEvent", 1, { type: "sentence" });
  await assert.rejects(async () => call(ENGINE, "ttsEngine.sendTtsEvent", 1, { type: "word" }), /not declared/);
});

test("an extension going away stops its speech", async () => {
  await idle();
  reset();
  await call(SPEAKER, "tts.speak", "a b c d e f", { srcId: 60 });
  await until(() => eventsFor(SPEAKER).length > 0, "start");
  for (const unload of unloads) unload(SPEAKER);
  assert.equal(controller.isSpeaking(), false);
  assert.equal(eventsFor(SPEAKER).at(-1).type, "interrupted");
});

test("speech waits for the system voices to load, and a speak that doesn't enqueue cancels what waited", async () => {
  let release;
  const platform = new SilentSpeech([], 1);
  platform.voices = () => new Promise((resolve) => (release = () => resolve([])));
  const events = [];
  const engines = { voices: () => [], speak() {}, stop() {}, pause() {}, resume() {} };
  const local = new TtsController(() => platform, engines, () => "en-US");
  const request = (text, enqueue) => ({
    text,
    voiceName: "",
    lang: "",
    rate: null,
    pitch: null,
    volume: null,
    enqueue,
    requiredEventTypes: new Set(),
    desiredEventTypes: new Set(),
    engineId: "",
    options: {},
    source: SPEAKER,
  });
  const listener = (utterance, type) => events.push(`${utterance.request.text}:${type}`);
  local.speakOrEnqueue(local.create(request("first", true), listener));
  local.speakOrEnqueue(local.create(request("second", false), listener));
  assert.deepEqual(events, ["first:cancelled"]);
  release();
  await until(() => events.includes("second:end"), "the second utterance");
  assert.deepEqual(events, ["first:cancelled", "second:start", "second:word", "second:end"]);
});
