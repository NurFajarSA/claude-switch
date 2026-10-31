import { describe, expect, test } from "bun:test";
import { AccountId } from "../src/domain/account.ts";
import { HOUR, setup, withAccounts } from "./support.ts";

const A = { id: "acct-a", email: "kantor@example.com", percent: 96 };
const B = { id: "acct-b", email: "pribadi@example.com", percent: 10 };
const C = { id: "acct-c", email: "klien@example.com", percent: 50 };

describe("register", () => {
  test("records the logged-in account with an alias derived from its email and keeps no parked copy", async () => {
    const t = await setup();
    t.api.add(A);
    await t.login(A.id);

    const record = await t.engine.register();

    expect(record).toMatchObject({ id: "acct-a", alias: "kantor", email: "kantor@example.com", plan: "Max 5x" });
    expect(await t.parked(A.id)).toBeNull();
  });

  test("fails with a clear message when Claude Code is logged out", async () => {
    const t = await setup();
    await expect(t.engine.register()).rejects.toThrow("not logged in");
  });
});

describe("adding accounts through login", () => {
  test("parks every previous account and leaves the last login active", async () => {
    const t = await withAccounts(A, B, C);
    const status = await t.newEngine().status();

    expect(status.live?.id as string | undefined).toBe("acct-c");
    expect(status.accounts.map((a) => a.record.alias)).toEqual(["kantor", "pribadi", "klien"]);
    expect((await t.parked(A.id)).refreshToken).toStartWith("rt-acct-a");
    expect((await t.parked(B.id)).refreshToken).toStartWith("rt-acct-b");
    expect(await t.parked(C.id)).toBeNull();
  });

  test("an aborted login keeps the original account active and drops the duplicate parked copy", async () => {
    const t = await setup();
    t.api.add(A);
    await t.login(A.id);
    const parked = await t.engine.parkLiveForLogin();

    const result = await t.engine.finishLogin({ previous: parked?.id ?? null });

    expect(result.kind).toBe("same_account");
    expect((await t.engine.status()).live?.id as string | undefined).toBe("acct-a");
    expect(await t.parked(A.id)).toBeNull();
  });

  test("signing in with the same account again keeps its alias instead of taking the new one", async () => {
    const t = await setup();
    t.api.add(A);
    await t.login(A.id);
    await t.engine.register();
    const parked = await t.engine.parkLiveForLogin();
    await t.login(A.id);

    const result = await t.engine.finishLogin({ previous: parked?.id ?? null, alias: "xplora" });

    expect(result.kind === "same_account" && result.account.alias).toBe("kantor");
    expect((await t.engine.status()).accounts.map((a) => a.record.alias)).toEqual(["kantor"]);
  });

  test("a new account gets the requested alias", async () => {
    const t = await setup();
    t.api.add(A);
    t.api.add(B);
    await t.login(A.id);
    await t.engine.register();
    const parked = await t.engine.parkLiveForLogin();
    await t.login(B.id);

    const result = await t.engine.finishLogin({ previous: parked?.id ?? null, alias: "xplora" });

    expect(result.kind === "added" && result.account.alias).toBe("xplora");
    expect((await t.parked(A.id)).refreshToken).toStartWith("rt-acct-a");
  });

  test("rejects a taken alias before any login starts", async () => {
    const t = await withAccounts(A, B);
    await expect(t.engine.assertAliasAvailable("kantor")).rejects.toThrow("taken");
  });

  test("reconcile leaves the parked copy alone while a login is in progress", async () => {
    const t = await setup();
    t.api.add(A);
    await t.login(A.id);
    await t.engine.parkLiveForLogin();

    await t.newEngine().reconcile();

    expect(await t.parked(A.id)).not.toBeNull();
  });
});

describe("switch", () => {
  test("installs the target credential, parks the previous one and keeps MCP OAuth tokens", async () => {
    const t = await withAccounts(A, B);
    const parkedA = await t.parked(A.id);
    const liveB = (await t.liveBlob()).claudeAiOauth;

    const result = await t.engine.switchTo("kantor");

    const live = await t.liveBlob();
    expect(result.kind).toBe("switched");
    expect(live.claudeAiOauth).toEqual(parkedA);
    expect(live.organizationUuid).toBe("org-acct-a");
    expect(live.mcpOAuth).toEqual({ linear: { accessToken: "mcp-token" } });
    expect(await t.parked(B.id)).toEqual(liveB);
    expect(await t.parked(A.id)).toBeNull();
    expect((await t.claudeJson()).oauthAccount.accountUuid).toBe("acct-a");
  });

  test("parks the credential Claude Code rotated while the account was active", async () => {
    const t = await withAccounts(A, B);
    const rotated = await t.login(B.id);

    await t.engine.switchTo("kantor");

    expect((await t.parked(B.id)).refreshToken).toBe(rotated.refreshToken);
  });

  test("is a no-op when the target is already active", async () => {
    const t = await withAccounts(A, B);
    const before = await t.liveBlob();

    const result = await t.engine.switchTo("pribadi");

    expect(result.kind).toBe("already");
    expect(await t.liveBlob()).toEqual(before);
  });

  test("refreshes an expiring parked token and persists the rotated refresh token before use", async () => {
    const t = await withAccounts(A, B);
    t.advance(8 * HOUR);

    await t.engine.switchTo("kantor");

    const live = await t.liveBlob();
    expect(t.api.refreshCalls).toBe(1);
    expect(live.claudeAiOauth.expiresAt).toBeGreaterThan(Date.parse("2026-10-31T18:00:00Z"));
    expect(t.api.revokedRefresh.has(live.claudeAiOauth.refreshToken)).toBe(false);
  });

  test("marks an account as needing login when its refresh token is rejected", async () => {
    const t = await withAccounts(A, B);
    t.advance(8 * HOUR);
    t.api.revokedRefresh.add((await t.parked(A.id)).refreshToken);

    await expect(t.engine.switchTo("kantor")).rejects.toThrow("expired");

    const status = await t.engine.status();
    expect(status.live?.id as string | undefined).toBe("acct-b");
    expect(status.accounts.find((a) => a.record.id === "acct-a")?.record.health.kind).toBe("needs_login");
  });

  test("rejects unknown accounts with the list of known aliases", async () => {
    const t = await withAccounts(A, B);
    await expect(t.engine.switchTo("nope")).rejects.toThrow("Known accounts: kantor, pribadi");
  });

  test("retries once when Claude Code rewrites its credential mid-switch", async () => {
    const t = await withAccounts(A, B);
    const realSet = t.secrets.set.bind(t.secrets);
    let interfered = false;
    t.secrets.set = async (service, account, value) => {
      if (service === "vault" && !interfered) {
        interfered = true;
        await t.login(B.id);
      }
      return realSet(service, account, value);
    };

    const result = await t.engine.switchTo("kantor");

    expect(result.kind).toBe("switched");
    expect((await t.liveBlob()).claudeAiOauth.refreshToken).toStartWith("rt-acct-a");
    expect(interfered).toBe(true);
  });
});

describe("usage polling and auto switch", () => {
  test("polls every account and stores one record per account", async () => {
    const t = await withAccounts(A, B, C);

    const records = await t.engine.pollAll();

    expect(Object.fromEntries(records.map((r) => [r.accountId, r.reading?.windows[0]?.percent]))).toEqual({
      "acct-a": 96,
      "acct-b": 10,
      "acct-c": 50,
    });
  });

  test("switches away from an exhausted account to the one with the most headroom", async () => {
    const t = await withAccounts(B, C, A);

    const { decision, result } = await t.engine.autoSwitch({ force: false });

    expect(decision.kind).toBe("switch");
    expect(result?.kind === "switched" && result.to.alias).toBe("pribadi");
    expect((await t.liveBlob()).claudeAiOauth.refreshToken).toStartWith("rt-acct-b");
  });

  test("stays when the active account is under the threshold", async () => {
    const t = await withAccounts(A, B, C);

    const { decision } = await t.engine.autoSwitch({ force: false });

    expect(decision).toEqual({ kind: "stay", reason: "active account at 50%" });
  });

  test("reports the soonest reset when every account is exhausted", async () => {
    const t = await withAccounts(
      { ...A, resetsAt: "2026-10-31T13:00:00Z" },
      { ...B, percent: 99, resetsAt: "2026-10-31T11:30:00Z" },
    );

    const { decision } = await t.engine.autoSwitch({ force: false });

    expect(decision).toEqual({ kind: "exhausted", soonestReset: "2026-10-31T11:30:00Z" });
  });

  test("keeps the last reading and reports an error when the live token has expired", async () => {
    const t = await withAccounts(A, B);
    await t.engine.pollAll();
    t.advance(9 * HOUR);

    const records = await t.engine.pollAll();
    const live = records.find((r) => r.accountId === "acct-b");

    expect(live?.error).toContain("token expired");
    expect(live?.reading?.windows[0]?.percent).toBe(10);
  });
});

describe("rename and remove", () => {
  test("renames an account and rejects duplicate or invalid aliases", async () => {
    const t = await withAccounts(A, B);
    expect((await t.engine.rename("kantor", "work")).alias).toBe("work");
    await expect(t.engine.rename("work", "pribadi")).rejects.toThrow("taken");
    await expect(t.engine.rename("work", "Bad Alias")).rejects.toThrow("lowercase");
  });

  test("removes a parked account with its credential but refuses the active one", async () => {
    const t = await withAccounts(A, B);
    await expect(t.engine.remove("pribadi")).rejects.toThrow("active account");

    await t.engine.remove("kantor");

    expect(await t.parked(A.id)).toBeNull();
    expect((await t.engine.status()).accounts.map((a) => a.record.alias)).toEqual(["pribadi"]);
  });
});

describe("logging in for a specific account", () => {
  test("renewing a parked account replaces its stored login and keeps its alias", async () => {
    const t = await withAccounts(A, B);
    const oldParked = await t.parked(A.id);
    const parked = await t.engine.parkLiveForLogin();
    await t.login(A.id);

    const result = await t.engine.finishLogin({ previous: parked?.id ?? null, expected: AccountId("acct-a") });
    await t.engine.switchTo("pribadi");

    expect(result.kind === "renewed" && result.account.alias).toBe("kantor");
    expect((await t.parked(A.id)).refreshToken).not.toBe(oldParked.refreshToken);
    expect((await t.liveBlob()).claudeAiOauth.refreshToken).toStartWith("rt-acct-b");
  });

  test("a login to a different account than expected is reported and does not take the requested alias", async () => {
    const t = await withAccounts(A, B);
    t.api.add(C);
    const parked = await t.engine.parkLiveForLogin();
    await t.login(C.id);

    const result = await t.engine.finishLogin({ previous: parked?.id ?? null, alias: "kantor-2", expected: AccountId("acct-a") });

    expect(result.kind).toBe("unexpected_account");
    expect(result.kind === "unexpected_account" && result.account.alias).toBe("klien");
  });

  test("status reports when each stored login expires", async () => {
    const t = await withAccounts(A, B);
    const live = await t.liveBlob();
    await t.secrets.set("live", "user", JSON.stringify({ ...live, claudeAiOauth: { ...live.claudeAiOauth, refreshTokenExpiresAt: 111 } }));
    await t.secrets.set("vault", A.id, JSON.stringify({ ...(await t.parked(A.id)), refreshTokenExpiresAt: 222 }));

    const expiries = Object.fromEntries((await t.newEngine().status()).accounts.map((a) => [a.record.alias, a.loginExpiresAt]));

    expect(expiries).toEqual({ kantor: 222, pribadi: 111 });
  });
});
