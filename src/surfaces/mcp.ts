import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import { type Engine, UserError } from "../core/engine.ts";
import type { DesktopHub } from "../desktop/hub.ts";
import { HandoffError } from "../desktop/sessions.ts";
import { describeHandoff, describeSwitch } from "./messages.ts";
import { renderProfiles, renderTable, toOverviewView } from "./view.ts";

export const VERSION: string = pkg.version;

export async function serveMcp({ engine, hub, env }: { engine: Engine; hub: DesktopHub; env: NodeJS.ProcessEnv }): Promise<void> {
  const server = new McpServer({ name: "claude-switch", version: VERSION });
  const currentSession = env.CLAUDE_CODE_HOST_SESSION_ID?.startsWith("local_") ? env.CLAUDE_CODE_HOST_SESSION_ID : undefined;

  server.registerTool(
    "list_accounts",
    {
      title: "List Claude accounts and usage",
      description:
        "Show every Claude account the user has: each Claude Desktop profile (one account per window) and each account registered for the CLI, with the share of the 5-hour and weekly limits already used. Use it before suggesting a switch. Set refresh to fetch live numbers instead of the last background poll.",
      inputSchema: { refresh: z.boolean().optional().describe("Fetch live usage instead of cached readings") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ refresh }) => {
      if (refresh) await engine.pollAll();
      const view = toOverviewView(await hub.overview());
      const text = [
        "Claude Desktop profiles (● = window open):",
        renderProfiles(view, false),
        "",
        "Claude Code CLI login (● = active):",
        renderTable(view, false),
        currentSession ? `\nThis conversation is Desktop session ${currentSession}.` : "",
      ].join("\n");
      return { content: [{ type: "text" as const, text }], structuredContent: { ...view } };
    },
  );

  server.registerTool(
    "handoff_session",
    {
      title: "Move this conversation to another Claude account",
      description:
        "Continue the current Claude Desktop conversation under another account. Copies this session into the target account's Desktop profile, with the full transcript, and opens that window. Omit `to` to pick the account with the most remaining usage; closed windows are preferred because an open window only loads new sessions when it restarts. After it succeeds, finish your reply and tell the user to continue in the named window; do not keep working in this one.",
      inputSchema: {
        to: z.string().optional().describe("Desktop profile name or label, as shown by list_accounts; omit to choose automatically"),
        session: z.string().optional().describe("Desktop session id (local_…); defaults to the current conversation"),
        restart: z
          .boolean()
          .optional()
          .describe("If the target window is already open, quit and reopen it so it shows the session. Only pass true after the user agreed, since it interrupts work in that window."),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ to, session, restart }) => {
      const sessionId = session ?? currentSession;
      if (!sessionId) return failure("This conversation is not a Claude Desktop session. Pass `session` explicitly.");
      return guarded(async () => describeHandoff(await hub.handoff({ sessionId, to, force: true, restart: restart ?? false })));
    },
  );

  server.registerTool(
    "switch_cli_account",
    {
      title: "Switch the Claude Code CLI login",
      description:
        "Change which account the Claude Code CLI and the VS Code extension use. Pass an alias or email, or omit it to pick the account with the most remaining usage. Running CLI sessions pick up the change within about 30 seconds. This does not affect Claude Desktop windows; use handoff_session for those.",
      inputSchema: { account: z.string().optional().describe("Alias, email or id; omit to choose automatically") },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ account }) =>
      guarded(async () => {
        if (account) return describeSwitch(await engine.switchTo(account));
        const { decision, result } = await engine.autoSwitch({ force: true });
        if (result) return describeSwitch(result);
        return decision.kind === "exhausted"
          ? `Every other account is at or above the threshold.${decision.soonestReset ? ` Soonest reset: ${decision.soonestReset}.` : ""}`
          : `Staying on the current account: ${decision.reason}.`;
      }),
  );

  await server.connect(new StdioServerTransport());
}

async function guarded(fn: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await fn() }] };
  } catch (err) {
    return failure(err instanceof UserError || err instanceof HandoffError ? err.message : `Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function failure(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}
