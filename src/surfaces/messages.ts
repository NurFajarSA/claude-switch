import type { SwitchResult } from "../core/engine.ts";
import type { HandoffOutcome, TargetWindow } from "../desktop/hub.ts";

const WINDOW_TEXT: Record<TargetWindow, string> = {
  focused: "Its window is in front; the session is at the top of the Code sidebar.",
  launched: "Its window is starting; the session is at the top of the Code sidebar.",
  restarted: "Its window was reopened so it loads the session; the session is at the top of the Code sidebar.",
  left_closed: "Open that profile to continue; the session is at the top of the Code sidebar.",
  needs_reopen:
    "That window was already open and only reads its session list at startup. Quit it (Cmd+Q) and open it again, or rerun with --restart, to see the session.",
};

export function describeSwitch(result: SwitchResult): string {
  switch (result.kind) {
    case "already":
      return `Already using ${result.account.alias} (${result.account.email}).`;
    case "switched":
      return `Switched ${result.from ? `from ${result.from.alias} ` : ""}to ${result.to.alias} (${result.to.email}). Running Claude Code sessions pick it up within about 30 seconds.`;
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

export function describeHandoff(outcome: HandoffOutcome): string {
  switch (outcome.kind) {
    case "moved": {
      const title = outcome.session.card.title ?? outcome.session.card.cliSessionId;
      const source = outcome.result.sourceArchived
        ? "The copy in the old profile was archived."
        : "The old window is still open; stop sending messages there so both windows do not write to the same conversation.";
      return `Moved "${title}" to profile "${outcome.to.profile.name}". ${WINDOW_TEXT[outcome.window]} ${source}`;
    }
    case "stay":
      return `Not moved: ${outcome.reason}.`;
    case "exhausted":
      return `Not moved: every other account is near its limit.${outcome.soonestReset ? ` Soonest reset: ${outcome.soonestReset}.` : ""}`;
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}
