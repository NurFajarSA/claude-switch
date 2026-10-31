import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { displayName, type DesktopProfile } from "../desktop/profiles.ts";
import { readJson, readRawJson, isPlainObject } from "../infra/files.ts";

export type ServerOrigin = "local" | "plugin" | "account";
export type ServerHealth = "connected" | "needs_auth" | "degraded" | "failed" | "unknown";
export type Portability = "portable" | "account_only";

export interface McpServer {
  name: string;
  origin: ServerOrigin;
  target: string;
  transport: string | null;
  health: ServerHealth;
  detail: string;
  removable: boolean;
}

export interface AccountConnector {
  name: string;
  url: string;
  accounts: string[];
  portability: Portability;
  localName: string | null;
}

export interface ConnectorReport {
  servers: McpServer[];
  connectors: AccountConnector[];
  /** Whether `health` comes from a check, now or the cached last one. */
  checked: boolean;
  /** When that check ran (ISO time), or null if no check ever ran. */
  checkedAt: string | null;
}

export type Runner = (args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;

const ACCOUNT_ONLY_HOSTS = [/(^|\.)anthropic\.com$/, /(^|\.)claude\.ai$/, /(^|\.)claudemcpcontent\.com$/];
const STATUS: Record<string, ServerHealth> = { "✔": "connected", "✓": "connected", "✗": "failed", "✘": "failed", "×": "failed" };

export const CLAUDE_AI_ONLY = /dynamic client registration/i;

export function portability(url: string): Portability {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "account_only";
  }
  return ACCOUNT_ONLY_HOSTS.some((pattern) => pattern.test(host)) ? "account_only" : "portable";
}

export function parseMcpList(output: string, userScope: ReadonlySet<string>): McpServer[] {
  const servers: McpServer[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const split = line.indexOf(": ");
    const dash = line.lastIndexOf(" - ");
    if (split <= 0 || dash < split) continue;
    let name = line.slice(0, split);
    const origin: ServerOrigin = name.startsWith("claude.ai ") ? "account" : name.startsWith("plugin:") ? "plugin" : "local";
    if (origin === "account") name = name.slice("claude.ai ".length);
    const location = line.slice(split + 2, dash);
    const transport = location.match(/ \((HTTP|SSE|stdio)\)$/i)?.[1]?.toLowerCase() ?? null;
    const target = transport ? location.slice(0, location.lastIndexOf(" (")) : location;
    const status = line.slice(dash + 3).trim();
    const symbol = status.charAt(0);
    const text = status.slice(1).trim();
    const health: ServerHealth =
      STATUS[symbol] ?? (symbol === "!" ? (/needs authentication/i.test(text) ? "needs_auth" : "degraded") : "unknown");
    servers.push({ name, origin, target, transport, health, detail: text || status, removable: origin === "local" && userScope.has(name) });
  }
  return servers;
}

export interface LocalServerConfig {
  name: string;
  url: string | null;
  command: string | null;
}

export async function readUserScope(claudeJson: string): Promise<LocalServerConfig[]> {
  const config = await readRawJson(claudeJson).catch(() => null);
  const servers = isPlainObject(config?.mcpServers) ? config.mcpServers : {};
  return Object.entries(servers).map(([name, value]) => {
    const entry = isPlainObject(value) ? value : {};
    const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : [];
    return {
      name,
      url: typeof entry.url === "string" ? entry.url : null,
      command: typeof entry.command === "string" ? [entry.command, ...args].join(" ") : null,
    };
  });
}

const CardConnectors = z.looseObject({
  remoteMcpServersConfig: z.array(z.looseObject({ name: z.string(), url: z.string() })).nullish(),
});

const CARDS_PER_PROFILE = 5;

export async function connectorsFromProfiles(profiles: readonly DesktopProfile[]): Promise<Map<string, { name: string; accounts: Set<string> }>> {
  const found = new Map<string, { name: string; accounts: Set<string> }>();
  for (const profile of profiles) {
    if (!profile.accountId) continue;
    for (const root of profile.sessionRoots) {
      const files = (await readdir(root.dir).catch(() => [])).filter((f) => f.startsWith("local_") && f.endsWith(".json"));
      const dated = await Promise.all(files.map(async (f) => ({ f, at: (await stat(join(root.dir, f)).catch(() => null))?.mtimeMs ?? 0 })));
      for (const { f } of dated.sort((a, b) => b.at - a.at).slice(0, CARDS_PER_PROFILE)) {
        const card = await readJson(join(root.dir, f), CardConnectors).catch(() => null);
        for (const server of card?.remoteMcpServersConfig ?? []) {
          const entry = found.get(server.url) ?? { name: server.name, accounts: new Set<string>() };
          entry.accounts.add(displayName(profile));
          found.set(server.url, entry);
        }
      }
    }
  }
  return found;
}

export function mergeConnectors({
  fromProfiles,
  servers,
  local,
  cliAccount,
  claudeOnly = new Set<string>(),
}: {
  fromProfiles: Map<string, { name: string; accounts: Set<string> }>;
  servers: readonly McpServer[];
  local: readonly LocalServerConfig[];
  cliAccount: string | null;
  claudeOnly?: ReadonlySet<string>;
}): AccountConnector[] {
  const merged = new Map<string, { name: string; accounts: Set<string> }>();
  for (const [url, entry] of fromProfiles) merged.set(normalize(url), { name: entry.name, accounts: new Set(entry.accounts) });
  for (const server of servers.filter((s) => s.origin === "account")) {
    const key = normalize(server.target);
    const entry = merged.get(key) ?? { name: server.name, accounts: new Set<string>() };
    entry.accounts.add(cliAccount ? `CLI (${cliAccount})` : "CLI");
    merged.set(key, entry);
  }
  const localByUrl = new Map(local.filter((l) => l.url).map((l) => [normalize(l.url!), l.name]));
  const pluginByUrl = new Map(servers.filter((s) => s.origin === "plugin").map((s) => [normalize(s.target), s.name]));
  return [...merged.entries()]
    .map(([url, entry]) => ({
      name: entry.name,
      url,
      accounts: [...entry.accounts].sort(),
      portability: claudeOnly.has(url) ? ("account_only" as const) : portability(url),
      localName: localByUrl.get(url) ?? pluginByUrl.get(url) ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function normalize(url: string): string {
  return url.replace(/\/+$/, "");
}

export function localNameFor(connectorName: string, taken: ReadonlySet<string>): string {
  const base = connectorName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "connector";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}
