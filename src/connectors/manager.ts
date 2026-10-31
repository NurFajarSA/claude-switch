import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { UserError } from "../core/engine.ts";
import type { DesktopProfile } from "../desktop/profiles.ts";
import { readJson, writeJsonAtomic } from "../infra/files.ts";
import type { Paths } from "../infra/paths.ts";
import {
  type AccountConnector,
  CLAUDE_AI_ONLY,
  type ConnectorReport,
  type McpServer,
  connectorsFromProfiles,
  localNameFor,
  mergeConnectors,
  normalize,
  parseMcpList,
  readUserScope,
  type Runner,
} from "./connectors.ts";

const LIST_TIMEOUT_MS = 90_000;
const Learned = z.object({ version: z.literal(1), claudeOnly: z.array(z.string()) });
// `claude mcp list` connects to every server and takes seconds; its last result is shown until the next one arrives.
const HealthCache = z.object({
  version: z.literal(1),
  checkedAt: z.string(),
  servers: z.array(
    z.object({
      name: z.string(),
      origin: z.enum(["local", "plugin", "account"]),
      target: z.string(),
      transport: z.string().nullable(),
      health: z.enum(["connected", "needs_auth", "degraded", "failed", "unknown"]),
      detail: z.string(),
      removable: z.boolean(),
    }),
  ),
});
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface ImportResult {
  connector: string;
  name: string;
  ok: boolean;
  detail: string;
}

export class ConnectorManager {
  constructor(
    private readonly deps: {
      paths: Paths;
      hub: { overview(): Promise<{ profiles: { profile: DesktopProfile }[] }> };
      run: Runner;
      cliAccount: () => Promise<string | null>;
    },
  ) {}

  async report({ check }: { check: boolean }): Promise<ConnectorReport> {
    const local = await readUserScope(this.deps.paths.claudeJson);
    const userScope = new Set(local.map((l) => l.name));
    let servers: McpServer[];
    let checkedAt: string | null = null;
    if (check) {
      servers = parseMcpList((await this.deps.run(["mcp", "list"], LIST_TIMEOUT_MS)).stdout, userScope);
      checkedAt = new Date().toISOString();
      await writeJsonAtomic(this.healthFile(), { version: 1, checkedAt, servers });
    } else {
      const cache = await readJson(this.healthFile(), HealthCache).catch(() => null);
      checkedAt = cache?.checkedAt ?? null;
      // Local servers come from ~/.claude.json, so one added or removed since the check shows up right away;
      // a cached status only applies while the server still points at the same place.
      servers = local.map((l) => {
        const target = l.url ?? l.command ?? "";
        const cached = cache?.servers.find((s) => s.origin === "local" && s.name === l.name && s.target === target);
        return {
          name: l.name,
          origin: "local" as const,
          target,
          transport: l.url ? "http" : "stdio",
          health: cached?.health ?? ("unknown" as const),
          detail: cached?.detail ?? "not checked",
          removable: true,
        };
      });
      servers.push(...(cache?.servers.filter((s) => s.origin !== "local") ?? []));
    }
    const [profiles, cliAccount] = await Promise.all([this.deps.hub.overview().then((o) => o.profiles.map((p) => p.profile)), this.deps.cliAccount()]);
    const connectors = mergeConnectors({
      fromProfiles: await connectorsFromProfiles(profiles),
      servers,
      local,
      cliAccount,
      claudeOnly: new Set(await this.learnedClaudeOnly()),
    });
    return { servers, connectors, checked: checkedAt !== null, checkedAt };
  }

  async importConnectors({ names, all }: { names: string[]; all: boolean }): Promise<ImportResult[]> {
    const report = await this.report({ check: true });
    const wanted = names.map((n) => n.toLowerCase());
    const candidates = report.connectors.filter((c) =>
      all ? c.portability === "portable" && !c.localName : wanted.includes(c.name.toLowerCase()) || wanted.includes(c.url),
    );
    if (candidates.length === 0) throw new UserError(all ? "Every portable connector is already on this Mac." : `No account connector matches ${names.join(", ")}.`);
    const taken = new Set(report.servers.map((s) => s.name));
    const results: ImportResult[] = [];
    for (const connector of candidates) results.push(await this.importOne(connector, taken));
    return this.rollBackClaudeOnly(results, candidates);
  }

  private async rollBackClaudeOnly(results: ImportResult[], candidates: readonly AccountConnector[]): Promise<ImportResult[]> {
    const added = results.filter((r) => r.ok && r.detail.startsWith("added"));
    if (added.length === 0) return results;
    const health = parseMcpList((await this.deps.run(["mcp", "list"], LIST_TIMEOUT_MS)).stdout, new Set(added.map((r) => r.name)));
    const learned = new Set(await this.learnedClaudeOnly());
    for (const result of added) {
      const server = health.find((h) => h.origin === "local" && h.name === result.name);
      if (!server || server.health !== "failed" || !CLAUDE_AI_ONLY.test(server.detail)) continue;
      await this.deps.run(["mcp", "remove", result.name, "--scope", "user"]);
      const url = candidates.find((c) => c.name === result.connector)?.url;
      if (url) learned.add(normalize(url));
      result.ok = false;
      result.detail = "works only through claude.ai (its sign-in does not accept other apps); removed again";
    }
    await writeJsonAtomic(this.learnedFile(), { version: 1, claudeOnly: [...learned].sort() });
    return results;
  }

  private learnedFile(): string {
    return join(this.deps.paths.stateDir, "connectors.json");
  }

  private healthFile(): string {
    return join(this.deps.paths.stateDir, "connectors-health.json");
  }

  private async learnedClaudeOnly(): Promise<string[]> {
    return (await readJson(this.learnedFile(), Learned).catch(() => null))?.claudeOnly ?? [];
  }

  async add({ name, url, headers }: { name: string; url: string; headers: string[] }): Promise<void> {
    if (!NAME.test(name)) throw new UserError("A server name uses letters, digits, dots, dashes or underscores.");
    try {
      new URL(url);
    } catch {
      throw new UserError(`"${url}" is not a URL.`);
    }
    const { code, stderr, stdout } = await this.deps.run([
      "mcp",
      "add",
      "--scope",
      "user",
      "--transport",
      "http",
      name,
      url,
      ...headers.flatMap((h) => ["--header", h]),
    ]);
    if (code !== 0) throw new UserError((stderr || stdout).trim() || `claude mcp add ${name} failed`);
  }

  async login(name: string, interactive: InteractiveRunner): Promise<void> {
    const code = await interactive(["mcp", "login", name]);
    if (code !== 0) throw new UserError(`Sign-in to ${name} did not finish.`);
  }

  async logout(name: string): Promise<void> {
    const { code, stderr, stdout } = await this.deps.run(["mcp", "logout", name]);
    if (code !== 0) throw new UserError((stderr || stdout).trim() || `claude mcp logout ${name} failed`);
  }

  async remove(name: string): Promise<void> {
    const local = await readUserScope(this.deps.paths.claudeJson);
    if (!local.some((l) => l.name === name)) throw new UserError(`"${name}" is not a user-scope MCP server on this Mac.`);
    const { code, stderr, stdout } = await this.deps.run(["mcp", "remove", name, "--scope", "user"]);
    if (code !== 0) throw new UserError((stderr || stdout).trim() || `claude mcp remove ${name} failed`);
  }

  private async importOne(connector: AccountConnector, taken: Set<string>): Promise<ImportResult> {
    if (connector.portability !== "portable") {
      return { connector: connector.name, name: "", ok: false, detail: "only works inside a claude.ai account" };
    }
    if (connector.localName) return { connector: connector.name, name: connector.localName, ok: true, detail: "already on this Mac" };
    const name = localNameFor(connector.name, taken);
    taken.add(name);
    const { code, stderr, stdout } = await this.deps.run(["mcp", "add", "--scope", "user", "--transport", "http", name, connector.url]);
    return { connector: connector.name, name, ok: code === 0, detail: code === 0 ? "added; sign in with /mcp" : (stderr || stdout).trim() };
  }
}

export type InteractiveRunner = (args: string[]) => Promise<number>;

export function interactiveClaude(claudeBinary: string | null, workdir: string): InteractiveRunner {
  return async (args) => {
    if (!claudeBinary) throw new UserError("The `claude` CLI is not on PATH. Install Claude Code first.");
    if (!process.stdin.isTTY) throw new UserError("Signing in needs a terminal. Run this command in Terminal.");
    await mkdir(workdir, { recursive: true, mode: 0o700 });
    return Bun.spawn([claudeBinary, ...args], { stdio: ["inherit", "inherit", "inherit"], cwd: workdir }).exited;
  };
}

export function claudeRunner(claudeBinary: string | null, workdir: string): Runner {
  return async (args, timeoutMs = 30_000) => {
    if (!claudeBinary) throw new UserError("The `claude` CLI is not on PATH. Install Claude Code first.");
    await mkdir(workdir, { recursive: true, mode: 0o700 });
    const proc = Bun.spawn([claudeBinary, ...args], { stdout: "pipe", stderr: "pipe", cwd: workdir });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    return { code, stdout, stderr };
  };
}
