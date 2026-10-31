import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/core/engine.ts";
import { AccountId, type OAuthCredential, type Profile } from "../src/domain/account.ts";
import type { UsageReading } from "../src/domain/usage.ts";
import { type AnthropicApi, ApiError } from "../src/infra/anthropic.ts";
import { MemorySecretStore } from "../src/infra/keychain.ts";
import type { Paths } from "../src/infra/paths.ts";

export const HOUR = 3_600_000;

export interface FakeAccount {
  id: string;
  email: string;
  percent: number;
  resetsAt?: string;
}

export class FakeApi implements AnthropicApi {
  readonly tokens = new Map<string, string>();
  readonly accounts = new Map<string, FakeAccount>();
  readonly revokedRefresh = new Set<string>();
  refreshCalls = 0;
  private seq = 0;

  constructor(private readonly now: () => number) {}

  add(account: FakeAccount): OAuthCredential {
    this.accounts.set(account.id, account);
    return this.issue(account.id);
  }

  issue(id: string, ttl = 8 * HOUR): OAuthCredential {
    const n = ++this.seq;
    const accessToken = `at-${id}-${n}`;
    const refreshToken = `rt-${id}-${n}`;
    this.tokens.set(accessToken, id);
    this.tokens.set(refreshToken, id);
    return { accessToken, refreshToken, expiresAt: this.now() + ttl, scopes: ["user:inference", "user:profile"] };
  }

  async profile(accessToken: string): Promise<Profile> {
    const account = this.accounts.get(this.tokens.get(accessToken) ?? "");
    if (!account) throw new ApiError("unauthorized", "unknown token");
    return {
      id: AccountId(account.id),
      email: account.email,
      organizationUuid: `org-${account.id}`,
      organizationName: null,
      organizationType: "claude_max",
      rateLimitTier: "default_claude_max_5x",
    };
  }

  async usage(accessToken: string): Promise<UsageReading> {
    const account = this.accounts.get(this.tokens.get(accessToken) ?? "");
    if (!account) throw new ApiError("unauthorized", "unknown token");
    return {
      fetchedAt: new Date(this.now()).toISOString(),
      windows: [{ kind: "session", group: "session", percent: account.percent, resetsAt: account.resetsAt ?? null, scope: null }],
    };
  }

  async refresh(credential: OAuthCredential): Promise<OAuthCredential> {
    this.refreshCalls++;
    const id = this.tokens.get(credential.refreshToken);
    if (!id || this.revokedRefresh.has(credential.refreshToken)) throw new ApiError("invalid_grant", "invalid_grant");
    this.revokedRefresh.add(credential.refreshToken);
    return { ...credential, ...this.issue(id) };
  }
}

export async function setup() {
  let clock = Date.parse("2026-10-31T10:00:00Z");
  const now = () => clock;
  const dir = await mkdtemp(join(tmpdir(), "claude-switch-test-"));
  const paths: Paths = {
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
    liveService: "live",
    keychainAccount: "user",
    vaultService: "vault",
  };
  const secrets = new MemorySecretStore();
  const api = new FakeApi(now);
  const engine = new Engine({ paths, secrets, api, now });

  const login = async (id: string) => {
    const credential = api.issue(id);
    const existing = await secrets.get("live", "user");
    const blob = existing ? JSON.parse(existing) : { mcpOAuth: { linear: { accessToken: "mcp-token" } } };
    await secrets.set("live", "user", JSON.stringify({ ...blob, claudeAiOauth: credential, organizationUuid: `org-${id}` }));
    const config = JSON.parse(await readFile(paths.claudeJson, "utf8").catch(() => "{}"));
    await writeFile(paths.claudeJson, JSON.stringify({ ...config, oauthAccount: { accountUuid: id, emailAddress: api.accounts.get(id)?.email } }));
    return credential;
  };

  const liveBlob = async () => JSON.parse((await secrets.get("live", "user")) ?? "null");
  const parked = async (id: string) => JSON.parse((await secrets.get("vault", id)) ?? "null");
  const claudeJson = async () => JSON.parse(await readFile(paths.claudeJson, "utf8"));

  return {
    engine,
    api,
    secrets,
    paths,
    login,
    liveBlob,
    parked,
    claudeJson,
    advance: (ms: number) => {
      clock += ms;
    },
    newEngine: () => new Engine({ paths, secrets, api, now }),
  };
}

export async function withAccounts(...accounts: FakeAccount[]) {
  const t = await setup();
  for (const a of accounts) t.api.add(a);
  for (const a of accounts) {
    await t.login(a.id);
    await t.newEngine().parkLiveForLogin();
  }
  const last = accounts[accounts.length - 1];
  if (last) await t.newEngine().finishLogin();
  return t;
}
