export function daemonEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) => !key.startsWith("PIXEL_") && !(key === "WAYLAND_DISPLAY" && value === ""),
    ),
  );
  env.NODE_ENV ??= "production";
  return env;
}
