import { app } from "electron";
import type { ServiceWorkerMain } from "electron";

import { extensionTtsVoices, setExtensionTtsVoices } from "shared";

import type { LoadedExtension } from "../loaded";
import type { Caller } from "../router";
import type { ExtensionService } from "../service";
import { speechPlatform } from "../speech";
import { TtsController, isEventType, isLanguageTag, sortedEventTypes } from "../tts";
import type { SpeechEngines, TtsEventType, UtteranceListener, VoiceData } from "../tts";

// Chrome's own errors, from chrome/browser/speech/extension_api/tts_extension_api_constants.h.
const UTTERANCE_TOO_LONG = "Utterance length is too long.";
const INVALID_LANG = "Invalid lang.";
const INVALID_RATE = "Invalid rate.";
const INVALID_PITCH = "Invalid pitch.";
const INVALID_VOLUME = "Invalid volume.";
const EXTENSION_ID_MISMATCH = "Extension id mismatch.";
const UNDECLARED_EVENT_TYPE = "Cannot send an event type that is not declared in the extension manifest.";

const MAX_UTTERANCE_BYTES = 32768;

// Chrome drops the calling renderer for arguments its own bindings would have
// refused, so only a caller going around chrome.* gets this.
function invalidArguments(): Error {
  // fixme: placeholder copy
  return new Error("Invalid arguments.");
}

interface EngineVoice {
  voiceName: string;
  lang: string;
  remote: boolean;
  eventTypes: string[];
}

type Options = Record<string, unknown>;

function isObject(value: unknown): value is Options {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function present(options: Options, key: string): boolean {
  return options[key] !== undefined && options[key] !== null;
}

function optionalString(options: Options, key: string): string {
  if (!present(options, key)) return "";
  if (typeof options[key] !== "string") throw invalidArguments();
  return options[key];
}

function optionalNumber(options: Options, key: string, min: number, max: number, error: string): number | null {
  if (!present(options, key)) return null;
  const value = options[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidArguments();
  if (value < min || value > max) throw new Error(error);
  return value;
}

function eventTypeSet(options: Options, key: string): Set<TtsEventType> {
  if (!present(options, key)) return new Set();
  const list = options[key];
  if (!Array.isArray(list)) throw invalidArguments();
  return new Set(list.filter(isEventType));
}

// ValidateAndConvertToTtsVoiceVector in Chrome's tts_engine_extension_api.cc.
function validateVoices(extension: LoadedExtension, list: unknown[], stopAtFirstError: boolean): { voices: EngineVoice[]; error: string | null } {
  const voices: EngineVoice[] = [];
  let error: string | null = null;
  for (const item of list) {
    if (!isObject(item)) continue;
    let lang = "";
    if (present(item, "lang")) {
      lang = typeof item.lang === "string" ? item.lang : "";
      if (!isLanguageTag(lang)) {
        error = INVALID_LANG;
        if (stopAtFirstError) return { voices: [], error };
        continue;
      }
    }
    if (present(item, "extensionId") && item.extensionId !== extension.id) {
      error = EXTENSION_ID_MISMATCH;
      if (stopAtFirstError) return { voices: [], error };
      continue;
    }
    voices.push({
      voiceName: typeof item.voiceName === "string" ? item.voiceName : "",
      lang,
      remote: item.remote === true,
      eventTypes: Array.isArray(item.eventTypes) ? item.eventTypes.map((type) => (typeof type === "string" ? type : "")) : [],
    });
  }
  return { voices, error };
}

function manifestVoices(extension: LoadedExtension): EngineVoice[] {
  const engine = (extension.manifest as { tts_engine?: unknown }).tts_engine;
  const voices = isObject(engine) && Array.isArray(engine.voices) ? engine.voices : [];
  return voices.filter(isObject).map((voice) => ({
    voiceName: typeof voice.voice_name === "string" ? voice.voice_name : "",
    lang: typeof voice.lang === "string" ? voice.lang : "",
    remote: voice.remote === true,
    eventTypes: Array.isArray(voice.event_types) ? voice.event_types.filter((type): type is string => typeof type === "string") : [],
  }));
}

// An engine's voices are the ones it last set with updateVoices, or else its manifest's.
function engineVoices(extension: LoadedExtension): EngineVoice[] {
  const stored = extensionTtsVoices(extension.id);
  return stored ? validateVoices(extension, stored, false).voices : manifestVoices(extension);
}

function voiceInfo(voice: VoiceData): Record<string, unknown> {
  const info: Record<string, unknown> = { eventTypes: sortedEventTypes(voice.events) };
  if (voice.engineId) info.extensionId = voice.engineId;
  if (voice.lang) info.lang = voice.lang;
  info.remote = voice.remote;
  info.voiceName = voice.name;
  return info;
}

type Speaker =
  | { kind: "frame"; processId: number; routingId: number }
  | { kind: "worker"; worker: ServiceWorkerMain };

function speakerOf(caller: Caller): Speaker {
  if (caller.kind === "worker") return { kind: "worker", worker: caller.worker };
  return { kind: "frame", processId: caller.frame.processId, routingId: caller.frame.routingId };
}

export function installTts(service: ExtensionService): TtsController {
  const { router } = service;

  const engine = (id: string) => {
    const extension = service.get(id);
    return extension?.hasApiPermission("ttsEngine") ? extension : null;
  };
  const listens = (id: string, event: string) => service.events.hasListener(id, `ttsEngine.${event}`);

  const engines: SpeechEngines = {
    // TtsExtensionEngine::GetVoices: only an engine listening for both speak and stop can be picked.
    voices() {
      const voices: VoiceData[] = [];
      for (const extension of service.loaded.values()) {
        if (!extension.hasApiPermission("ttsEngine")) continue;
        if (!(listens(extension.id, "onSpeak") || listens(extension.id, "onSpeakWithAudioStream")) || !listens(extension.id, "onStop")) continue;
        for (const voice of engineVoices(extension)) {
          const events = new Set(voice.eventTypes.filter(isEventType));
          if (events.has("end")) {
            events.add("cancelled");
            events.add("interrupted");
          }
          voices.push({ name: voice.voiceName, lang: voice.lang, remote: voice.remote, engineId: extension.id, native: false, events });
        }
      }
      return voices;
    },
    speak(engineId, text, options, utteranceId) {
      if (!engine(engineId) || !listens(engineId, "onSpeak")) return;
      service.dispatch(engineId, "ttsEngine.onSpeak", [text, options, utteranceId]);
    },
    stop(engineId) {
      if (engine(engineId)) service.dispatch(engineId, "ttsEngine.onStop", []);
    },
    pause(engineId) {
      if (engine(engineId)) service.dispatch(engineId, "ttsEngine.onPause", []);
    },
    resume(engineId) {
      if (engine(engineId)) service.dispatch(engineId, "ttsEngine.onResume", []);
    },
  };

  const controller = new TtsController(speechPlatform, engines, () => app.getLocale());

  controller.voicesChanged.add(() =>
    service.broadcast("tts.onVoicesChanged", (extension) => (extension.hasApiPermission("tts") ? [] : null)),
  );

  // Events about an utterance go back to the page or worker that spoke it,
  // where chrome.tts.speak's onEvent callback waits for them.
  const listenerFor = (speaker: Speaker, srcId: number, desired: Set<TtsEventType>): UtteranceListener => {
    return (utterance, type, charIndex, length, errorMessage) => {
      if (desired.size > 0 && !desired.has(type)) return;
      const details: Record<string, unknown> = {};
      if (charIndex >= 0) details.charIndex = charIndex;
      if (type === "error") details.errorMessage = errorMessage;
      details.isFinalEvent = utterance.finished;
      if (length >= 0) details.length = length;
      details.srcId = srcId;
      details.type = type;
      if (speaker.kind === "worker") service.events.sendToWorker(speaker.worker, "tts.onEvent", [details]);
      else service.events.sendToFrame(speaker, "tts.onEvent", [details]);
    };
  };

  // Like Chrome, a worker waiting for its utterance's events stays awake until the last one.
  const keepAwake = (speaker: Speaker): (() => void) => {
    if (speaker.kind !== "worker") return () => {};
    try {
      const task = speaker.worker.startTask();
      return () => {
        try {
          task.end();
        } catch {}
      };
    } catch {
      return () => {};
    }
  };

  router.handle(
    "tts.speak",
    (caller, text, raw) => {
      if (typeof text !== "string") throw invalidArguments();
      const options = raw === undefined || raw === null ? {} : raw;
      if (!isObject(options)) throw invalidArguments();
      if (Buffer.byteLength(text, "utf8") > MAX_UTTERANCE_BYTES) throw new Error(UTTERANCE_TOO_LONG);
      const voiceName = optionalString(options, "voiceName");
      const lang = optionalString(options, "lang");
      if (lang && !isLanguageTag(lang)) throw new Error(INVALID_LANG);
      const rate = optionalNumber(options, "rate", 0.1, 10, INVALID_RATE);
      const pitch = optionalNumber(options, "pitch", 0, 2, INVALID_PITCH);
      const volume = optionalNumber(options, "volume", 0, 1, INVALID_VOLUME);
      if (present(options, "enqueue") && typeof options.enqueue !== "boolean") throw invalidArguments();
      const requiredEventTypes = eventTypeSet(options, "requiredEventTypes");
      const desiredEventTypes = eventTypeSet(options, "desiredEventTypes");
      const engineId = optionalString(options, "extensionId");
      if (present(options, "srcId") && !Number.isInteger(options.srcId)) throw invalidArguments();
      const srcId = present(options, "srcId") ? (options.srcId as number) : -1;
      const speaker = speakerOf(caller);
      const listener = srcId >= 0 ? listenerFor(speaker, srcId, desiredEventTypes) : null;
      const utterance = controller.create(
        {
          text,
          voiceName,
          lang,
          rate,
          pitch,
          volume,
          enqueue: options.enqueue === true,
          requiredEventTypes,
          desiredEventTypes,
          engineId,
          options,
          source: caller.extension.id,
        },
        listener,
      );
      if (listener) utterance.whenFinished(keepAwake(speaker));
      // Like Chrome, the call answers before any of the utterance's events.
      setImmediate(() => controller.speakOrEnqueue(utterance));
    },
    { permission: "tts" },
  );
  router.handle("tts.stop", (caller) => controller.stop(caller.extension.id), { permission: "tts" });
  router.handle("tts.pause", () => controller.pause(), { permission: "tts" });
  router.handle("tts.resume", () => controller.resume(), { permission: "tts" });
  router.handle("tts.isSpeaking", () => controller.isSpeaking(), { permission: "tts" });
  router.handle("tts.getVoices", async () => (await controller.getVoices()).map(voiceInfo), { permission: "tts" });

  router.handle(
    "ttsEngine.updateVoices",
    (caller, voices) => {
      if (!Array.isArray(voices)) throw invalidArguments();
      const { error } = validateVoices(caller.extension, voices, true);
      if (error) throw new Error(error);
      setExtensionTtsVoices(caller.extension.id, voices);
      controller.enginesChanged();
    },
    { permission: "ttsEngine" },
  );

  router.handle(
    "ttsEngine.sendTtsEvent",
    (caller, requestId, event) => {
      if (!Number.isInteger(requestId) || !isObject(event) || typeof event.type !== "string") throw invalidArguments();
      if (present(event, "charIndex") && !Number.isInteger(event.charIndex)) throw invalidArguments();
      if (present(event, "length") && !Number.isInteger(event.length)) throw invalidArguments();
      const type = event.type;
      if (!engineVoices(caller.extension).some((voice) => voice.eventTypes.includes(type))) throw new Error(UNDECLARED_EVENT_TYPE);
      if (!isEventType(type) || type === "interrupted" || type === "cancelled") throw invalidArguments();
      const errorMessage = type === "error" && typeof event.errorMessage === "string" ? event.errorMessage : "";
      const charIndex = present(event, "charIndex") ? (event.charIndex as number) : 0;
      const length = present(event, "length") ? (event.length as number) : -1;
      controller.engineEvent(caller.extension.id, requestId as number, type, charIndex, length, errorMessage);
    },
    { permission: "ttsEngine" },
  );

  // Only ChromeOS has voice packs to install, so like Chrome elsewhere nothing listens for their status.
  router.handle(
    "ttsEngine.updateLanguage",
    (_caller, status) => {
      if (!isObject(status) || typeof status.lang !== "string" || typeof status.installStatus !== "string") throw invalidArguments();
    },
    { permission: "ttsEngine" },
  );

  service.onUnload((id) => controller.removeExtension(id));
  return controller;
}
