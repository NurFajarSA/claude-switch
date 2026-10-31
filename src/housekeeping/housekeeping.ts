import { join } from "node:path";
import { readUserScope } from "../connectors/connectors.ts";
import type { Engine } from "../core/engine.ts";
import type { DesktopHub } from "../desktop/hub.ts";
import { displayName } from "../desktop/profiles.ts";
import type { EventLog } from "../infra/events.ts";
import type { Logger } from "../infra/log.ts";
import { McpUsageStore, scanTranscripts, type UnusedServer, unusedServers } from "./mcp-usage.ts";

const DAY_MS = 86_400_000;
const UNUSED_DAYS = 30;
const OWN_SERVER = "claude-switch";

export async function findUnusedMcpServers({ engine, now = Date.now(), maxAgeMs = DAY_MS }: { engine: Engine; now?: number; maxAgeMs?: number }) {
  const store = new McpUsageStore(engine.paths.stateDir);
  const servers = (await readUserScope(engine.paths.claudeJson)).map((s) => s.name).filter((n) => n !== OWN_SERVER);
  let usage = await store.load();
  if (now - usage.scannedAt >= maxAgeMs) {
    usage = await scanTranscripts({ projectsDir: join(engine.paths.claudeConfigDir, "projects"), usage, servers, now });
    await store.save(usage);
  }
  return { store, usage, unused: unusedServers({ usage, servers, days: UNUSED_DAYS, now }) };
}

export async function housekeep({ engine, hub, events, log, now = Date.now() }: { engine: Engine; hub: DesktopHub; events: EventLog; log: Logger; now?: number }): Promise<void> {
  const config = await engine.config.load();
  if (config.idleCloseHours > 0) {
    for (const profile of await hub.closeIdle({ idleHours: config.idleCloseHours })) {
      const hours = config.idleCloseHours;
      await events.emit({
        kind: "profile_closed",
        title: `Closed ${displayName(profile)}`,
        body: `None of its sessions changed in ${hours} ${hours === 1 ? "hour" : "hours"}. They are saved; reopen it any time.`,
        data: { profile: profile.name },
      });
      log.info("closed_idle_profile", { profile: profile.name });
    }
  }
  const { store, usage, unused } = await findUnusedMcpServers({ engine, now });
  if (config.mcpCleanup && unused.length > 0 && (usage.notifiedAt === null || now - usage.notifiedAt >= UNUSED_DAYS * DAY_MS)) {
    await events.emit(mcpUnusedEvent(unused));
    await store.save({ ...usage, notifiedAt: now });
    log.info("mcp_unused_suggested", { servers: unused.map((s) => s.name) });
  }
}

function mcpUnusedEvent(unused: readonly UnusedServer[]) {
  const names = unused.map((s) => s.name);
  return {
    kind: "mcp_unused",
    title: `${names.length} MCP ${names.length === 1 ? "server" : "servers"} unused for ${UNUSED_DAYS} days`,
    body: `${names.slice(0, 5).join(", ")}${names.length > 5 ? ` and ${names.length - 5} more` : ""}. Removing them makes every Claude session load fewer tools.`,
    data: { servers: names },
  };
}
