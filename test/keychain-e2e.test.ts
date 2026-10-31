import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/core/engine.ts";
import { AccountId } from "../src/domain/account.ts";
import { HttpAnthropicApi } from "../src/infra/anthropic.ts";
import { MacKeychain } from "../src/infra/keychain.ts";
import type { Paths } from "../src/infra/paths.ts";

const enabled = process.platform === "darwin" && !process.env.CI_NO_KEYCHAIN;
const suite = enabled ? describe : describe.skip;

const HOUR = 3_600_000;
const suffix = randomBytes(6).toString("hex");
const LIVE_SERVICE = `claude-switch-test-live-${suffix}`;
const VAULT_SERVICE = `claude-switch-test-vault-${suffix}`;
const ROUNDTRIP_SERVICE = `claude-switch-test-roundtrip-${suffix}`;
const KEYCHAIN_ACCOUNT = "claude-switch-test";
const ALICE = `acc-alice-${suffix}`;
const BOB = `acc-bob-${suffix}`;
const BIG_MCP_KEY = "big-server|0123456789abcdef";

interface FakeAccount {
  id: string;
  email: string;
  percent: number;
}

interface IssuedToken {
  accountId: string;
  kind: "access" | "refresh";
  revoked: boolean;
}

function startFakeAnthropic(accounts: FakeAccount[]) {
  const tokens = new Map<string, IssuedToken>();
  let seq = 0;
  const issue = (accountId: string, ttlMs: number) => {
    const n = ++seq;
    const accessToken = `at-${accountId}-${n}`;
    const refreshToken = `rt-${accountId}-${n}`;
    tokens.set(accessToken, { accountId, kind: "access", revoked: false });
    tokens.set(refreshToken, { accountId, kind: "refresh", revoked: false });
    return { accessToken, refreshToken, expiresAt: Date.now() + ttlMs, scopes: ["user:inference", "user:profile"] };
  };
  const accountFor = (request: Request) => {
    const token = tokens.get(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    return token?.kind === "access" ? accounts.find((a) => a.id === token.accountId) : undefined;
  };
  const calls: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (path === "/token") {
        const body = (await request.json()) as { refresh_token: string };
        const token = tokens.get(body.refresh_token);
        if (!token || token.kind !== "refresh" || token.revoked) return new Response('{"error":"invalid_grant"}', { status: 400 });
        token.revoked = true;
        const next = issue(token.accountId, 8 * HOUR);
        return Response.json({ access_token: next.accessToken, refresh_token: next.refreshToken, expires_in: 8 * 3600, scope: "user:inference user:profile" });
      }
      const account = accountFor(request);
      if (!account) return new Response("unauthorized", { status: 401 });
      if (path === "/api/oauth/profile") {
        return Response.json({
          account: { uuid: account.id, email: account.email, has_claude_max: true, has_claude_pro: false },
          organization: { uuid: `org-${account.id}`, name: null, organization_type: "claude_max", rate_limit_tier: "default_claude_max_5x" },
        });
      }
      if (path === "/api/oauth/usage") {
        return Response.json({ limits: [{ kind: "session", group: "session", percent: account.percent, resets_at: null, scope: null }] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, issue, calls, url: `http://127.0.0.1:${server.port}` };
}

suite("MacKeychain end to end against the real Keychain", () => {
  const keychain = new MacKeychain();
  const fake = enabled
    ? startFakeAnthropic([
        { id: ALICE, email: "alice@example.com", percent: 40 },
        { id: BOB, email: "bob@example.com", percent: 70 },
      ])
    : null;
  let dir = "";
  let paths: Paths;
  let engine: Engine;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "claude-switch-keychain-e2e-"));
    paths = {
      home: dir,
      stateDir: join(dir, "state"),
      accountsFile: join(dir, "state", "accounts.json"),
      configFile: join(dir, "state", "config.json"),
      usageDir: join(dir, "state", "usage"),
      lockDir: join(dir, "state", "lock"),
      loginPendingFile: join(dir, "state", "login-pending.json"),
      logFile: join(dir, "state", "log"),
      claudeConfigDir: join(dir, ".claude"),
      claudeJson: join(dir, ".claude.json"),
      claudeSettings: join(dir, ".claude", "settings.json"),
      liveService: LIVE_SERVICE,
      keychainAccount: KEYCHAIN_ACCOUNT,
      vaultService: VAULT_SERVICE,
    };
    const api = new HttpAnthropicApi({ apiBase: fake!.url, tokenUrl: `${fake!.url}/token` });
    engine = new Engine({ paths, secrets: keychain, api });
  });

  afterAll(async () => {
    await keychain.delete(LIVE_SERVICE, KEYCHAIN_ACCOUNT).catch(() => {});
    await keychain.delete(ROUNDTRIP_SERVICE, KEYCHAIN_ACCOUNT).catch(() => {});
    for (const id of [ALICE, BOB]) await keychain.delete(VAULT_SERVICE, id).catch(() => {});
    fake?.server.stop(true);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const logIn = async (id: string, credential: ReturnType<NonNullable<typeof fake>["issue"]>) => {
    const raw = await keychain.get(LIVE_SERVICE, KEYCHAIN_ACCOUNT);
    const previous = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const mcpOAuth = previous.mcpOAuth ?? { [BIG_MCP_KEY]: { accessToken: "m".repeat(6000), refreshToken: "mcp-refresh" } };
    await keychain.set(LIVE_SERVICE, KEYCHAIN_ACCOUNT, JSON.stringify({ ...previous, claudeAiOauth: credential, organizationUuid: `org-${id}`, mcpOAuth }));
    await writeFile(paths.claudeJson, JSON.stringify({ oauthAccount: { accountUuid: id, emailAddress: `${id}@example.com` } }));
  };

  const liveBlob = async () => JSON.parse((await keychain.get(LIVE_SERVICE, KEYCHAIN_ACCOUNT)) ?? "null");
  const parked = async (id: string) => JSON.parse((await keychain.get(VAULT_SERVICE, id)) ?? "null");

  test("round-trips small and oversized values and reports a missing item as null", async () => {
    const small = JSON.stringify({ hello: "world" });
    const large = JSON.stringify({ padding: "x".repeat(9000) });

    await keychain.set(ROUNDTRIP_SERVICE, KEYCHAIN_ACCOUNT, small);
    expect(await keychain.get(ROUNDTRIP_SERVICE, KEYCHAIN_ACCOUNT)).toBe(small);
    await keychain.set(ROUNDTRIP_SERVICE, KEYCHAIN_ACCOUNT, large);
    expect(await keychain.get(ROUNDTRIP_SERVICE, KEYCHAIN_ACCOUNT)).toBe(large);
    await keychain.delete(ROUNDTRIP_SERVICE, KEYCHAIN_ACCOUNT);
    expect(await keychain.get(ROUNDTRIP_SERVICE, KEYCHAIN_ACCOUNT)).toBeNull();
  });

  test("register, park, log in as a second account, switch back and poll keep mcpOAuth intact", async () => {
    const aliceCredential = fake!.issue(ALICE, 8 * HOUR);
    await logIn(ALICE, aliceCredential);
    expect((await keychain.get(LIVE_SERVICE, KEYCHAIN_ACCOUNT))!.length).toBeGreaterThan(6000);

    const registered = await engine.register();
    expect(registered.alias).toBe("alice");
    expect(registered.email).toBe("alice@example.com");
    expect(await keychain.get(VAULT_SERVICE, ALICE)).toBeNull();

    const parkedRecord = await engine.parkLiveForLogin();
    expect(parkedRecord?.id).toBe(AccountId(ALICE));
    expect((await parked(ALICE)).refreshToken).toBe(aliceCredential.refreshToken);
    expect((await stat(paths.loginPendingFile)).isFile()).toBe(true);

    const bobCredential = fake!.issue(BOB, 8 * HOUR);
    await logIn(BOB, bobCredential);
    const finished = await engine.finishLogin({ previous: AccountId(ALICE) });
    expect(finished.kind).toBe("added");
    expect(finished.kind === "added" && finished.account.alias).toBe("bob");
    expect((await parked(ALICE)).refreshToken).toBe(aliceCredential.refreshToken);
    expect(await keychain.get(VAULT_SERVICE, BOB)).toBeNull();

    const switched = await engine.switchTo("alice");
    expect(switched.kind).toBe("switched");
    const live = await liveBlob();
    expect(live.claudeAiOauth.refreshToken).toBe(aliceCredential.refreshToken);
    expect(live.organizationUuid).toBe(`org-${ALICE}`);
    expect(Object.keys(live.mcpOAuth)).toEqual([BIG_MCP_KEY]);
    expect(live.mcpOAuth[BIG_MCP_KEY].accessToken).toBe("m".repeat(6000));
    expect((await parked(BOB)).refreshToken).toBe(bobCredential.refreshToken);
    expect(await keychain.get(VAULT_SERVICE, ALICE)).toBeNull();
    expect(JSON.parse(await readFile(paths.claudeJson, "utf8")).oauthAccount.accountUuid).toBe(ALICE);

    const records = await engine.pollAll();
    expect(records.map((r) => [r.accountId, r.error, r.reading?.windows[0]?.percent])).toEqual([
      [AccountId(ALICE), null, 40],
      [AccountId(BOB), null, 70],
    ]);
    expect(fake!.calls.filter((c) => c === "GET /api/oauth/usage")).toHaveLength(2);
  });

  test("switching back refreshes a parked credential that is about to expire through the token endpoint", async () => {
    const bobNearExpiry = fake!.issue(BOB, 60_000);
    await keychain.set(VAULT_SERVICE, BOB, JSON.stringify(bobNearExpiry));

    const switched = await engine.switchTo("bob");

    expect(switched.kind).toBe("switched");
    const live = await liveBlob();
    expect(live.claudeAiOauth.refreshToken).not.toBe(bobNearExpiry.refreshToken);
    expect(live.claudeAiOauth.refreshToken.startsWith(`rt-${BOB}-`)).toBe(true);
    expect(live.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now() + 7 * HOUR);
    expect(live.mcpOAuth[BIG_MCP_KEY].accessToken).toBe("m".repeat(6000));
    expect(fake!.calls).toContain("POST /token");
    expect((await parked(ALICE)).refreshToken.startsWith(`rt-${ALICE}-`)).toBe(true);
  });
});
