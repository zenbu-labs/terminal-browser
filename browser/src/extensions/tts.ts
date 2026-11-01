import { Listeners } from "../browsing/listeners";

// Chrome's speech queue (content/browser/speech/tts_controller_impl.cc): one
// utterance speaks at a time, through the system voices or an extension's
// ttsEngine, and the extension that asked to speak hears how it goes.

export const EVENT_TYPES = [
  "start",
  "end",
  "word",
  "sentence",
  "marker",
  "interrupted",
  "cancelled",
  "error",
  "pause",
  "resume",
] as const;
export type TtsEventType = (typeof EVENT_TYPES)[number];

const FINAL_EVENTS = new Set<TtsEventType>(["end", "interrupted", "cancelled", "error"]);
const DEFAULT_PARAMETER = 1;

export function isEventType(value: unknown): value is TtsEventType {
  return (EVENT_TYPES as readonly unknown[]).includes(value);
}

export function sortedEventTypes(types: Iterable<TtsEventType>): TtsEventType[] {
  const set = new Set(types);
  return EVENT_TYPES.filter((type) => set.has(type));
}

// What Chrome's base::i18n::LanguageTagConverter accepts: a BCP 47 tag of at
// least two characters, with legacy underscores allowed.
export function isLanguageTag(tag: string): boolean {
  if (tag.length < 2) return false;
  try {
    return Intl.getCanonicalLocales(tag.replaceAll("_", "-")).length === 1;
  } catch {
    return false;
  }
}

export interface VoiceData {
  name: string;
  lang: string;
  remote: boolean;
  // The extension speaking this voice, or "" for a system voice.
  engineId: string;
  native: boolean;
  events: Set<TtsEventType>;
}

export interface UtteranceRequest {
  text: string;
  voiceName: string;
  lang: string;
  rate: number | null;
  pitch: number | null;
  volume: number | null;
  enqueue: boolean;
  requiredEventTypes: Set<TtsEventType>;
  desiredEventTypes: Set<TtsEventType>;
  // options.extensionId: only voices of this engine may speak it.
  engineId: string;
  // The options as the caller passed them, handed on to a ttsEngine.
  options: Record<string, unknown>;
  // The extension that called speak.
  source: string;
}

export type UtteranceListener = (
  utterance: Utterance,
  type: TtsEventType,
  charIndex: number,
  length: number,
  errorMessage: string,
) => void;

export class Utterance {
  finished = false;
  private readonly finishListeners: (() => void)[] = [];
  // The ttsEngine extension speaking this utterance, or null for a system voice.
  speakingEngine: string | null = null;
  rate: number;
  pitch: number;
  volume: number;

  constructor(
    readonly id: number,
    readonly request: UtteranceRequest,
    private readonly listener: UtteranceListener | null,
  ) {
    this.rate = request.rate ?? DEFAULT_PARAMETER;
    this.pitch = request.pitch ?? DEFAULT_PARAMETER;
    this.volume = request.volume ?? DEFAULT_PARAMETER;
  }

  event(type: TtsEventType, charIndex: number, length: number, errorMessage: string) {
    if (FINAL_EVENTS.has(type)) this.finish();
    this.listener?.(this, type, charIndex, length, errorMessage);
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    for (const listener of this.finishListeners.splice(0)) listener();
  }

  whenFinished(listener: () => void) {
    if (this.finished) listener();
    else this.finishListeners.push(listener);
  }
}

export type PlatformEmit = (type: TtsEventType, charIndex: number, length: number, errorMessage: string) => void;

export interface PlatformSpeech {
  id: number;
  text: string;
  lang: string;
  voiceName: string;
  rate: number;
  pitch: number;
  volume: number;
}

// The system's own speech, like Chrome's TtsPlatform.
export interface SpeechPlatform {
  voices(): Promise<VoiceData[]>;
  speak(speech: PlatformSpeech, emit: PlatformEmit): void;
  stop(): void;
  pause(): void;
  resume(): void;
  isSpeaking(): boolean;
  readonly voicesChanged: Listeners<[]>;
}

// Extensions that speak through chrome.ttsEngine.
export interface SpeechEngines {
  voices(): VoiceData[];
  speak(engineId: string, text: string, options: Record<string, unknown>, utteranceId: number): void;
  stop(engineId: string): void;
  pause(engineId: string): void;
  resume(engineId: string): void;
}

export class TtsController {
  readonly voicesChanged = new Listeners<[]>();
  private current: Utterance | null = null;
  private queue: Utterance[] = [];
  private paused = false;
  private nextId = 1;
  // The system speech in use, and its voices once they loaded.
  private system: SpeechPlatform | null = null;
  private platformVoices: VoiceData[] | null = null;
  private platformReady: Promise<void> = Promise.resolve();

  constructor(
    private readonly platform: () => SpeechPlatform,
    private readonly engines: SpeechEngines,
    private readonly appLocale: () => string,
  ) {}

  create(request: UtteranceRequest, listener: UtteranceListener | null): Utterance {
    return new Utterance(this.nextId++, request, listener);
  }

  async getVoices(): Promise<VoiceData[]> {
    await this.loadPlatform();
    return this.voices();
  }

  isSpeaking(): boolean {
    return this.current !== null || (this.system?.isSpeaking() ?? false);
  }

  speakOrEnqueue(utterance: Utterance) {
    if (this.platformVoices === null) {
      void this.loadPlatform();
      if (!utterance.request.enqueue) this.clearQueue(true);
      this.queue.push(utterance);
      return;
    }
    if (this.paused && !utterance.request.enqueue) {
      this.stop();
      this.queue.push(utterance);
      this.paused = true;
      return;
    }
    if (this.paused || (this.isSpeaking() && utterance.request.enqueue)) {
      this.queue.push(utterance);
    } else {
      this.stop();
      this.speakNow(utterance);
    }
  }

  // Like Chrome, an extension only stops speech it started itself, but
  // without a source everything stops.
  stop(source?: string) {
    this.paused = false;
    if (source !== undefined && this.current && this.current.request.source !== source) return;
    this.stopCurrent();
    this.clearQueue(true);
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    const current = this.current;
    if (current?.speakingEngine) this.engines.pause(current.speakingEngine);
    else if (current) this.system?.pause();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    const current = this.current;
    if (current?.speakingEngine) this.engines.resume(current.speakingEngine);
    else if (current) this.system?.resume();
    else this.speakNext();
  }

  // An event from a ttsEngine extension about the utterance it is speaking.
  engineEvent(engineId: string, utteranceId: number, type: TtsEventType, charIndex: number, length: number, errorMessage: string) {
    if (this.current?.speakingEngine !== engineId) return;
    this.onEvent(utteranceId, type, charIndex, length, errorMessage);
  }

  // An engine's voices changed (chrome.ttsEngine.updateVoices).
  enginesChanged() {
    if (this.platformVoices === null) return;
    this.voicesChanged.emit();
    if (!this.current && this.queue.length > 0) this.speakNext();
  }

  // An extension went away: its queued speech is dropped and its current speech stops.
  removeExtension(id: string) {
    const involves = (utterance: Utterance) => utterance.request.source === id || utterance.speakingEngine === id;
    for (const utterance of this.queue.filter(involves)) utterance.finish();
    this.queue = this.queue.filter((utterance) => !involves(utterance));
    if (this.current && involves(this.current)) {
      this.stopCurrent();
      this.speakNext();
    }
  }

  private voices(): VoiceData[] {
    return [...(this.platformVoices ?? []), ...this.engines.voices()];
  }

  private loadPlatform(): Promise<void> {
    const platform = this.platform();
    if (this.system !== platform) {
      this.system = platform;
      this.platformVoices = null;
      this.platformReady = this.refreshPlatform(platform);
      platform.voicesChanged.add(() => void this.refreshPlatform(platform));
    }
    return this.platformReady;
  }

  private async refreshPlatform(platform: SpeechPlatform) {
    const voices = await platform.voices().catch(() => []);
    if (this.system !== platform) return;
    this.platformVoices = voices;
    this.voicesChanged.emit();
    if (!this.current && this.queue.length > 0) this.speakNext();
  }

  private speakNow(utterance: Utterance) {
    const voices = this.voices();
    const index = this.matchingVoice(utterance.request, voices);
    const voice: VoiceData =
      index >= 0
        ? voices[index]
        : {
            native: true,
            engineId: utterance.request.engineId,
            name: utterance.request.voiceName,
            lang: utterance.request.lang,
            remote: false,
            events: new Set(),
          };
    this.current = utterance;
    if (!voice.native) {
      utterance.speakingEngine = voice.engineId;
      this.engines.speak(voice.engineId, utterance.request.text, this.engineOptions(utterance, voice), utterance.id);
      if (!voice.events.has("end")) {
        utterance.finish();
        this.current = null;
        this.speakNext();
      }
      return;
    }
    this.system!.speak(
      {
        id: utterance.id,
        text: utterance.request.text,
        lang: utterance.request.lang,
        voiceName: voice.name,
        rate: utterance.rate,
        pitch: utterance.pitch,
        volume: utterance.volume,
      },
      (type, charIndex, length, errorMessage) => this.onEvent(utterance.id, type, charIndex, length, errorMessage),
    );
  }

  private onEvent(utteranceId: number, type: TtsEventType, charIndex: number, length: number, errorMessage: string) {
    const current = this.current;
    if (!current || current.id !== utteranceId) return;
    current.event(type, charIndex, length, errorMessage);
    if (current.finished && this.current === current) {
      this.current = null;
      this.speakNext();
    }
  }

  private stopCurrent() {
    const current = this.current;
    if (current?.speakingEngine) this.engines.stop(current.speakingEngine);
    else this.system?.stop();
    if (!current) return;
    this.current = null;
    if (!current.finished) current.event("interrupted", -1, -1, "");
  }

  private clearQueue(sendEvents: boolean) {
    const queued = this.queue;
    this.queue = [];
    for (const utterance of queued) {
      if (sendEvents) utterance.event("cancelled", -1, -1, "");
      else utterance.finish();
    }
  }

  private speakNext() {
    if (this.paused) return;
    while (this.queue.length > 0 && !this.current) this.speakNow(this.queue.shift()!);
  }

  // Chrome's ttsEngine.onSpeak options: what the caller passed, minus what the
  // queue handles itself, plus the voice and parameters the queue picked.
  private engineOptions(utterance: Utterance, voice: VoiceData): Record<string, unknown> {
    const options: Record<string, unknown> = { ...utterance.request.options };
    for (const key of ["requiredEventTypes", "desiredEventTypes", "srcId", "isFinalEvent", "onEvent"]) delete options[key];
    if (voice.events.has("end")) delete options.enqueue;
    options.rate ??= utterance.rate;
    options.pitch ??= utterance.pitch;
    options.volume ??= utterance.volume;
    options.voiceName ??= voice.name;
    options.lang ??= voice.lang;
    return Object.fromEntries(Object.keys(options).sort().map((key) => [key, options[key]]));
  }

  // TtsControllerImpl::GetMatchingVoice: an exact engine and name are
  // required, then the utterance's language, required event types and the
  // browser's language each make a voice a better match.
  private matchingVoice(request: UtteranceRequest, voices: VoiceData[]): number {
    const appLang = this.appLocale();
    let bestScore = -1;
    let bestIndex = -1;
    voices.forEach((voice, index) => {
      if (request.engineId && request.engineId !== voice.engineId) return;
      if (request.voiceName && voice.name !== request.voiceName) return;
      let score = 0;
      if (voice.lang && request.lang) {
        const [voiceLanguage, voiceCountry] = splitLocale(voice.lang);
        const [language, country] = splitLocale(request.lang);
        if (
          voiceLanguage === language &&
          (voiceCountry === country || (!country && voiceLanguage === voiceCountry) || (!voiceCountry && language === country))
        ) {
          score += 128;
        } else if (voiceLanguage === language) {
          score += 64;
        }
      }
      if (request.requiredEventTypes.size > 0 && [...request.requiredEventTypes].every((type) => voice.events.has(type))) {
        score += 32;
      }
      if (voice.lang) {
        if (voice.lang === appLang) score += 2;
        else if (splitLocale(voice.lang)[0] === splitLocale(appLang)[0]) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    return bestIndex;
  }
}

function splitLocale(locale: string): [string, string] {
  const [language = "", country = ""] = locale.toLowerCase().split(/[-_]/);
  return [language, country];
}

// Speaks nothing: every utterance runs through start, word and end events on
// timers. Tests use it so nothing ever plays through the speakers.
export class SilentSpeech implements SpeechPlatform {
  readonly voicesChanged = new Listeners<[]>();
  private speaking: { id: number; timer: ReturnType<typeof setTimeout> | null; steps: (() => void)[]; emit: PlatformEmit; charIndex: number } | null = null;

  constructor(
    private readonly voiceList: { name: string; lang: string }[] = [],
    private readonly stepMs = 5,
  ) {}

  async voices(): Promise<VoiceData[]> {
    return this.voiceList.map((voice) => ({
      ...voice,
      remote: false,
      engineId: "",
      native: true,
      events: new Set<TtsEventType>(["start", "end", "word", "pause", "resume"]),
    }));
  }

  speak(speech: PlatformSpeech, emit: PlatformEmit) {
    this.stop();
    const steps: (() => void)[] = [() => emit("start", 0, -1, "")];
    for (const match of speech.text.matchAll(/\S+/g)) {
      steps.push(() => {
        if (this.speaking) this.speaking.charIndex = match.index;
        emit("word", match.index, match[0].length, "");
      });
    }
    steps.push(() => {
      this.speaking = null;
      emit("end", speech.text.length, -1, "");
    });
    this.speaking = { id: speech.id, timer: null, steps, emit, charIndex: 0 };
    this.next();
  }

  stop() {
    if (this.speaking?.timer) clearTimeout(this.speaking.timer);
    this.speaking = null;
  }

  pause() {
    const speaking = this.speaking;
    if (!speaking?.timer) return;
    clearTimeout(speaking.timer);
    speaking.timer = null;
    speaking.emit("pause", speaking.charIndex, -1, "");
  }

  resume() {
    const speaking = this.speaking;
    if (!speaking || speaking.timer) return;
    speaking.emit("resume", speaking.charIndex, -1, "");
    this.next();
  }

  isSpeaking(): boolean {
    return this.speaking !== null;
  }

  private next() {
    const speaking = this.speaking;
    if (!speaking) return;
    speaking.timer = setTimeout(() => {
      speaking.timer = null;
      if (this.speaking !== speaking) return;
      speaking.steps.shift()?.();
      if (this.speaking === speaking) this.next();
    }, this.stepMs);
  }
}
