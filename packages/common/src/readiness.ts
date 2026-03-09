export function startReadinessLoop(
  check: () => Promise<void>,
  intervalMs = 2000,
  onChange?: (ready: boolean) => void
): { getReady: () => boolean; stop: () => void } {
  let ready = false;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      await check();
      ready = true;
    } catch {
      ready = false;
    }
    onChange?.(ready);
  }

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
