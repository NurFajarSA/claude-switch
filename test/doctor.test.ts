import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CHECKS, type CheckResult, type DoctorDeps, type ExecResult, renderDoctor, runDoctor } from "../src/surfaces/doctor.ts";
import { hookCommand, layout } from "../src/surfaces/install.ts";
import { HOUR, setup, withAccounts } from "./support.ts";

const NOW = Date.parse("2026-10-31T10:00:00Z");
const DAY = 24 * HOUR;

type T = Awaited<ReturnType<typeof setup>>;

function depsFor(t: T, overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    paths: t.paths,
    secrets: t.secrets,
    api: t.api,
    engine: t.engine,
    now: () => NOW,
    appSupportDir: join(t.paths.home, "Library", "Application Support"),
    updates: { appBundle: join(t.paths.home, "Claude.app"), shipItState: join(t.paths.home, "ShipItState.plist") },
    uid: 501,
    which: () => "/usr/local/bin/claude",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    ...overrides,
  };
}

async function run(id: string, deps: DoctorDeps): Promise<CheckResult> {
  const check = CHECKS.find((c) => c.id === id);
  if (!check) throw new Error(`no check ${id}`);
  const [result] = await runDoctor(deps, [check]);
  return result!;
}

const execReturning = (result: Partial<ExecResult>) => async (): Promise<ExecResult> => ({ code: 0, stdout: "", stderr: "", ...result });

describe("live-credential", () => {
  test("fails when the Keychain item is missing", async () => {
    const t = await setup();
    expect(await run("live-credential", depsFor(t))).toEqual({
      id: "live-credential",
      title: "Live Keychain credential",
      status: "fail",
      detail: 'no Keychain item "live"',
      fix: "Log in with `claude auth login`.",
    });
  });

  test("fails when the item is not JSON", async () => {
    const t = await setup();
    await t.secrets.set("live", "user", "not json");
    const result = await run("live-credential", depsFor(t));
    expect(result.status).toBe("fail");
    expect(result.detail).toBe('item "live" is not valid JSON');
  });

  test("fails when claudeAiOauth lacks a refresh token", async () => {
    const t = await setup();
    await t.secrets.set("live", "user", JSON.stringify({ claudeAiOauth: { accessToken: "a", expiresAt: 1 } }));
    const result = await run("live-credential", depsFor(t));
    expect(result.status).toBe("fail");
    expect(result.detail).toBe("claudeAiOauth has an unexpected shape (claudeAiOauth.refreshToken)");
  });

  test("fails when only mcpOAuth is present", async () => {
    const t = await setup();
    await t.secrets.set("live", "user", JSON.stringify({ mcpOAuth: {} }));
    const result = await run("live-credential", depsFor(t));
    expect(result.status).toBe("fail");
    expect(result.detail).toBe("item has no claudeAiOauth");
  });

  test("is ok and lists mcpOAuth key names without token values", async () => {
    const t = await setup();
    t.api.add({ id: "acc-a", email: "alice@example.com", percent: 10 });
    await t.login("acc-a");
    const result = await run("live-credential", depsFor(t));
    expect(result.status).toBe("ok");
    expect(result.detail).toBe("claudeAiOauth ok, access token valid for 480 min; mcpOAuth present (1 keys: linear)");
    expect(JSON.stringify(result)).not.toContain("mcp-token");
    expect(JSON.stringify(result)).not.toContain("at-acc-a");
  });

  test("reports mcpOAuth absent and an expired access token as ok", async () => {
    const t = await setup();
    await t.secrets.set("live", "user", JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: NOW - 1 } }));
    const result = await run("live-credential", depsFor(t));
    expect(result.status).toBe("ok");
    expect(result.detail).toBe("claudeAiOauth ok, access token expired (Claude Code refreshes it on next use); mcpOAuth absent");
  });
});

describe("endpoints", () => {
  test("is ok when both endpoints parse", async () => {
    const t = await setup();
    t.api.add({ id: "acc-a", email: "alice@example.com", percent: 10 });
    await t.login("acc-a");
    const result = await run("endpoints", depsFor(t));
    expect(result.status).toBe("ok");
    expect(result.detail).toBe("/api/oauth/profile ok; /api/oauth/usage ok");
  });

  test("warns instead of failing when the token is expired", async () => {
    const t = await setup();
    await t.secrets.set("live", "user", JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: NOW - 1 } }));
    const result = await run("endpoints", depsFor(t));
    expect(result.status).toBe("warn");
    expect(result.detail).toBe("skipped, live access token is expired");
  });

  test("fails when the server rejects a valid-looking token", async () => {
    const t = await setup();
    await t.secrets.set("live", "user", JSON.stringify({ claudeAiOauth: { accessToken: "unknown", refreshToken: "r", expiresAt: NOW + HOUR } }));
    const result = await run("endpoints", depsFor(t));
    expect(result.status).toBe("fail");
    expect(result.detail).toBe("/api/oauth/profile: unauthorized: unknown token; /api/oauth/usage: unauthorized: unknown token");
  });
});

describe("vault", () => {
  const alice = { id: "acc-a", email: "alice@example.com", percent: 10 };
  const bob = { id: "acc-b", email: "bob@example.com", percent: 20 };

  async function park(t: T, refreshTokenExpiresAt: number) {
    const parked = await t.parked("acc-a");
    await t.secrets.set("vault", "acc-a", JSON.stringify({ ...parked, refreshTokenExpiresAt }));
  }

  test("warns when a parked refresh token has fewer than 5 days left", async () => {
    const t = await withAccounts(alice, bob);
    await park(t, NOW + 3 * DAY + HOUR);
    const result = await run("vault", depsFor(t));
    expect(result.status).toBe("warn");
    expect(result.detail).toBe("alice: parked, 3d left; bob: live, refresh token expiry unknown");
    expect(result.fix).toBe("Run `cs relogin alice` soon.");
  });

  test("is ok with 20 days left", async () => {
    const t = await withAccounts(alice, bob);
    await park(t, NOW + 20 * DAY + HOUR);
    const result = await run("vault", depsFor(t));
    expect(result.status).toBe("ok");
    expect(result.detail).toBe("alice: parked, 20d left; bob: live, refresh token expiry unknown");
  });

  test("fails when the refresh token already expired", async () => {
    const t = await withAccounts(alice, bob);
    await park(t, NOW - HOUR);
    const result = await run("vault", depsFor(t));
    expect(result.status).toBe("fail");
    expect(result.detail).toBe("alice: parked, refresh token expired; bob: live, refresh token expiry unknown");
  });

  test("fails when a registered non-live account has no parked credential", async () => {
    const t = await withAccounts(alice, bob);
    await t.secrets.delete("vault", "acc-a");
    const result = await run("vault", depsFor(t));
    expect(result.status).toBe("fail");
    expect(result.detail).toBe("alice: no parked credential; bob: live, refresh token expiry unknown");
    expect(result.fix).toBe("Run `cs relogin alice` or `cs add alice`.");
  });

  test("warns when nothing is registered", async () => {
    const t = await setup();
    const result = await run("vault", depsFor(t));
    expect(result.status).toBe("warn");
    expect(result.detail).toBe("no registered accounts");
  });
});

describe("desktop-app", () => {
  async function bundle(t: T, version: string) {
    const contents = join(t.paths.home, "Claude.app", "Contents");
    await mkdir(contents, { recursive: true });
    await writeFile(
      join(contents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
    );
  }

  test("is ok for a tested major version", async () => {
    const t = await setup();
    await bundle(t, "4.4212.0");
    expect(await run("desktop-app", depsFor(t))).toEqual({ id: "desktop-app", title: "Claude Desktop", status: "ok", detail: "4.4212.0" });
  });

  test("warns for an untested major version", async () => {
    const t = await setup();
    await bundle(t, "5.0.1");
    const result = await run("desktop-app", depsFor(t));
    expect(result.status).toBe("warn");
    expect(result.detail).toBe("5.0.1; claude-switch was tested on 4.x");
  });

  test("warns when the app bundle is missing", async () => {
    const t = await setup();
    const result = await run("desktop-app", depsFor(t));
    expect(result.status).toBe("warn");
    expect(result.detail).toBe(`no readable version at ${join(t.paths.home, "Claude.app")}`);
  });
});

describe("desktop-sessions", () => {
  async function profile(t: T, cards: Record<string, string>) {
    const dir = join(t.paths.home, "Library", "Application Support", "Claude-work");
    const root = join(dir, "claude-code-sessions", "acc-a", "org-a");
    await mkdir(root, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify({ lastKnownAccountUuid: "acc-a" }));
    for (const [name, body] of Object.entries(cards)) await writeFile(join(root, name), body);
  }

  test("is ok when cards parse with the SessionCard schema", async () => {
    const t = await setup();
    await profile(t, { "local_1.json": JSON.stringify({ sessionId: "local_1", cliSessionId: "cli-1" }) });
    const result = await run("desktop-sessions", depsFor(t));
    expect(result.status).toBe("ok");
    expect(result.detail).toBe("1 of 1 session cards parse");
  });

  test("fails when no card parses", async () => {
    const t = await setup();
    await profile(t, { "local_1.json": JSON.stringify({ id: "x" }) });
    const result = await run("desktop-sessions", depsFor(t));
    expect(result.status).toBe("fail");
    expect(result.detail).toBe("0 of 1 session cards parse");
  });

  test("warns when only some cards parse", async () => {
    const t = await setup();
    await profile(t, {
      "local_1.json": JSON.stringify({ sessionId: "local_1", cliSessionId: "cli-1" }),
      "local_2.json": "{",
    });
    const result = await run("desktop-sessions", depsFor(t));
    expect(result.status).toBe("warn");
    expect(result.detail).toBe("1 of 2 session cards parse");
  });
});

describe("claude-cli", () => {
  test("is ok on the tested major.minor", async () => {
    const t = await setup();
    const result = await run("claude-cli", depsFor(t, { exec: execReturning({ stdout: "2.1.287 (Claude Code)\n" }) }));
    expect(result.status).toBe("ok");
    expect(result.detail).toBe("2.1.287 at /usr/local/bin/claude");
  });

  test("warns on a different minor version", async () => {
    const t = await setup();
    const result = await run("claude-cli", depsFor(t, { exec: execReturning({ stdout: "2.2.0 (Claude Code)\n" }) }));
    expect(result.status).toBe("warn");
    expect(result.detail).toBe("2.2.0 at /usr/local/bin/claude; claude-switch was tested on 2.1.x");
  });

  test("fails when claude is not on PATH", async () => {
    const t = await setup();
    const result = await run("claude-cli", depsFor(t, { which: () => null }));
    expect(result.status).toBe("fail");
    expect(result.detail).toBe("`claude` is not on PATH");
  });
});

describe("installation", () => {
  test("daemon fails when launchd does not report running", async () => {
    const t = await setup();
    const plist = join(layout(t.paths).launchAgents, "app.claude-switch.daemon.plist");
    await mkdir(layout(t.paths).launchAgents, { recursive: true });
    await writeFile(plist, "<plist/>");
    const waiting = await run("install-daemon", depsFor(t, { exec: execReturning({ stdout: "gui/501/app.claude-switch.daemon = {\n\tstate = waiting\n}" }) }));
    const running = await run("install-daemon", depsFor(t, { exec: execReturning({ stdout: "gui/501/app.claude-switch.daemon = {\n\tstate = running\n}" }) }));
    expect(waiting.status).toBe("fail");
    expect(waiting.detail).toBe("app.claude-switch.daemon state is waiting");
    expect(running.status).toBe("ok");
  });

  test("hooks check requires both events with the cs hook command", async () => {
    const t = await setup();
    const command = hookCommand(layout(t.paths).bin);
    await mkdir(t.paths.claudeConfigDir, { recursive: true });
    await writeFile(t.paths.claudeSettings, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command }] }] } }));
    const partial = await run("install-hooks", depsFor(t));
    await writeFile(
      t.paths.claudeSettings,
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command }] }], StopFailure: [{ hooks: [{ command }] }] } }),
    );
    const complete = await run("install-hooks", depsFor(t));
    expect(partial.status).toBe("fail");
    expect(partial.detail).toBe(`missing in ${t.paths.claudeSettings}: StopFailure`);
    expect(complete.status).toBe("ok");
  });

  test("mcp check follows the exit code of `claude mcp get`", async () => {
    const t = await setup();
    const registered = await run("install-mcp", depsFor(t));
    const missing = await run("install-mcp", depsFor(t, { exec: execReturning({ code: 1 }) }));
    expect(registered.status).toBe("ok");
    expect(missing.status).toBe("fail");
    expect(missing.detail).toBe('"claude-switch" is not registered');
  });
});

describe("runDoctor and renderDoctor", () => {
  test("a throwing check becomes a fail and the other checks still run", async () => {
    const t = await setup();
    const results = await runDoctor(depsFor(t), [
      { id: "boom", title: "Boom", run: async () => Promise.reject(new Error("keychain locked")) },
      { id: "fine", title: "Fine", run: async () => ({ status: "ok", detail: "good" }) },
    ]);
    expect(results).toEqual([
      { id: "boom", title: "Boom", status: "fail", detail: "check crashed: keychain locked" },
      { id: "fine", title: "Fine", status: "ok", detail: "good" },
    ]);
  });

  test("renders one line per check with a mark and a fix hint for non-ok results", () => {
    const text = renderDoctor(
      [
        { id: "a", title: "A", status: "ok", detail: "fine" },
        { id: "bb", title: "BB", status: "warn", detail: "careful", fix: "do x" },
        { id: "c", title: "C", status: "fail", detail: "broken", fix: "do y" },
      ],
      false,
    );
    expect(text).toBe(["✓ A   fine", "! BB  careful", "      fix: do x", "✗ C   broken", "      fix: do y"].join("\n"));
  });
});
