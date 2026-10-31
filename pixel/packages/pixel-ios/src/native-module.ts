import { requireNativeModule } from "expo-modules-core";

export interface PixelNativeModule {
  configure(json: string): void;
  info(): string;
  applyOps(ops: string): void;
  start(): void;
  stop(): void;
  call(name: string, args: string): string;
  displayScale(): number;
  textSize(): number;
  setTextSize(points: number): void;
  frameStats(): Record<string, unknown>;
  addListener(event: "onEngineEvents", listener: (payload: { events: string[] }) => void): { remove(): void };
}

export const Pixel = requireNativeModule<PixelNativeModule>("Pixel");
