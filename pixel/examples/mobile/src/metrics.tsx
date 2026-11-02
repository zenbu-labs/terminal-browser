import { createContext, useContext } from "react";
import type { DeviceRoot } from "@zenbu-labs/pixel/device";

export interface Metrics {
  root: DeviceRoot;
  pt: number;
}

export const MetricsContext = createContext<Metrics | null>(null);

export function useMetrics(): Metrics {
  const metrics = useContext(MetricsContext);
  if (!metrics) throw new Error("useMetrics outside the app");
  return metrics;
}
