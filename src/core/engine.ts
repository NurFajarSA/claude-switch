import {
  type AccountId,
  type AccountRecord,
  ALIAS_PATTERN,
  aliasFromEmail,
  type OAuthCredential,
  type Profile,
  planLabel,
  AccountId as toAccountId,
} from "../domain/account.ts";
import { decideSwitch, type SwitchDecision, type UsageRecord } from "../domain/usage.ts";
import { type AnthropicApi, ApiError, describeApiError } from "../infra/anthropic.ts";
import { readRawJson, removeFile, writeJsonAtomic } from "../infra/files.ts";
import type { SecretStore } from "../infra/keychain.ts";
import { withLock } from "../infra/lock.ts";
import { type Logger, silentLogger } from "../infra/log.ts";
import type { Paths } from "../infra/paths.ts";
import {
  ClaudeConfig,
  ConcurrentChangeError,
  type Config,
  ConfigStore,
  type LiveSnapshot,
  LiveCredentials,
  Registry,
  UsageCache,
  Vault,
} from "./stores.ts";

const REFRESH_MARGIN_MS = 5 * 60_000;
const LOGIN_WINDOW_MS = 15 * 60_000;

export class UserError extends Error {
  override name = "UserError";
}

export interface EngineDeps {
  paths: Paths;
  secrets: SecretStore;
  api: AnthropicApi;
  log?: Logger;
  now?: () => number;
}

export interface LiveIdentity {
  id: AccountId;
  profile: Profile | null;
}

export interface AccountView {
  record: AccountRecord;
  live: boolean;
  usage: UsageRecord | undefined;
  loginExpiresAt: number | null;
}

export interface Status {
  live: LiveIdentity | null;
  liveRegistered: boolean;
  accounts: AccountView[];
  config: Config;
}

export type SwitchResult =
  | { kind: "already"; account: AccountRecord }
  | { kind: "switched"; from: AccountRecord | null; to: AccountRecord };

export type LoginResult =
  | { kind: "added"; account: AccountRecord }
  | { kind: "renewed"; account: AccountRecord }
  | { kind: "same_account"; account: AccountRecord }
  | { kind: "unexpected_account"; account: AccountRecord; expected: AccountId }
  | { kind: "not_logged_in" };

export type AutoSwitchResult = { decision: SwitchDecision; result: SwitchResult | null };

export class Engine {
  readonly paths: Paths;
  readonly config: ConfigStore;
  private readonly api: AnthropicApi;
  private readonly live: LiveCredentials;
  private readonly claude: ClaudeConfig;
  private readonly vault: Vault;
  private readonly registry: Registry;
  private readonly usage: UsageCache;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly identities = new Map<string, LiveIdentity>();

  constructor(deps: EngineDeps) {
    this.paths = deps.paths;
    this.api = deps.api;
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? Date.now;
    this.live = new LiveCredentials(deps.secrets, deps.paths);
    this.claude = new ClaudeConfig(deps.paths);
    this.vault = new Vault(deps.secrets, deps.paths);
    this.registry = new Registry(deps.paths);
    this.usage = new UsageCache(deps.paths);
    this.config = new ConfigStore(deps.paths);
  }

  async status(): Promise<Status> {
    const [records, snapshot, config] = await Promise.all([this.registry.list(), this.live.read(), this.config.load()]);
    const live = await this.identify(snapshot);
    const accounts = await Promise.all(
      records.map(async (record) => {
        const isLive = record.id === live?.id;
        const credential = isLive ? snapshot?.oauth : await this.vault.get(record.id).catch(() => null);
        const expiresAt = credential?.refreshTokenExpiresAt;
        return {
          record,
          live: isLive,
          usage: await this.usage.get(record.id),
          loginExpiresAt: typeof expiresAt === "number" ? expiresAt : null,
        };
      }),
    );
    return { live, liveRegistered: accounts.some((a) => a.live), accounts, config };
  }

  async register(alias?: string): Promise<AccountRecord> {
    return this.locked(async () => {
      const snapshot = await this.live.read();
      if (!snapshot?.oauth) throw new UserError("Claude Code is not logged in. Run `claude auth login` first.");
      const profile = await this.api.profile(snapshot.oauth.accessToken);
      const record = await this.upsertLive(profile, alias);
      await this.vault.remove(record.id);
      return record;
    });
  }

  async parkLiveForLogin(): Promise<AccountRecord | null> {
    return this.locked(async () => {
      const snapshot = await this.live.read();
      if (!snapshot?.oauth) return null;
      const profile = await this.api.profile(snapshot.oauth.accessToken);
      const record = await this.upsertLive(profile);
      await this.vault.put(record.id, snapshot.oauth);
      await writeJsonAtomic(this.paths.loginPendingFile, { accountId: record.id, startedAt: this.now() });
      this.log.info("parked_for_login", { account: record.id });
      return record;
    });
  }

  async finishLogin({
    previous,
    alias,
    expected,
  }: {
    previous: AccountId | null;
    alias?: string;
    expected?: AccountId;
  }): Promise<LoginResult> {
    await removeFile(this.paths.loginPendingFile);
    const snapshot = await this.live.read();
    if (!snapshot?.oauth) {
      await this.reconcile();
      return { kind: "not_logged_in" };
    }
    const id = (await this.api.profile(snapshot.oauth.accessToken)).id;
    const known = (await this.registry.list()).some((r) => r.id === id);
    const wanted = expected === undefined ? id !== previous : id === expected;
    const account = await this.register(wanted && !known ? alias : undefined);
    await this.reconcile();
    if (wanted) return { kind: known ? "renewed" : "added", account };
    if (expected !== undefined && id !== previous) return { kind: "unexpected_account", account, expected };
    return { kind: "same_account", account };
  }

  async assertAliasAvailable(alias: string): Promise<void> {
    if (!ALIAS_PATTERN.test(alias)) throw new UserError("Alias must be lowercase letters, digits or dashes (max 32).");
    if ((await this.registry.list()).some((r) => r.alias === alias)) throw new UserError(`Alias "${alias}" is taken.`);
  }

  private async loginPendingFor(id: AccountId): Promise<boolean> {
    const pending = await readRawJson(this.paths.loginPendingFile).catch(() => null);
    return pending?.accountId === id && typeof pending.startedAt === "number" && this.now() - pending.startedAt < LOGIN_WINDOW_MS;
  }

  async switchTo(target: string): Promise<SwitchResult> {
    try {
      return await this.locked(() => this.switchUnlocked(target));
    } catch (err) {
      if (!(err instanceof ConcurrentChangeError)) throw err;
      this.log.warn("switch_retry_after_concurrent_change");
      return this.locked(() => this.switchUnlocked(target));
    }
  }

  async autoSwitch({ force, poll = true }: { force: boolean; poll?: boolean }): Promise<AutoSwitchResult> {
    if (poll) await this.pollAll();
    const status = await this.status();
    const decision = decideSwitch({
      live: status.live?.id ?? null,
      candidates: status.accounts.map((a) => ({ id: a.record.id, alias: a.record.alias, health: a.record.health, usage: a.usage })),
      threshold: status.config.threshold,
      now: this.now(),
      force,
    });
    if (decision.kind !== "switch") return { decision, result: null };
    const result = await this.switchTo(decision.to.id);
    this.log.info("auto_switch", { reason: decision.reason, to: decision.to.id });
    return { decision, result };
  }

  async pollAll(): Promise<UsageRecord[]> {
    await this.reconcile();
    const [records, snapshot] = await Promise.all([this.registry.list(), this.live.read()]);
    const live = await this.identify(snapshot);
    return Promise.all(
      records.map((record) =>
        record.id === live?.id && snapshot?.oauth ? this.pollLive(record.id, snapshot.oauth) : this.pollParked(record),
      ),
    );
  }

  async reconcile(): Promise<void> {
    await this.locked(async () => {
      const [records, snapshot] = await Promise.all([this.registry.list(), this.live.read()]);
      const live = await this.identify(snapshot);
      if (live && !(await this.loginPendingFor(live.id)) && (await this.vault.get(live.id))) {
        await this.vault.remove(live.id);
        this.log.info("reconcile_removed_stale_parked_copy", { account: live.id });
      }
      let changed = false;
      const next = await Promise.all(
        records.map(async (record) => {
          if (record.id === live?.id || record.health.kind !== "ok") return record;
          if (await this.vault.get(record.id)) return record;
          changed = true;
          return this.withHealth(record, "no stored credential; log in again with `cs add`");
        }),
      );
      if (changed) await this.registry.save(next);
    });
  }

  async rename(current: string, alias: string): Promise<AccountRecord> {
    if (!ALIAS_PATTERN.test(alias)) throw new UserError("Alias must be lowercase letters, digits or dashes (max 32).");
    return this.locked(async () => {
      const records = await this.registry.list();
      const record = resolve(records, current);
      if (records.some((r) => r.alias === alias && r.id !== record.id)) throw new UserError(`Alias "${alias}" is taken.`);
      const updated = { ...record, alias };
      await this.registry.save(records.map((r) => (r.id === record.id ? updated : r)));
      return updated;
    });
  }

  async remove(target: string): Promise<AccountRecord> {
    return this.locked(async () => {
      const records = await this.registry.list();
      const record = resolve(records, target);
      const live = await this.identify(await this.live.read());
      if (live?.id === record.id) throw new UserError("Cannot remove the active account. Switch to another account first.");
      await this.vault.remove(record.id);
      await this.usage.remove(record.id);
      await this.registry.save(records.filter((r) => r.id !== record.id));
      return record;
    });
  }

  private async switchUnlocked(target: string): Promise<SwitchResult> {
    const records = await this.registry.list();
    const record = resolve(records, target);
    const snapshot = await this.live.read();
    const live = await this.identify(snapshot);
    if (live?.id === record.id) return { kind: "already", account: record };
    if (snapshot?.oauth && !live) {
      throw new UserError("Cannot identify the account Claude Code is using, so it cannot be parked safely. Run `cs add` first.");
    }

    const credential = await this.freshParked(record);

    let from: AccountRecord | null = null;
    if (live && snapshot?.oauth) {
      from = await this.upsertLiveFromIdentity(live, records);
      await this.vault.put(from.id, snapshot.oauth);
    }
    await this.live.install(snapshot, { oauth: credential, organizationUuid: record.organizationUuid });
    await this.vault.remove(record.id);
    if (record.oauthAccount) await this.claude.setOauthAccount(record.oauthAccount);
    this.log.info("switched", { from: from?.id ?? null, to: record.id });
    return { kind: "switched", from, to: record };
  }

  private async freshParked(record: AccountRecord): Promise<OAuthCredential> {
    const stored = await this.vault.get(record.id);
    if (!stored) {
      await this.markNeedsLogin(record.id, "no stored credential");
      throw new UserError(`No stored login for "${record.alias}". Log in again with \`cs add\`.`);
    }
    if (stored.expiresAt - this.now() > REFRESH_MARGIN_MS) return stored;
    try {
      const refreshed = await this.api.refresh(stored);
      await this.vault.put(record.id, refreshed);
      this.log.info("refreshed_parked_token", { account: record.id });
      return refreshed;
    } catch (err) {
      if (err instanceof ApiError && (err.kind === "invalid_grant" || err.kind === "unauthorized")) {
        await this.markNeedsLogin(record.id, "refresh token rejected");
        throw new UserError(`The stored login for "${record.alias}" expired. Log in again with \`cs add\`.`);
      }
      throw err;
    }
  }

  private async pollLive(id: AccountId, oauth: OAuthCredential): Promise<UsageRecord> {
    if (oauth.expiresAt <= this.now()) {
      return this.recordUsage(id, null, "token expired; Claude Code refreshes it on next use");
    }
    try {
      return await this.recordUsage(id, await this.api.usage(oauth.accessToken), null);
    } catch (err) {
      return this.recordUsage(id, null, describeApiError(err));
    }
  }

  private async pollParked(record: AccountRecord): Promise<UsageRecord> {
    if (record.health.kind !== "ok") return this.recordUsage(record.id, null, record.health.reason);
    try {
      const credential = await this.locked(() => this.freshParked(record));
      return await this.recordUsage(record.id, await this.api.usage(credential.accessToken), null);
    } catch (err) {
      return this.recordUsage(record.id, null, err instanceof UserError ? err.message : describeApiError(err));
    }
  }

  private async recordUsage(id: AccountId, reading: UsageRecord["reading"], error: string | null): Promise<UsageRecord> {
    const previous = reading ? undefined : await this.usage.get(id);
    const record: UsageRecord = {
      accountId: id,
      checkedAt: new Date(this.now()).toISOString(),
      reading: reading ?? previous?.reading ?? null,
      error,
    };
    await this.usage.put(record);
    if (error) this.log.warn("usage_poll_failed", { account: id, error });
    return record;
  }

  private async identify(snapshot: LiveSnapshot | null): Promise<LiveIdentity | null> {
    if (!snapshot?.oauth) return null;
    const token = snapshot.oauth.accessToken;
    const known = this.identities.get(token);
    if (known) return known;
    if (snapshot.oauth.expiresAt > this.now()) {
      try {
        const profile = await this.api.profile(token);
        const identity = { id: profile.id, profile };
        this.identities.set(token, identity);
        return identity;
      } catch (err) {
        this.log.warn("identify_profile_failed", { error: describeApiError(err) });
      }
    }
    const account = await this.claude.oauthAccount();
    return typeof account?.accountUuid === "string" ? { id: toAccountId(account.accountUuid), profile: null } : null;
  }

  private async upsertLiveFromIdentity(live: LiveIdentity, records: AccountRecord[]): Promise<AccountRecord> {
    const existing = records.find((r) => r.id === live.id);
    if (!live.profile) {
      if (existing) return existing;
      throw new UserError("Cannot identify the active account. Run `cs add` first.");
    }
    return this.upsertLive(live.profile);
  }

  private async upsertLive(profile: Profile, alias?: string): Promise<AccountRecord> {
    const records = await this.registry.list();
    const existing = records.find((r) => r.id === profile.id);
    if (alias !== undefined && !ALIAS_PATTERN.test(alias)) {
      throw new UserError("Alias must be lowercase letters, digits or dashes (max 32).");
    }
    if (alias && records.some((r) => r.alias === alias && r.id !== profile.id)) throw new UserError(`Alias "${alias}" is taken.`);
    const oauthAccount = await this.claude.oauthAccount();
    const matchingOauthAccount = oauthAccount?.accountUuid === profile.id ? oauthAccount : null;
    const record: AccountRecord = {
      id: profile.id,
      alias: alias ?? existing?.alias ?? aliasFromEmail(profile.email, new Set(records.map((r) => r.alias))),
      email: profile.email,
      organizationName: profile.organizationName,
      organizationUuid: profile.organizationUuid,
      plan: planLabel(profile),
      addedAt: existing?.addedAt ?? new Date(this.now()).toISOString(),
      oauthAccount: matchingOauthAccount ?? existing?.oauthAccount ?? null,
      health: { kind: "ok" },
    };
    await this.registry.save(existing ? records.map((r) => (r.id === record.id ? record : r)) : [...records, record]);
    return record;
  }

  private async markNeedsLogin(id: AccountId, reason: string): Promise<void> {
    const records = await this.registry.list();
    await this.registry.save(records.map((r) => (r.id === id ? this.withHealth(r, reason) : r)));
    this.log.warn("needs_login", { account: id, reason });
  }

  private withHealth(record: AccountRecord, reason: string): AccountRecord {
    return { ...record, health: { kind: "needs_login", reason, since: new Date(this.now()).toISOString() } };
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return withLock(this.paths.lockDir, fn);
  }
}

export function resolve(records: readonly AccountRecord[], query: string): AccountRecord {
  const q = query.toLowerCase();
  const match =
    records.find((r) => r.alias === q) ??
    records.find((r) => r.id === query) ??
    records.find((r) => r.email.toLowerCase() === q);
  if (!match) {
    const known = records.map((r) => r.alias).join(", ") || "none";
    throw new UserError(`Unknown account "${query}". Known accounts: ${known}.`);
  }
  return match;
}
