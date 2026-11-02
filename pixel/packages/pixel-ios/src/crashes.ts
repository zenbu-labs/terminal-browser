import { requireNativeModule } from "expo-modules-core";

export interface CrashReport {
  name: string;
  body: string;
}

interface CrashModule {
  pending(): CrashReport[];
  remove(name: string): void;
  crash(): void;
}

const Crashes = requireNativeModule<CrashModule>("PixelCrashes");

export const crashReports = {
  pending: () => Crashes.pending(),
  remove: (name: string) => Crashes.remove(name),
  crash: () => Crashes.crash(),
};
