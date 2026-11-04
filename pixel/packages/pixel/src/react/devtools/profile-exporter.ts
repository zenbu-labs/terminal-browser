let exporter: () => string | null = () => null;

export function setProfileExporter(exportProfile: () => string | null): void {
  exporter = exportProfile;
}

export function exportProfile(): string | null {
  return exporter();
}
