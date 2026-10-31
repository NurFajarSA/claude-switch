import { UserError } from "../core/engine.ts";
import type { DesktopHub } from "../desktop/hub.ts";
import type { Paths } from "../infra/paths.ts";
import {
  type AccountConnector,
  type ConnectorReport,
  connectorsFromProfiles,
  localNameFor,
  mergeConnectors,
  parseMcpList,
  readUserScope,
  type Runner,
} from "./connectors.ts";

const LIST_TIMEOUT_MS = 90_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface ImportResult {
  connector: string;
  name: string;
  ok: boolean;
  detail: string;
}

export class ConnectorManager {
  constructor(
    private readonly deps: { paths: Paths; hub: DesktopHub; run: Runner; cliAccount: () => Promise<string | null> },
  ) {}

  async report({ check }: { check: boolean }): Promise<ConnectorReport> {
    const local = await readUserScope(this.deps.paths.claudeJson);
    const userScope = new Set(local.map((l) => l.name));
    const servers = check
      ? parseMcpList((await this.deps.run(["mcp", "list"], LIST_TIMEOUT_MS)).stdout, userScope)
      : local.map((l) => ({
          name: l.name,
          origin: "local" as const,
          target: l.url ?? l.command ?? "",
          transport: l.url ? "http" : "stdio",
          health: "unknown" as const,
          detail: "not checked",
          removable: true,
        }));
    const [profiles, cliAccount] = await Promise.all([this.deps.hub.overview().then((o) => o.profiles.map((p) => p.profile)), this.deps.cliAccount()]);
    const connectors = mergeConnectors({ fromProfiles: await connectorsFromProfiles(profiles), servers, local, cliAccount });
    return { servers, connectors, checked: check };
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
    return results;
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

export function claudeRunner(claudeBinary: string | null): Runner {
  return async (args, timeoutMs = 30_000) => {
    if (!claudeBinary) throw new UserError("The `claude` CLI is not on PATH. Install Claude Code first.");
    const proc = Bun.spawn([claudeBinary, ...args], { stdout: "pipe", stderr: "pipe", cwd: process.env.HOME });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    return { code, stdout, stderr };
  };
}
