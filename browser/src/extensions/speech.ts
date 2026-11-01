import { BrowserWindow, session as electronSession } from "electron";

import { Listeners } from "../browsing/listeners";
import type { PlatformEmit, PlatformSpeech, SpeechPlatform, TtsEventType, VoiceData } from "./tts";
import { SilentSpeech, isEventType } from "./tts";

export { SilentSpeech };

// The voices and events Chromium's macOS speech (content/browser/speech/tts_mac.mm) reports.
const SYSTEM_VOICE_EVENTS: TtsEventType[] = ["start", "end", "word", "pause", "resume"];

// Runs in a hidden page and drives the Web Speech API there, which Chromium
// speaks with the system's voices. The main process collects its events by
// waiting on next().
const PAGE_SCRIPT = `globalThis.tbSpeech = (() => {
  const pending = [];
  let wake = null;
  // macOS drops the word events of an utterance spoken right after a cancel,
  // so speech waits a moment after one.
  let quietUntil = 0;
  let generation = 0;
  const push = (event) => {
    pending.push(event);
    if (wake) wake();
  };
  const voiceList = () => speechSynthesis.getVoices().map((voice) => ({ name: voice.name, lang: voice.lang }));
  speechSynthesis.addEventListener("voiceschanged", () => push({ type: "voiceschanged" }));
  return {
    voices() {
      const now = voiceList();
      if (now.length > 0) return Promise.resolve(now);
      return new Promise((resolve) => {
        const done = () => resolve(voiceList());
        speechSynthesis.addEventListener("voiceschanged", done, { once: true });
        setTimeout(done, 2000);
      });
    },
    speak(id, text, voiceName, lang, rate, pitch, volume) {
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = speechSynthesis.getVoices().find((candidate) => candidate.name === voiceName);
      if (voice) utterance.voice = voice;
      if (lang) utterance.lang = lang;
      utterance.rate = rate;
      utterance.pitch = pitch;
      utterance.volume = volume;
      const send = (type, charIndex, length, errorMessage) => push({ id, type, charIndex, length, errorMessage });
      utterance.onstart = () => send("start", 0, -1, "");
      utterance.onboundary = (event) => send(event.name === "sentence" ? "sentence" : "word", event.charIndex, event.charLength || -1, "");
      utterance.onpause = (event) => send("pause", event.charIndex, -1, "");
      utterance.onresume = (event) => send("resume", event.charIndex, -1, "");
      utterance.onend = () => send("end", text.length, -1, "");
      utterance.onerror = (event) => send("error", -1, -1, event.error);
      const at = generation;
      setTimeout(() => {
        if (at === generation) speechSynthesis.speak(utterance);
      }, Math.max(0, quietUntil - performance.now()));
    },
    stop: () => {
      generation++;
      quietUntil = performance.now() + 50;
      speechSynthesis.cancel();
    },
    pause: () => speechSynthesis.pause(),
    resume: () => speechSynthesis.resume(),
    next() {
      if (pending.length > 0) return Promise.resolve(pending.splice(0));
      return new Promise((resolve) => {
        wake = () => {
          wake = null;
          resolve(pending.splice(0));
        };
      });
    },
  };
})();
undefined;`;

interface PageEvent {
  id?: number;
  type: string;
  charIndex?: number;
  length?: number;
  errorMessage?: string;
}

// The system's voices through Chromium's own speech support, like Chrome's
// platform speech, in a hidden page of its own session.
export class SystemSpeech implements SpeechPlatform {
  readonly voicesChanged = new Listeners<[]>();
  private page: Promise<BrowserWindow> | null = null;
  private speaking: { id: number; emit: PlatformEmit } | null = null;

  async voices(): Promise<VoiceData[]> {
    const voices = (await this.run("tbSpeech.voices()")) as { name: string; lang: string }[];
    return voices.map((voice) => ({
      name: voice.name,
      lang: voice.lang,
      remote: false,
      engineId: "",
      native: true,
      events: new Set(SYSTEM_VOICE_EVENTS),
    }));
  }

  speak(speech: PlatformSpeech, emit: PlatformEmit) {
    this.speaking = { id: speech.id, emit };
    const args = [speech.id, speech.text, speech.voiceName, speech.lang, speech.rate, speech.pitch, speech.volume];
    this.run(`tbSpeech.speak(...${JSON.stringify(args)})`).catch((error: Error) => {
      if (this.speaking?.id !== speech.id) return;
      this.speaking = null;
      emit("error", -1, -1, error.message);
    });
  }

  stop() {
    this.speaking = null;
    if (this.page) void this.run("tbSpeech.stop()").catch(() => {});
  }

  pause() {
    if (this.speaking) void this.run("tbSpeech.pause()").catch(() => {});
  }

  resume() {
    if (this.speaking) void this.run("tbSpeech.resume()").catch(() => {});
  }

  isSpeaking(): boolean {
    return this.speaking !== null;
  }

  private async run(expression: string): Promise<unknown> {
    const page = await this.open();
    return page.webContents.executeJavaScript(expression, true);
  }

  private open(): Promise<BrowserWindow> {
    this.page ??= (async () => {
      const page = new BrowserWindow({
        show: false,
        webPreferences: {
          session: electronSession.fromPartition("tb-speech"),
          offscreen: true,
          sandbox: true,
          contextIsolation: true,
          backgroundThrottling: false,
        },
      });
      page.on("closed", () => {
        this.page = null;
        this.speaking = null;
      });
      await page.loadURL("about:blank");
      await page.webContents.executeJavaScript(PAGE_SCRIPT);
      void this.collect(page);
      return page;
    })();
    return this.page;
  }

  private async collect(page: BrowserWindow) {
    while (!page.isDestroyed()) {
      const events = (await page.webContents.executeJavaScript("tbSpeech.next()").catch(() => null)) as PageEvent[] | null;
      if (!events) return;
      for (const event of events) this.deliver(event);
    }
  }

  private deliver(event: PageEvent) {
    if (event.type === "voiceschanged") {
      this.voicesChanged.emit();
      return;
    }
    const speaking = this.speaking;
    if (!speaking || speaking.id !== event.id || !isEventType(event.type)) return;
    if (event.type === "end" || event.type === "error") this.speaking = null;
    speaking.emit(event.type, event.charIndex ?? -1, event.length ?? -1, event.errorMessage ?? "");
  }
}

let platform: SpeechPlatform | null = null;

export function speechPlatform(): SpeechPlatform {
  platform ??= new SystemSpeech();
  return platform;
}

// Swaps the system speech, e.g. for SilentSpeech in automated runs that must never make a sound.
export function useSpeechPlatform(next: SpeechPlatform) {
  platform = next;
}
