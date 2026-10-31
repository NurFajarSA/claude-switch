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
