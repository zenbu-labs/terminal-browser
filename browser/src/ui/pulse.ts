import { useEffect, useState } from "react";

const PERIOD_MS = 2800;
const TICK_MS = 100;

export function usePulse(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  if (!active) return 0;
  const phase = ((now % PERIOD_MS) / PERIOD_MS) * Math.PI * 2;
  return 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(phase));
}
