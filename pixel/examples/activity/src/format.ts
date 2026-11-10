export function bytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function percent(value: number): string {
  return `${value.toFixed(value >= 10 || value === 0 ? 0 : 1)}%`;
}

export function duration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// fixme: placeholder copy
/** ps prints elapsed time as [[dd-]hh:]mm:ss */
export function elapsedSeconds(elapsed: string): number {
  const [daysPart, clock] = elapsed.includes("-") ? elapsed.split("-") : ["0", elapsed];
  const parts = clock.split(":").map(Number).reverse();
  return Number(daysPart) * 86400 + (parts[2] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[0] ?? 0);
}
