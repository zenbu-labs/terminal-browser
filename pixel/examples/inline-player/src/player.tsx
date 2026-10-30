import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { Box, Path, Text, createRoot, makeTheme, useRect, useTerminalColors } from "@zenbu-labs/pixel";
import type { Color, EngineKeyEvent, NodeHandle, Surface } from "@zenbu-labs/pixel";

const FPS = 30;
const QUEUE_HIGH = 8;
const QUEUE_LOW = 3;
const SEEK_STEP = 5;

const file = process.argv[2];
if (!file) throw new Error("usage: inline-player <video>");

function probeDuration(video: string): number {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", video],
    { encoding: "utf8" },
  );
  return Number(out.trim()) || 0;
}

interface PlaybackState {
  playing: boolean;
  time: number;
  duration: number;
}

class Playback {
  private state: PlaybackState;
  private listeners = new Set<() => void>();
  private decoder: ChildProcess | null = null;
  private queue: Buffer[] = [];
  private frame: Buffer | null = null;
  private filled = 0;
  private startedAt = 0;
  private shown = 0;
  private decoderDone = false;
  private showNextWhilePaused = false;
  private size: { width: number; height: number } | null = null;
  private surface: Surface | null = null;
  private timer: NodeJS.Timeout;

  constructor(private readonly video: string) {
    this.state = { playing: true, time: 0, duration: probeDuration(video) };
    this.timer = setInterval(() => this.tick(), 1000 / FPS);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get = () => this.state;

  attach(surface: Surface, width: number, height: number) {
    this.surface = surface;
    if (this.size?.width === width && this.size.height === height) return;
    this.size = { width, height };
    this.decodeFrom(this.state.time);
  }

  toggle() {
    if (!this.state.playing && this.state.time >= this.state.duration - 1 / FPS) this.decodeFrom(0);
    this.update({ playing: !this.state.playing });
  }

  seek(time: number) {
    this.decodeFrom(Math.max(0, Math.min(time, this.state.duration)));
  }

  stop() {
    clearInterval(this.timer);
    this.decoder?.kill("SIGKILL");
  }

  private update(next: Partial<PlaybackState>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  private decodeFrom(time: number) {
    if (!this.size) return;
    this.decoder?.kill("SIGKILL");
    this.queue = [];
    this.frame = null;
    this.filled = 0;
    this.startedAt = time;
    this.shown = 0;
    this.decoderDone = false;
    this.showNextWhilePaused = true;
    this.update({ time });

    const { width, height } = this.size;
    const frameBytes = width * height * 4;
    const filter = `fps=${FPS},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
    const decoder = spawn(
      "ffmpeg",
      ["-v", "error", "-ss", String(time), "-i", this.video, "-an", "-vf", filter, "-pix_fmt", "bgra", "-f", "rawvideo", "pipe:1"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    this.decoder = decoder;
    decoder.stdout!.on("data", (chunk: Buffer) => {
      if (this.decoder !== decoder) return;
      let offset = 0;
      while (offset < chunk.length) {
        this.frame ??= Buffer.allocUnsafe(frameBytes);
        const copied = chunk.copy(this.frame, this.filled, offset);
        this.filled += copied;
        offset += copied;
        if (this.filled === frameBytes) {
          this.queue.push(this.frame);
          this.frame = null;
          this.filled = 0;
        }
      }
      if (this.queue.length >= QUEUE_HIGH) decoder.stdout!.pause();
    });
    decoder.on("exit", () => {
      if (this.decoder === decoder) this.decoderDone = true;
    });
  }

  private tick() {
    if (!this.surface || !this.size) return;
    if (!this.state.playing && !this.showNextWhilePaused) return;
    const frame = this.queue.shift();
    if (!frame) {
      if (this.decoderDone && this.state.playing) this.update({ playing: false, time: this.state.duration });
      return;
    }
    if (this.queue.length <= QUEUE_LOW) this.decoder?.stdout?.resume();
    this.surface.present({ bgra: frame, width: this.size.width, height: this.size.height });
    if (this.showNextWhilePaused && !this.state.playing) {
      this.showNextWhilePaused = false;
      return;
    }
    this.showNextWhilePaused = false;
    this.shown += 1;
    this.update({ time: Math.min(this.state.duration, this.startedAt + this.shown / FPS) });
  }
}

const playback = new Playback(path.resolve(file));

function handleKey(event: EngineKeyEvent): boolean {
  if (event.kind === "release") return false;
  const { time } = playback.get();
  if ((event.mods.ctrl && event.key === "c") || event.key === "q") {
    playback.stop();
    root.stop();
  } else if (event.key === " " || event.key === "k") {
    playback.toggle();
  } else if (event.key === "left" || event.key === "j") {
    playback.seek(time - SEEK_STEP);
  } else if (event.key === "right" || event.key === "l") {
    playback.seek(time + SEEK_STEP);
  } else if (event.key === "home" || event.key === "0") {
    playback.seek(0);
  } else {
    return false;
  }
  return true;
}

const root = createRoot({ name: "inline-player", onKey: handleKey });
root.setTitle(path.basename(file));

function clock(seconds: number) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function Video({ surface }: { surface: Surface }) {
  const ref = useRef<NodeHandle>(null);
  const rect = useRect(ref);
  useEffect(() => {
    if (!rect) return;
    const width = Math.max(2, Math.floor(rect.width / 2) * 2);
    const height = Math.max(2, Math.floor(rect.height / 2) * 2);
    playback.attach(surface, width, height);
  }, [rect, surface]);
  return <Box ref={ref} surface={surface} style={{ flexGrow: 1, background: "#000" }} />;
}

function Scrubber({ time, duration, color, track }: { time: number; duration: number; color: Color; track: Color }) {
  const ref = useRef<NodeHandle>(null);
  const rect = useRect(ref);
  const seekTo = (x: number) => {
    if (rect && rect.width > 0) playback.seek(((x - rect.x) / rect.width) * duration);
  };
  const progress = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;
  return (
    <Box
      ref={ref}
      onClick={(event) => seekTo(event.x)}
      onDrag={(event) => seekTo(event.x)}
      style={{ flexGrow: 1, height: "100%", flexDirection: "column", justifyContent: "center", pointerShape: "pointer" }}
    >
      <Box style={{ width: "100%", height: 6, background: track, cornerRadius: 3, flexDirection: "row" }}>
        <Box style={{ width: `${progress}%`, height: 6, background: color, cornerRadius: 3 }} />
      </Box>
    </Box>
  );
}

function Player() {
  const colors = useTerminalColors();
  const theme = makeTheme(colors);
  const surface = useRef<Surface | null>(null);
  surface.current ??= root.createSurface();
  const { playing, time, duration } = useSyncExternalStore(playback.subscribe, playback.get);
  const rem = root.info.basePx;
  const controlHeight = Math.round(rem * 2.2);
  const icon = playing ? "M 9 6 L 9 18 M 15 6 L 15 18" : "M 8 5.5 L 18.5 12 L 8 18.5 Z";

  return (
    <Box style={{ width: "100%", height: "100%", flexDirection: "column", background: theme.bg }}>
      <Video surface={surface.current} />
      <Box
        style={{
          height: controlHeight,
          flexDirection: "row",
          alignItems: "center",
          gap: rem * 0.75,
          padding: { left: rem * 0.5, right: rem * 0.75 },
          background: theme.field,
        }}
      >
        <Box
          onClick={() => playback.toggle()}
          style={{
            width: controlHeight - 8,
            height: controlHeight - 8,
            alignItems: "center",
            justifyContent: "center",
            cornerRadius: 6,
            hoverBackground: theme.hover,
            pointerShape: "pointer",
          }}
        >
          <Path
            d={icon}
            viewBox={24}
            stroke={{ width: 2, color: theme.fg, cap: "round", join: "round" }}
            style={{ width: rem * 1.2, height: rem * 1.2 }}
          />
        </Box>
        <Text style={{ fontSize: rem * 0.85, color: theme.fg, wrap: false, selectable: false, flexShrink: 0 }}>
          {`${clock(time)} / ${clock(duration)}`}
        </Text>
        <Scrubber time={time} duration={duration} color={theme.accent} track={theme.hairline} />
        <Text style={{ fontSize: rem * 0.75, color: theme.muted, wrap: false, selectable: false, flexShrink: 0 }}>
          space play/pause · ←/→ 5s · q quit
        </Text>
      </Box>
    </Box>
  );
}

root.render(<Player />);
