let exporter: () => string | null = () => null;

export function setProfileExporter(next: () => string | null): void {
  exporter = next;
}

export function exportCurrentProfile(): string | null {
  return exporter();
}
