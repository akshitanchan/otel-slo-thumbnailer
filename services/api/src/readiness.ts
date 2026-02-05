import { readyGauge } from "./metrics.js";

export function startReadinessLoop(
  check: () => Promise<void>,
  intervalMs = 2000
): { getReady: () => boolean; stop: () => void } {
  let ready = false;

  function set(v: boolean) {
    ready = v;
    readyGauge.set(v ? 1 : 0);
  }

  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      await check();
      set(true);
    } catch {
      set(false);
    }
  }

  // run once immediately
  void tick();

  const t = setInterval(() => void tick(), intervalMs);
  t.unref();

  return {
    getReady: () => ready,
    stop: () => {
      stopped = true;
      clearInterval(t);
    }
  };
}
