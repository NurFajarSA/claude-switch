import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readJson, writeJsonAtomic } from "../infra/files.ts";

const DAY_MS = 86_400_000;
const LOOKBACK_MS = 35 * DAY_MS;
const TOOL_NAME = /"name":"mcp__([A-Za-z0-9_-]+?)__/g;

const UsageFile = z.object({
  version: z.literal(1),
  scannedAt: z.number(),
  lastUsed: z.record(z.string(), z.number()),
  firstSeen: z.record(z.string(), z.number()),
  notifiedAt: z.number().nullable(),
});
export type McpUsage = z.infer<typeof UsageFile>;

export function toolKey(serverName: string): string {
  return serverName.replace(/[^A-Za-z0-9_-]/g, "_");
}

export class McpUsageStore {
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = join(stateDir, "mcp-usage.json");
  }

  async load(): Promise<McpUsage> {
    return (await readJson(this.file, UsageFile).catch(() => null)) ?? { version: 1, scannedAt: 0, lastUsed: {}, firstSeen: {}, notifiedAt: null };
  }

  async save(usage: McpUsage): Promise<void> {
    await writeJsonAtomic(this.file, usage);
  }
}

export async function scanTranscripts({
  projectsDir,
  usage,
  servers,
  now,
}: {
  projectsDir: string;
  usage: McpUsage;
  servers: readonly string[];
  now: number;
}): Promise<McpUsage> {
  const since = Math.max(usage.scannedAt, now - LOOKBACK_MS);
  const lastUsed = { ...usage.lastUsed };
  for (const project of await readdir(projectsDir).catch(() => [])) {
    const dir = join(projectsDir, project);
    for (const file of (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".jsonl"))) {
      const path = join(dir, file);
      const info = await stat(path).catch(() => null);
      if (!info || info.mtimeMs < since) continue;
      const text = await Bun.file(path).text().catch(() => "");
      for (const match of text.matchAll(TOOL_NAME)) {
        const key = match[1]!;
        lastUsed[key] = Math.max(lastUsed[key] ?? 0, info.mtimeMs);
      }
    }
  }
  const firstSeen = { ...usage.firstSeen };
  for (const server of servers) firstSeen[server] ??= now;
  return { ...usage, scannedAt: now, lastUsed, firstSeen };
}

export interface UnusedServer {
  name: string;
  lastUsed: string | null;
}

export function unusedServers({ usage, servers, days, now }: { usage: McpUsage; servers: readonly string[]; days: number; now: number }): UnusedServer[] {
  const cutoff = now - days * DAY_MS;
  return servers
    .filter((name) => (usage.firstSeen[name] ?? now) <= cutoff)
    .filter((name) => (usage.lastUsed[toolKey(name)] ?? 0) < cutoff)
    .map((name) => {
      const at = usage.lastUsed[toolKey(name)];
      return { name, lastUsed: at ? new Date(at).toISOString() : null };
    });
}
