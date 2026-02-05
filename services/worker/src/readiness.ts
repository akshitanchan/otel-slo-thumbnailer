import type { Db } from "./db.js";
import { readyGauge } from "./metrics.js";
import { log } from "./log.js";

export type Readiness = {
  getReady(): boolean;
  stop(): void;
};

export function startReadinessLoop(db: Db, intervalMs: number): Readiness {
  let ready = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const set = (v: boolean) => {
    ready = v;
    readyGauge.set(v ? 1 : 0);
  };

  const check = async () => {
    try {
      await db.query("readiness_check", "SELECT 1");
      if (!ready) log("info", "ready_state_changed", { ready: true });
      set(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (ready) log("error", "ready_state_changed", { ready: false, error: msg });
      set(false);
    }
  };

  // initial check + periodic
  void check();
  timer = setInterval(() => {
    if (stopped) return;
    void check();
  }, intervalMs);

  return {
    getReady: () => ready,
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}
