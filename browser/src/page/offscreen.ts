export function offscreenOptions(deviceScaleFactor: number) {
  if (process.platform !== "darwin") return { useSharedTexture: false, deviceScaleFactor };
  return {
    useSharedTexture: true,
    sharedTexturePixelFormat: "argb" as const,
    deviceScaleFactor,
  };
}
