import { join } from "node:path";
import { z } from "zod";
import { type AccountId, AccountId as toAccountId, type AccountRecord, type OAuthCredential } from "../domain/account.ts";
import type { UsageRecord } from "../domain/usage.ts";
import { isPlainObject, readJson, readRawJson, removeFile, writeJsonAtomic } from "../infra/files.ts";
import type { SecretStore } from "../infra/keychain.ts";
import type { Paths } from "../infra/paths.ts";

const OAuthCredentialSchema = z.looseObject({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number(),
  scopes: z.array(z.string()),
  subscriptionType: z.string().nullish(),
  rateLimitTier: z.string().nullish(),
});

export class ConcurrentChangeError extends Error {
  override name = "ConcurrentChangeError";
}

export interface LiveSnapshot {
  blob: Record<string, unknown>;
  oauth: OAuthCredential | null;
  organizationUuid: string | null;
}

export class LiveCredentials {
  constructor(
    private readonly secrets: SecretStore,
    private readonly paths: Paths,
  ) {}

  async read(): Promise<LiveSnapshot | null> {
    const raw = await this.secrets.get(this.paths.liveService, this.paths.keychainAccount);
    if (raw === null) return null;
    const blob: unknown = JSON.parse(raw);
    if (!isPlainObject(blob)) throw new Error("Claude Code credential item is not a JSON object");
    const oauth = OAuthCredentialSchema.safeParse(blob.claudeAiOauth);
    return {
      blob,
      oauth: oauth.success ? oauth.data : null,
      organizationUuid: typeof blob.organizationUuid === "string" ? blob.organizationUuid : null,
    };
  }

  async install(expected: LiveSnapshot | null, next: { oauth: OAuthCredential; organizationUuid: string | null }): Promise<void> {
    const current = await this.read();
    if ((current?.oauth?.refreshToken ?? null) !== (expected?.oauth?.refreshToken ?? null)) {
      throw new ConcurrentChangeError("Claude Code changed its credentials while switching");
    }
    const blob: Record<string, unknown> = { ...(current?.blob ?? {}), claudeAiOauth: next.oauth };
    if (next.organizationUuid) blob.organizationUuid = next.organizationUuid;
    else delete blob.organizationUuid;
    await this.secrets.set(this.paths.liveService, this.paths.keychainAccount, JSON.stringify(blob));
  }
}

export class ClaudeConfig {
  constructor(private readonly paths: Paths) {}

  async oauthAccount(): Promise<Record<string, unknown> | null> {
    const config = await readRawJson(this.paths.claudeJson);
    const account = config?.oauthAccount;
    return isPlainObject(account) ? account : null;
  }

  async setOauthAccount(account: Record<string, unknown> | null): Promise<void> {
    const config = await readRawJson(this.paths.claudeJson);
    if (!config) return;
    if (account) config.oauthAccount = account;
    else delete config.oauthAccount;
    await writeJsonAtomic(this.paths.claudeJson, config);
  }
}

export class Vault {
  constructor(
    private readonly secrets: SecretStore,
    private readonly paths: Paths,
  ) {}

  async get(id: AccountId): Promise<OAuthCredential | null> {
    const raw = await this.secrets.get(this.paths.vaultService, id);
    if (raw === null) return null;
    const parsed = OAuthCredentialSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }

  async put(id: AccountId, credential: OAuthCredential): Promise<void> {
    await this.secrets.set(this.paths.vaultService, id, JSON.stringify(credential));
  }

  async remove(id: AccountId): Promise<void> {
    await this.secrets.delete(this.paths.vaultService, id);
  }
}

const AccountHealthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok") }),
  z.object({ kind: z.literal("needs_login"), reason: z.string(), since: z.string() }),
]);

const AccountRecordSchema = z.object({
  id: z.string().transform(toAccountId),
  alias: z.string(),
  email: z.string(),
  organizationName: z.string().nullable(),
  organizationUuid: z.string().nullable(),
  plan: z.string(),
  addedAt: z.string(),
  oauthAccount: z.record(z.string(), z.unknown()).nullable(),
  health: AccountHealthSchema,
});

const RegistrySchema = z.object({ version: z.literal(1), accounts: z.array(AccountRecordSchema) });

export class Registry {
  constructor(private readonly paths: Paths) {}

  async list(): Promise<AccountRecord[]> {
    return (await readJson(this.paths.accountsFile, RegistrySchema))?.accounts ?? [];
  }

  async save(accounts: readonly AccountRecord[]): Promise<void> {
    await writeJsonAtomic(this.paths.accountsFile, { version: 1, accounts });
  }
}

const LimitWindowSchema = z.object({
  kind: z.string(),
  group: z.string(),
  percent: z.number(),
  resetsAt: z.string().nullable(),
  scope: z.string().nullable(),
});

const UsageRecordSchema = z.object({
  accountId: z.string().transform(toAccountId),
  checkedAt: z.string(),
  reading: z.object({ fetchedAt: z.string(), windows: z.array(LimitWindowSchema) }).nullable(),
  error: z.string().nullable(),
});

export class UsageCache {
  constructor(private readonly paths: Paths) {}

  private file(id: AccountId) {
    return join(this.paths.usageDir, `${id}.json`);
  }

  async get(id: AccountId): Promise<UsageRecord | undefined> {
    try {
      return (await readJson(this.file(id), UsageRecordSchema)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  async put(record: UsageRecord): Promise<void> {
    await writeJsonAtomic(this.file(record.accountId), record);
  }

  async remove(id: AccountId): Promise<void> {
    await removeFile(this.file(id));
  }
}

export const ConfigSchema = z.object({
  threshold: z.number().int().min(1).max(100).default(95),
  warnAt: z.number().int().min(1).max(100).default(85),
  pollSeconds: z.number().int().min(30).max(3600).default(120),
  autoSwitch: z.boolean().default(true),
});
export type Config = z.infer<typeof ConfigSchema>;

export function withWarnBelowThreshold(config: Config, changed: string): Config {
  if (config.warnAt < config.threshold) return config;
  if (changed === "warnAt") {
    const threshold = Math.min(100, config.warnAt + 1);
    return { ...config, threshold, warnAt: Math.min(config.warnAt, threshold - 1) };
  }
  return { ...config, warnAt: Math.max(1, config.threshold - 10) };
}

export class ConfigStore {
  constructor(private readonly paths: Paths) {}

  async load(): Promise<Config> {
    return (await readJson(this.paths.configFile, ConfigSchema)) ?? ConfigSchema.parse({});
  }

  async save(config: Config): Promise<void> {
    await writeJsonAtomic(this.paths.configFile, ConfigSchema.parse(config));
  }
}
