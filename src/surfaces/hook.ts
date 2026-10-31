import { basename, join } from "node:path";
import { z } from "zod";
import type { Engine } from "../core/engine.ts";
import { RulesStore } from "../core/rules-store.ts";
import type { DesktopHub, HandoffOutcome } from "../desktop/hub.ts";
import { displayName } from "../desktop/profiles.ts";
import { AccountId } from "../domain/account.ts";
import { allowedSet, type ProjectRule, ruleFor } from "../domain/rules.ts";
import { blockingPercent, freshReading, type SwitchDecision } from "../domain/usage.ts";
import { readRawJson, writeJsonAtomic } from "../infra/files.ts";
import type { Logger } from "../infra/log.ts";
import { type AccountEntry, accountDirectory, namesOf } from "./accounts.ts";
import { describeSwitch } from "./messages.ts";

const HookInput = z.looseObject({
  hook_event_name: z.string(),
  error: z.string().nullish(),
  cwd: z.string().nullish(),
  session_id: z.string().nullish(),
});

export interface HookOutput {
  systemMessage?: string;
  hookSpecificOutput?: { hookEventName: string; additionalContext: string };
}

const RATE_LIMIT = /rate|limit|quota|usage|overload/i;

interface Context {
  engine: Engine;
  hub: DesktopHub;
  log: Logger;
  event: string;
  hitLimit: boolean;
  threshold: number;
  rule: ProjectRule | null;
  project: string;
  directory: AccountEntry[];
  now: number;
}

export async function runHook({
  engine,
  hub,
  stdin,
  env,
  log,
  now = Date.now(),
}: {
  engine: Engine;
  hub: DesktopHub;
  stdin: string;
  env: NodeJS.ProcessEnv;
  log: Logger;
  now?: number;
}): Promise<HookOutput | null> {
  const input = HookInput.parse(JSON.parse(stdin));
  const event = input.hook_event_name;
  const hitLimit = event === "StopFailure" && RATE_LIMIT.test(input.error ?? "");
  if (event !== "UserPromptSubmit" && !hitLimit) return null;

  const config = await engine.config.load();
  if (!config.autoSwitch) return null;

  const cwd = input.cwd ?? process.cwd();
  const rule = ruleFor(await new RulesStore(engine.paths.stateDir).list(), cwd);
  const directory = rule ? accountDirectory(await hub.overview()) : [];
  const ctx: Context = { engine, hub, log, event, hitLimit, threshold: config.threshold, rule, project: basename(rule?.path ?? cwd), directory, now };

  const desktopSession = env.CLAUDE_CODE_HOST_SESSION_ID;
  if (desktopSession?.startsWith("local_")) {
    return desktopHook(ctx, desktopSession, env.CLAUDE_CODE_ACCOUNT_UUID ? AccountId(env.CLAUDE_CODE_ACCOUNT_UUID) : null);
  }
  return cliHook(ctx);
}

async function cliHook(ctx: Context): Promise<HookOutput | null> {
  const { engine, rule, hitLimit, threshold } = ctx;
  const status = await engine.status();
  const live = status.accounts.find((a) => a.live);
  const outsideRule = rule !== null && live !== undefined && !rule.accounts.includes(live.record.id);
  const reading = freshReading(live?.usage, ctx.now);
  const nearLimit = reading !== null && blockingPercent(reading) >= threshold;
  if (!hitLimit && !nearLimit && !outsideRule) return null;

  const { decision, result } = await engine.autoSwitch({ force: hitLimit || outsideRule, allowed: allowedSet(rule) });
  ctx.log.info("hook_cli_switch", { event: ctx.event, decision: decision.kind, rule: rule?.path ?? null });
  if (result?.kind === "switched") {
    const why = outsideRule ? `${ctx.project} only uses ${namesOf(ctx.directory, rule!.accounts)}. ` : "";
    const text = `claude-switch: ${why}${describeSwitch(result)}`;
    return hitLimit ? { systemMessage: `${text} Send your last message again.` } : withContext(ctx.event, text, text);
  }
  if (decision.kind === "exhausted") return exhaustedMessage(ctx, decision, "cli");
  return null;
}

async function desktopHook(ctx: Context, sessionId: string, accountId: AccountId | null): Promise<HookOutput | null> {
  const { hub, rule, hitLimit, threshold, engine } = ctx;
  const { profiles } = await hub.overview();
  const here = profiles.find((p) => p.profile.accountId === accountId);
  const outsideRule = rule !== null && accountId !== null && !rule.accounts.includes(accountId);

  if (outsideRule && !hitLimit && (await firstNotice(engine.paths.stateDir, sessionId))) {
    const allowedProfiles = profiles.filter((p) => p.profile.accountId && rule!.accounts.includes(p.profile.accountId)).map((p) => displayName(p.profile));
    const names = allowedProfiles.length > 0 ? allowedProfiles.join(", ") : namesOf(ctx.directory, rule!.accounts);
    const user = `claude-switch: ${ctx.project} is set to use ${names}, not this window's account.`;
    const agent = `Project rule: the folder ${rule!.path} may only use these Claude accounts: ${names}. This Claude Desktop window is signed in to a different account${here ? ` (${displayName(here.profile)})` : ""}. Before working, tell the user and ask whether to move this conversation to one of the allowed profiles (call the claude-switch handoff_session tool with to set to the chosen profile) or to keep going here this time.`;
    return withContext(ctx.event, user, agent);
  }

  const reading = freshReading(here?.usage, ctx.now);
  const nearLimit = reading !== null && blockingPercent(reading) >= threshold;
  if (!hitLimit && !nearLimit) return null;
  const outcome = await hub.handoff({ sessionId, force: hitLimit, allowed: allowedSet(rule) });
  ctx.log.info("hook_desktop_handoff", { event: ctx.event, outcome: outcome.kind, rule: rule?.path ?? null });
  return desktopMessage(ctx, outcome);
}

function desktopMessage(ctx: Context, outcome: HandoffOutcome): HookOutput | null {
  switch (outcome.kind) {
    case "moved": {
      const target = displayName(outcome.to.profile);
      const user = `claude-switch: this account is near its limit. The session was copied to the "${target}" Desktop profile; continue there.${outcome.window === "needs_reopen" ? " Reopen that window first (Cmd+Q, then open it)." : ""}`;
      const reopen = outcome.window === "needs_reopen" ? ` That window was already open, so the user must quit it (Cmd+Q) and open it again before the session shows up.` : "";
      const agent = `The user's Claude account for this window is near its usage limit. claude-switch copied this session to the "${target}" Claude Desktop profile.${reopen} Answer the current message briefly, then tell the user to continue in the "${target}" window.`;
      return ctx.event === "StopFailure" ? { systemMessage: user } : withContext(ctx.event, user, agent);
    }
    case "exhausted":
      return exhaustedMessage(ctx, { kind: "exhausted", soonestReset: outcome.soonestReset, outside: null }, "desktop", outcome.outside ? displayName(outcome.outside.profile) : null);
    case "stay":
      return null;
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function exhaustedMessage(
  ctx: Context,
  decision: Extract<SwitchDecision, { kind: "exhausted" }>,
  surface: "cli" | "desktop",
  desktopOutside: string | null = null,
): HookOutput {
  const reset = decision.soonestReset ? ` The soonest reset is ${decision.soonestReset}.` : "";
  if (!ctx.rule) {
    return { systemMessage: `claude-switch: every account is at or above ${ctx.threshold}%.${reset}` };
  }
  const allowed = namesOf(ctx.directory, ctx.rule.accounts);
  const outside = surface === "cli" ? decision.outside?.alias ?? null : desktopOutside;
  const user = `claude-switch: every account allowed for ${ctx.project} (${allowed}) is near its limit.${reset}`;
  if (!outside) return { systemMessage: `${user} No other account has usage left either.` };
  const once =
    surface === "cli"
      ? `call the claude-switch switch_cli_account tool with account "${outside}" and ignore_project_rule true`
      : `call the claude-switch handoff_session tool with to "${outside}" and ignore_project_rule true`;
  const agent = `Every Claude account allowed for the project ${ctx.rule.path} (${allowed}) is at or above ${ctx.threshold}% of its limit.${reset} Before doing more work, ask the user to choose one option, as a short multiple-choice question:
1. Wait until the allowed accounts reset (do nothing now).
2. Use ${outside} just this once: ${once}.
3. Always allow ${outside} for this project: call the claude-switch allow_account_for_project tool with account "${outside}", then ${once.replace(" and ignore_project_rule true", "")}.
Then continue with the user's request only if they chose option 2 or 3.`;
  return ctx.event === "StopFailure" ? { systemMessage: `${user} Ask Claude to switch if you want to use ${outside}.` } : withContext(ctx.event, user, agent);
}

async function firstNotice(stateDir: string, sessionId: string): Promise<boolean> {
  const file = join(stateDir, "rule-notices.json");
  const seen = (await readRawJson(file).catch(() => null)) ?? {};
  if (seen[sessionId]) return false;
  await writeJsonAtomic(file, { ...seen, [sessionId]: new Date().toISOString() });
  return true;
}

function withContext(event: string, user: string, agent: string): HookOutput {
  return { systemMessage: user, hookSpecificOutput: { hookEventName: event, additionalContext: agent } };
}
