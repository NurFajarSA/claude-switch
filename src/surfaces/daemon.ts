import type { Engine } from "../core/engine.ts";
import type { DesktopHub } from "../desktop/hub.ts";
import type { Logger } from "../infra/log.ts";

const WATCH_SECONDS = 10;

const MAX_BACKOFF_SECONDS = 900;

export async function runDaemon({ engine, hub, log, signal }: { engine: Engine; hub: DesktopHub; log: Logger; signal: AbortSignal }): Promise<void> {
  log.info("daemon_started");
  await Promise.all([pollLoop(engine, log, signal), watchLoop(hub, log, signal)]);
  log.info("daemon_stopped");
}

async function watchLoop(hub: DesktopHub, log: Logger, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const reopened = await hub.watch();
      if (reopened.length > 0) log.info("reopened_after_update", { profiles: reopened });
    } catch (err) {
      log.error("watch_failed", { error: err instanceof Error ? err.message : String(err) });
    }
    await sleep(WATCH_SECONDS * 1000, signal);
  }
}

async function pollLoop(engine: Engine, log: Logger, signal: AbortSignal): Promise<void> {
  let backoff = 0;
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
