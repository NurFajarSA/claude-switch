import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import { type Engine, UserError } from "../core/engine.ts";
import type { DesktopHub } from "../desktop/hub.ts";
import { RulesStore } from "../core/rules-store.ts";
import { HandoffError } from "../desktop/sessions.ts";
import { allowedSet, ruleFor } from "../domain/rules.ts";
import { accountDirectory, namesOf, resolveAccount } from "./accounts.ts";
import { describeHandoff, describeSwitch } from "./messages.ts";
import { renderProfiles, renderTable, toOverviewView } from "./view.ts";

export const VERSION: string = pkg.version;

export async function serveMcp({ engine, hub, env }: { engine: Engine; hub: DesktopHub; env: NodeJS.ProcessEnv }): Promise<void> {
  const server = new McpServer({ name: "claude-switch", version: VERSION });
  const currentSession = env.CLAUDE_CODE_HOST_SESSION_ID?.startsWith("local_") ? env.CLAUDE_CODE_HOST_SESSION_ID : undefined;
  const projectDir = env.CLAUDE_PROJECT_DIR || process.cwd();
  const rules = new RulesStore(engine.paths.stateDir);
  const projectRule = async () => ruleFor(await rules.list(), projectDir);

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
        await (async () => {
          const rule = await projectRule();
          if (!rule) return `\nNo project rule for ${projectDir}: every account may be used.`;
          return `\nProject rule for ${rule.path}: only ${namesOf(accountDirectory(await hub.overview({ light: true })), rule.accounts)} may be used. Switches and moves stay inside these accounts unless the user agrees to an exception.`;
        })(),
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
        ignore_project_rule: z
          .boolean()
          .optional()
          .describe("Allow a profile outside this project's rule for this one move. Only pass true after the user chose that."),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ to, session, restart, ignore_project_rule }) => {
      const sessionId = session ?? currentSession;
      if (!sessionId) return failure("This conversation is not a Claude Desktop session. Pass `session` explicitly.");
      return guarded(async () => {
        const allowed = ignore_project_rule ? undefined : allowedSet(await projectRule());
        return describeHandoff(await hub.handoff({ sessionId, to, force: true, restart: restart ?? false, allowed }));
      });
    },
  );

  server.registerTool(
    "switch_cli_account",
    {
      title: "Switch the Claude Code CLI login",
      description:
        "Change which account the Claude Code CLI and the VS Code extension use. Pass an alias or email, or omit it to pick the account with the most remaining usage. Running CLI sessions pick up the change within about 30 seconds. This does not affect Claude Desktop windows; use handoff_session for those.",
      inputSchema: {
        account: z.string().optional().describe("Alias, email or id; omit to choose automatically"),
        ignore_project_rule: z
          .boolean()
          .optional()
          .describe("Allow an account outside this project's rule for this one switch. Only pass true after the user chose that."),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ account, ignore_project_rule }) =>
      guarded(async () => {
        const rule = ignore_project_rule ? null : await projectRule();
        if (account) {
          if (rule) {
            const target = resolveAccount(accountDirectory(await hub.overview({ light: true })), account);
            if (!rule.accounts.includes(target.id)) {
              throw new UserError(`${account} is not allowed for ${rule.path}. Ask the user whether to use it once (ignore_project_rule) or allow it with allow_account_for_project.`);
            }
          }
          return describeSwitch(await engine.switchTo(account));
        }
        const { decision, result } = await engine.autoSwitch({ force: true, allowed: allowedSet(rule) });
        if (result) return describeSwitch(result);
        return decision.kind === "exhausted"
          ? `Every other account is at or above the threshold.${decision.soonestReset ? ` Soonest reset: ${decision.soonestReset}.` : ""}`
          : `Staying on the current account: ${decision.reason}.`;
      }),
  );

  server.registerTool(
    "allow_account_for_project",
    {
      title: "Allow an account for this project",
      description:
        "Add an account to the current project's rule, so auto-switch and session moves may use it from now on. Only call this after the user chose to always allow that account for this project.",
      inputSchema: { account: z.string().describe("Alias, Desktop profile name, email or id of the account to allow") },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ account }) =>
      guarded(async () => {
        const rule = await projectRule();
        if (!rule) return `No project rule covers ${projectDir}, so every account is already allowed.`;
        const directory = accountDirectory(await hub.overview({ light: true }));
        const target = resolveAccount(directory, account);
        const updated = await rules.allow(rule.path, target.id);
        return `${rule.path} may now use ${namesOf(directory, updated?.accounts ?? rule.accounts)}.`;
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
