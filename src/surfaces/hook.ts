import { z } from "zod";
import type { Engine } from "../core/engine.ts";
import type { DesktopHub, HandoffOutcome } from "../desktop/hub.ts";
import { blockingPercent, freshReading } from "../domain/usage.ts";
import type { Logger } from "../infra/log.ts";
import { describeSwitch } from "./messages.ts";

const HookInput = z.looseObject({
  hook_event_name: z.string(),
  error: z.string().nullish(),
});

export interface HookOutput {
  systemMessage?: string;
  hookSpecificOutput?: { hookEventName: string; additionalContext: string };
}

const RATE_LIMIT = /rate|limit|quota|usage|overload/i;

export async function runHook({
  engine,
  hub,
  stdin,
  env,
  log,
}: {
  engine: Engine;
  hub: DesktopHub;
  stdin: string;
  env: NodeJS.ProcessEnv;
  log: Logger;
}): Promise<HookOutput | null> {
  const input = HookInput.parse(JSON.parse(stdin));
  const event = input.hook_event_name;
  const hitLimit = event === "StopFailure" && RATE_LIMIT.test(input.error ?? "");
  if (event !== "UserPromptSubmit" && !hitLimit) return null;

  const config = await engine.config.load();
  if (!config.autoSwitch) return null;

  const desktopSession = env.CLAUDE_CODE_HOST_SESSION_ID;
  if (desktopSession?.startsWith("local_")) {
    if (!hitLimit && !(await desktopSessionNearLimit(hub, env.CLAUDE_CODE_ACCOUNT_UUID, config.threshold))) return null;
    const outcome = await hub.handoff({ sessionId: desktopSession, force: hitLimit });
    log.info("hook_desktop_handoff", { event, outcome: outcome.kind });
    return desktopMessage(event, outcome);
  }

  if (!hitLimit && !(await cliNearLimit(engine, config.threshold))) return null;
  const { decision, result } = await engine.autoSwitch({ force: hitLimit });
  log.info("hook_cli_switch", { event, decision: decision.kind });
  if (result?.kind === "switched") {
    const text = `claude-switch: ${describeSwitch(result)}`;
    return hitLimit ? { systemMessage: `${text} Send your last message again.` } : withContext(event, text, text);
  }
  if (decision.kind === "exhausted") {
    const text = `claude-switch: every account is at or above ${config.threshold}%.${decision.soonestReset ? ` Soonest reset: ${decision.soonestReset}.` : ""}`;
    return { systemMessage: text };
  }
  return null;
}

async function desktopSessionNearLimit(hub: DesktopHub, accountId: string | undefined, threshold: number): Promise<boolean> {
  const { profiles } = await hub.overview();
  const profile = profiles.find((p) => p.profile.accountId === accountId);
  const reading = freshReading(profile?.usage, Date.now());
  return reading !== null && blockingPercent(reading) >= threshold;
}

async function cliNearLimit(engine: Engine, threshold: number): Promise<boolean> {
  const status = await engine.status();
  const live = status.accounts.find((a) => a.live);
  const reading = freshReading(live?.usage, Date.now());
  return reading !== null && blockingPercent(reading) >= threshold;
}

function desktopMessage(event: string, outcome: HandoffOutcome): HookOutput | null {
  switch (outcome.kind) {
    case "moved": {
      const target = outcome.to.profile.name;
      const user = `claude-switch: this account is near its limit. The session was copied to the "${target}" Desktop profile; continue there.${outcome.window === "needs_reopen" ? " Reopen that window first (Cmd+Q, then open it)." : ""}`;
      const reopen = outcome.window === "needs_reopen" ? ` That window was already open, so the user must quit it (Cmd+Q) and open it again before the session shows up.` : "";
      const agent = `The user's Claude account for this window is near its usage limit. claude-switch copied this session to the "${target}" Claude Desktop profile.${reopen} Answer the current message briefly, then tell the user to continue in the "${target}" window.`;
      return event === "StopFailure" ? { systemMessage: user } : withContext(event, user, agent);
    }
    case "exhausted":
      return { systemMessage: `claude-switch: every Desktop account is near its limit.${outcome.soonestReset ? ` Soonest reset: ${outcome.soonestReset}.` : ""}` };
    case "stay":
      return null;
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function withContext(event: string, user: string, agent: string): HookOutput {
  return { systemMessage: user, hookSpecificOutput: { hookEventName: event, additionalContext: agent } };
}
