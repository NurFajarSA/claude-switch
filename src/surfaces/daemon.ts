import type { Engine } from "../core/engine.ts";
import type { Logger } from "../infra/log.ts";

const MAX_BACKOFF_SECONDS = 900;

export async function runDaemon(engine: Engine, log: Logger, signal: AbortSignal): Promise<void> {
  let backoff = 0;
  log.info("daemon_started");
  while (!signal.aborted) {
    const config = await engine.config.load();
    try {
      const records = await engine.pollAll();
      const rateLimited = records.some((r) => r.error?.startsWith("rate_limited"));
      backoff = rateLimited ? Math.min(MAX_BACKOFF_SECONDS, Math.max(config.pollSeconds, backoff * 2)) : 0;
      if (config.autoSwitch) {
        const { decision } = await engine.autoSwitch({ force: false, poll: false });
        if (decision.kind === "switch") log.info("daemon_switched", { reason: decision.reason });
      }
    } catch (err) {
      log.error("daemon_cycle_failed", { error: err instanceof Error ? err.message : String(err) });
    }
    await sleep((backoff || config.pollSeconds) * 1000, signal);
  }
  log.info("daemon_stopped");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
