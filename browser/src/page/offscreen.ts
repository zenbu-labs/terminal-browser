export function offscreenOptions(deviceScaleFactor: number) {
  if (process.platform === "darwin") {
    return {
      useSharedTexture: true,
      sharedTexturePixelFormat: "argb" as const,
      deviceScaleFactor,
    };
  }
  if (process.platform === "linux") {
    return {
      useSharedTexture: false,
      deviceScaleFactor,
    };
  }
  throw new Error(`unsupported platform: ${process.platform}`);
}
