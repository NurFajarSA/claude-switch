import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RulesStore } from "../src/core/rules-store.ts";
import { DesktopHub } from "../src/desktop/hub.ts";
import type { DesktopWindows } from "../src/desktop/process.ts";
import { AccountId } from "../src/domain/account.ts";
import { ruleFor } from "../src/domain/rules.ts";
import { type Candidate, decideSwitch } from "../src/domain/usage.ts";
import { silentLogger } from "../src/infra/log.ts";
import { runHook } from "../src/surfaces/hook.ts";
import { withAccounts } from "./support.ts";

const NOW = Date.parse("2026-10-31T10:00:00Z");
const id = (s: string) => AccountId(s);
const candidate = (name: string, percent: number): Candidate => ({
  id: id(name),
  alias: name,
  health: { kind: "ok" },
  usage: {
    accountId: id(name),
    checkedAt: new Date(NOW).toISOString(),
    error: null,
    reading: { fetchedAt: new Date(NOW).toISOString(), windows: [{ kind: "session", group: "session", percent, resetsAt: null, scope: null }] },
  },
});

describe("ruleFor", () => {
  const rules = [
    { path: "/work/analitica", accounts: [id("a")] },
    { path: "/work/analitica/ui", accounts: [id("b")] },
  ];

  test("picks the deepest folder that contains the session folder", () => {
    expect(ruleFor(rules, "/work/analitica/pipeline")?.accounts).toEqual([id("a")]);
    expect(ruleFor(rules, "/work/analitica/ui/app")?.accounts).toEqual([id("b")]);
    expect(ruleFor(rules, "/work/analitica/")?.accounts).toEqual([id("a")]);
  });

  test("does not match a sibling folder that only shares a prefix", () => {
    expect(ruleFor(rules, "/work/analitica-old")).toBeNull();
    expect(ruleFor(rules, null)).toBeNull();
  });
});

describe("decideSwitch with a project rule", () => {
  test("moves off an account the project does not allow even when it has usage left", () => {
    const decision = decideSwitch({
      live: id("kantor"),
      candidates: [candidate("kantor", 10), candidate("pribadi", 60), candidate("klien", 5)],
      threshold: 95,
      now: NOW,
      force: false,
      allowed: new Set([id("pribadi")]),
    });

    expect(decision.kind === "switch" ? [decision.to.alias, decision.reason] : decision).toEqual([
      "pribadi",
      "active account is not allowed for this project; pribadi at 60%",
    ]);
  });

  test("never picks an account outside the rule, and offers the best one as the outside option", () => {
    const decision = decideSwitch({
      live: id("pribadi"),
      candidates: [candidate("pribadi", 97), candidate("kantor", 99), candidate("klien", 5)],
      threshold: 95,
      now: NOW,
      force: false,
      allowed: new Set([id("pribadi"), id("kantor")]),
    });

    expect(decision.kind).toBe("exhausted");
    expect(decision.kind === "exhausted" ? decision.outside?.alias : null).toBe("klien");
  });
});

describe("RulesStore", () => {
  test("sets, extends and removes the rule for a folder", async () => {
    const store = new RulesStore(await mkdtemp(join(tmpdir(), "claude-switch-rules-")));
    await store.set("/work/analitica/", [id("a")]);
    await store.allow("/work/analitica", id("b"));
    await store.allow("/work/analitica", id("b"));

    expect(await store.list()).toEqual([{ path: "/work/analitica", accounts: [id("a"), id("b")] }]);
    expect(await store.allow("/work/other", id("a"))).toBeNull();
    expect(await store.remove("/work/analitica")).toBe(true);
    expect(await store.list()).toEqual([]);
  });
});

describe("hook with project rules (CLI)", () => {
  const noWindows: DesktopWindows = {
    isRunning: async () => false,
    open: async () => "launched",
    restart: async () => "restarted",
    quit: async () => {},
  };

  const hookFor = async (rule: string[], percents: Record<string, number>) => {
    const t = await withAccounts(
      { id: "acct-a", email: "kantor@example.com", percent: percents.a ?? 10 },
      { id: "acct-b", email: "pribadi@example.com", percent: percents.b ?? 10 },
      { id: "acct-c", email: "klien@example.com", percent: percents.c ?? 10 },
    );
    await new RulesStore(t.paths.stateDir).set("/work/analitica", rule.map(id));
    await t.engine.pollAll();
    const hub = new DesktopHub(t.engine, { appSupportDir: await mkdtemp(join(tmpdir(), "claude-switch-none-")), windows: noWindows });
    const run = () =>
      runHook({
        engine: t.engine,
        hub,
        stdin: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: "/work/analitica/src" }),
        env: {},
        log: silentLogger,
        now: NOW,
      });
    return { t, run };
  };

  test("switches the CLI to an allowed account when the project does not allow the current one", async () => {
    const { t, run } = await hookFor(["acct-a"], {});

    const output = await run();

    expect((await t.liveBlob()).claudeAiOauth.refreshToken).toStartWith("rt-acct-a");
    expect(output?.systemMessage).toContain("analitica only uses kantor");
  });

  test("asks the user what to do when every allowed account is used up", async () => {
    const { run } = await hookFor(["acct-c", "acct-b"], { b: 97, c: 98, a: 20 });

    const output = await run();

    expect(output?.systemMessage).toContain("every account allowed for analitica");
    expect(output?.hookSpecificOutput?.additionalContext).toContain("Use kantor just this once");
    expect(output?.hookSpecificOutput?.additionalContext).toContain("allow_account_for_project");
  });
});
