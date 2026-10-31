import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localNameFor, mergeConnectors, parseMcpList, portability, readUserScope } from "../src/connectors/connectors.ts";

const LIST = `Checking MCP server health…

claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected
claude.ai PostHog: https://mcp.posthog.com/mcp - ! Needs authentication
plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication
plugin:firebase:firebase: npx -y firebase-tools@latest mcp --dir . - ! Connected · tools fetch failed — Request timed out
posthog: https://mcp.posthog.com/mcp (HTTP) - ✗ Failed to connect
claude-switch: /Users/me/.local/bin/cs mcp - ✔ Connected
`;

describe("parseMcpList", () => {
  test("separates account connectors, plugin servers and local servers with their health", () => {
    const servers = parseMcpList(LIST, new Set(["posthog", "claude-switch"]));

    expect(servers.map((s) => [s.name, s.origin, s.health, s.transport, s.removable])).toEqual([
      ["Claude Docs", "account", "connected", null, false],
      ["PostHog", "account", "needs_auth", null, false],
      ["plugin:figma:figma", "plugin", "needs_auth", "http", false],
      ["plugin:firebase:firebase", "plugin", "degraded", null, false],
      ["posthog", "local", "failed", "http", true],
      ["claude-switch", "local", "connected", null, true],
    ]);
    expect(servers[2]?.target).toBe("https://mcp.figma.com/mcp");
    expect(servers[3]?.target).toBe("npx -y firebase-tools@latest mcp --dir .");
  });
});

describe("portability", () => {
  test("treats Anthropic-hosted connectors as claude.ai only", () => {
    expect(portability("https://api.anthropic.com/v1/pages/mcp")).toBe("account_only");
    expect(portability("https://sandbox.claudemcpcontent.com/imagine_mcp")).toBe("account_only");
    expect(portability("https://mcp.figma.com/mcp")).toBe("portable");
    expect(portability("not a url")).toBe("account_only");
  });
});

describe("mergeConnectors", () => {
  test("joins the same connector across accounts and marks what is already on this Mac", () => {
    const fromProfiles = new Map([
      ["https://mcp.figma.com/mcp", { name: "Figma", accounts: new Set(["kantor", "pribadi"]) }],
      ["https://mcp.posthog.com/mcp/", { name: "PostHog", accounts: new Set(["kantor"]) }],
    ]);
    const servers = parseMcpList(LIST, new Set(["posthog"]));

    const merged = mergeConnectors({ fromProfiles, servers, local: [{ name: "posthog", url: "https://mcp.posthog.com/mcp", command: null }], cliAccount: "fajar" });

    expect(merged.map((c) => [c.name, c.accounts, c.portability, c.localName])).toEqual([
      ["Claude Docs", ["CLI (fajar)"], "account_only", null],
      ["Figma", ["kantor", "pribadi"], "portable", "plugin:figma:figma"],
      ["PostHog", ["CLI (fajar)", "kantor"], "portable", "posthog"],
    ]);
  });
});

describe("readUserScope and localNameFor", () => {
  test("reads user-scope servers with their URL or command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claude-switch-mcp-"));
    await mkdir(dir, { recursive: true });
    const file = join(dir, ".claude.json");
    await writeFile(file, JSON.stringify({ mcpServers: { posthog: { type: "http", url: "https://mcp.posthog.com/mcp" }, cs: { command: "/bin/cs", args: ["mcp"] } } }));

    expect(await readUserScope(file)).toEqual([
      { name: "posthog", url: "https://mcp.posthog.com/mcp", command: null },
      { name: "cs", url: null, command: "/bin/cs mcp" },
    ]);
  });

  test("derives a free local name from the connector name", () => {
    expect(localNameFor("Google Calendar", new Set())).toBe("google-calendar");
    expect(localNameFor("PostHog", new Set(["posthog"]))).toBe("posthog-2");
  });
});

describe("importing connectors that only work through claude.ai", () => {
  test("rolls back a server whose sign-in rejects other apps and remembers it as claude.ai only", async () => {
    const { ConnectorManager } = await import("../src/connectors/manager.ts");
    const dir = await mkdtemp(join(tmpdir(), "claude-switch-import-"));
    const claudeJson = join(dir, ".claude.json");
    await writeFile(claudeJson, JSON.stringify({ mcpServers: {} }));
    const added = new Map<string, string>();
    const calls: string[] = [];
    const run = async (args: string[]) => {
      calls.push(args.join(" "));
      if (args[1] === "add") {
        added.set(args[6]!, args[7]!);
        await writeFile(claudeJson, JSON.stringify({ mcpServers: Object.fromEntries([...added].map(([n, url]) => [n, { type: "http", url }])) }));
      }
      if (args[1] === "remove") added.delete(args[2]!);
      if (args[1] === "list") {
        const lines = [
          "claude.ai Figma: https://mcp.figma.com/mcp - ! Needs authentication",
          "claude.ai Slack: https://mcp.slack.com/mcp - ! Needs authentication",
          ...[...added].map(([n, url]) =>
            n === "slack"
              ? `${n}: ${url} (HTTP) - ✘ Failed to connect — Incompatible auth server: does not support dynamic client registration`
              : `${n}: ${url} (HTTP) - ! Needs authentication`,
          ),
        ];
        return { code: 0, stdout: lines.join("\n"), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const manager = new ConnectorManager({
      paths: { claudeJson, stateDir: dir } as never,
      hub: { overview: async () => ({ profiles: [] }) },
      run,
      cliAccount: async () => "kantor",
    });

    const results = await manager.importConnectors({ names: [], all: true });
    const after = await manager.report({ check: true });

    expect(results.map((r) => [r.connector, r.ok])).toEqual([
      ["Figma", true],
      ["Slack", false],
    ]);
    expect(results[1]?.detail).toContain("works only through claude.ai");
    expect(calls).toContain("mcp remove slack --scope user");
    expect([...added.keys()]).toEqual(["figma"]);
    expect(after.connectors.find((c) => c.name === "Slack")?.portability).toBe("account_only");
  });

  test("recognises the heavy cross mark as a failure", () => {
    const [server] = parseMcpList("box: https://mcp.box.com (HTTP) - ✘ Failed to connect — Incompatible auth server", new Set(["box"]));
    expect(server?.health).toBe("failed");
  });
});
