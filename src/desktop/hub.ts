import { join } from "node:path";
import type { AccountView, Engine, Status } from "../core/engine.ts";
import { UserError } from "../core/engine.ts";
import type { AccountId } from "../domain/account.ts";
import { type Candidate, decideSwitch, type SwitchDecision, type UsageRecord } from "../domain/usage.ts";
import { type IdleCandidate, idleProfiles } from "../housekeeping/idle.ts";
import { type ShareResult, shareVmFiles, VmShareStore } from "../housekeeping/vm-share.ts";
import { type DesktopWindows, frontmostPid, MacDesktopWindows, processStartedAt, profilePid, runningProfiles, type WindowAction } from "./process.ts";
import { MAX_LABEL_LENGTH, ProfileLabels } from "./labels.ts";
import { type DesktopProfile, discoverProfiles, displayName, resolveProfile } from "./profiles.ts";
import { mkdir, readdir, stat } from "node:fs/promises";
import { type DesktopSession, findSession, type HandoffResult, handoffSession, listSessions } from "./sessions.ts";
import { type DesktopUpdateState, installedVersion, readUpdateState, type UpdatePaths, updatePaths, WatchStore, watchTick } from "./updates.ts";

export interface ProfileState {
  profile: DesktopProfile;
  running: boolean;
  account: AccountView | null;
  usage: UsageRecord | undefined;
  usageSource: "live" | "desktop" | "none";
}

export interface Overview {
  status: Status;
  profiles: ProfileState[];
  update: DesktopUpdateState;
}

export interface UpdateResult {
  from: string | null;
  to: string;
  installed: boolean;
  reopened: string[];
}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const UPDATE_TIMEOUT_MS = 180_000;

export type TargetWindow = WindowAction | "left_closed" | "needs_reopen";

export type HandoffOutcome =
  | { kind: "moved"; session: DesktopSession; to: ProfileState; result: HandoffResult; window: TargetWindow }
  | { kind: "stay"; reason: string }
  | { kind: "exhausted"; soonestReset: string | null; outside: ProfileState | null };

export interface HubOptions {
  appSupportDir?: string;
  windows?: DesktopWindows;
  updates?: UpdatePaths;
  now?: () => number;
}

export class DesktopHub {
  private readonly appSupportDir: string;
  private readonly windows: DesktopWindows;
  private readonly now: () => number;
  private readonly labels: ProfileLabels;
  private readonly updates: UpdatePaths;
  private readonly watchStore: WatchStore;

  constructor(
    private readonly engine: Engine,
    options: HubOptions = {},
  ) {
    this.appSupportDir = options.appSupportDir ?? join(engine.paths.home, "Library", "Application Support");
    this.windows = options.windows ?? new MacDesktopWindows();
    this.now = options.now ?? Date.now;
    this.labels = new ProfileLabels(engine.paths.stateDir);
    this.updates = options.updates ?? updatePaths(engine.paths.home);
    this.watchStore = new WatchStore(engine.paths.stateDir);
  }

  async createProfile(name: string): Promise<{ profile: DesktopProfile; how: WindowAction }> {
    if (!PROFILE_NAME.test(name)) throw new UserError("A profile name uses letters, digits, dots, dashes or underscores (max 40).");
    const existing = await this.profiles();
    if (existing.some((p) => p.name.toLowerCase() === name.toLowerCase() || p.label?.toLowerCase() === name.toLowerCase())) {
      throw new UserError(`Profile "${name}" already exists.`);
    }
    const dir = join(this.appSupportDir, `Claude-${name}`);
    if (await stat(dir).then(() => true, () => false)) throw new UserError(`The folder Claude-${name} already exists.`);
    await mkdir(dir, { recursive: true });
    const profile: DesktopProfile = {
      name: name as DesktopProfile["name"],
      label: null,
      dir,
      isDefault: false,
      accountId: null,
      sessionRoots: [],
      usage: null,
      loginExpiresAt: null,
    };
    return { profile, how: await this.windows.open(profile) };
  }

  async findProfile(query: string): Promise<DesktopProfile | undefined> {
    return resolveProfile(await this.profiles(), query);
  }

  async waitForAccount(profileName: string, { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }): Promise<DesktopProfile | null> {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline && !signal?.aborted) {
      const profile = resolveProfile(await this.profiles(), profileName);
      if (profile?.accountId) return profile;
      await Bun.sleep(2000);
    }
    return null;
  }

  async shareVmFiles({ dryRun = false }: { dryRun?: boolean } = {}): Promise<ShareResult> {
    const profiles = await this.profiles({ sessionExpiry: false });
    const running = await runningProfiles();
    const open = new Set<string>(profiles.filter((p) => profilePid(running, p) !== undefined).map((p) => p.name));
    const result = await shareVmFiles({ profiles, store: new VmShareStore(this.engine.paths.stateDir), isRunning: (name) => open.has(name), dryRun });
    // Report profiles by the name the menu bar shows, not the folder name.
    const labels = new Map<string, string>(profiles.map((p) => [p.name, displayName(p)]));
    const relabel = <T extends { profile: string }>(entry: T): T => ({ ...entry, profile: labels.get(entry.profile) ?? entry.profile });
    return { ...result, shared: result.shared.map(relabel), skipped: result.skipped.map(relabel) };
  }

  async closeIdle({ idleHours }: { idleHours: number }): Promise<DesktopProfile[]> {
    if (idleHours <= 0) return [];
    const profiles = await this.profiles({ sessionExpiry: false });
    const running = await runningProfiles();
    const candidates: IdleCandidate[] = [];
    for (const profile of profiles) {
      const pid = profilePid(running, profile);
      if (pid === undefined) continue;
      candidates.push({ name: profile.name, pid, startedAt: await processStartedAt(pid), lastActivity: await lastSessionChange(profile) });
    }
    if (candidates.length === 0) return [];
    const names = idleProfiles({ candidates, frontmostPid: await frontmostPid(), idleMs: idleHours * 3_600_000, now: this.now() });
    const closed: DesktopProfile[] = [];
    for (const name of names) {
      const profile = profiles.find((p) => p.name === name);
      if (!profile) continue;
      await this.windows.quit(profile);
      closed.push(profile);
    }
    return closed;
  }

  async installUpdate(): Promise<UpdateResult> {
    const before = await readUpdateState(this.updates);
    if (!before.staged) throw new UserError("Claude Desktop has no downloaded update waiting to install.");
    const profiles = await this.profiles();
    const running = (await Promise.all(profiles.map(async (p) => ((await this.windows.isRunning(p)) ? p : null)))).filter(
      (p): p is DesktopProfile => p !== null,
    );
    for (const profile of running) await this.windows.quit(profile);

    const deadline = this.now() + UPDATE_TIMEOUT_MS;
    let installed = false;
    while (this.now() < deadline) {
      if ((await readUpdateState(this.updates)).installed === before.staged) {
        installed = true;
        break;
      }
      await Bun.sleep(2000);
    }
    const reopened: string[] = [];
    for (const profile of running) {
      await this.windows.open(profile);
      reopened.push(displayName(profile));
    }
    return { from: before.installed, to: before.staged, installed, reopened };
  }

  async watch(): Promise<string[]> {
    const profiles = await this.profiles({ sessionExpiry: false });
    const running = (await Promise.all(profiles.map(async (p) => ((await this.windows.isRunning(p)) ? p.name : null)))).filter(
      (n): n is DesktopProfile["name"] => n !== null,
    );
    const installed = await installedVersion(this.updates);
    const tick = watchTick({ previous: await this.watchStore.load(), version: installed, running, now: this.now() });
    await this.watchStore.save(tick.state);
    const reopened: string[] = [];
    for (const name of tick.reopen) {
      const profile = profiles.find((p) => p.name === name);
      if (!profile || (await this.windows.isRunning(profile))) continue;
      await this.windows.open(profile);
      reopened.push(displayName(profile));
    }
    return reopened;
  }

  async setLabel(profileQuery: string, label: string | null): Promise<{ profile: DesktopProfile; label: string | null }> {
    const profiles = await this.profiles();
    const profile = this.requireProfile(profiles, profileQuery);
    const clean = label?.trim() || null;
    if (clean !== null) {
      if (clean.length > MAX_LABEL_LENGTH) throw new UserError(`A label can be at most ${MAX_LABEL_LENGTH} characters.`);
      const clash = profiles.find(
        (p) => p !== profile && (p.name.toLowerCase() === clean.toLowerCase() || p.label?.toLowerCase() === clean.toLowerCase()),
      );
      if (clash) throw new UserError(`"${clean}" is already used by profile ${displayName(clash)}.`);
    }
    await this.labels.set(profile.name, clean === profile.name ? null : clean);
    return { profile, label: clean === profile.name ? null : clean };
  }

  private async profiles(options: { sessionExpiry?: boolean } = {}): Promise<DesktopProfile[]> {
    return discoverProfiles(this.appSupportDir, await this.labels.load(), options);
  }

  async overview({ light = false }: { light?: boolean } = {}): Promise<Overview> {
    const [status, profiles, update] = await Promise.all([
      this.engine.status({ expiry: !light }),
      this.profiles({ sessionExpiry: !light }),
      light ? Promise.resolve({ installed: null, staged: null }) : readUpdateState(this.updates),
    ]);
    const running = await Promise.all(profiles.map((p) => this.windows.isRunning(p)));
    const byAccount = new Map(status.accounts.map((a) => [a.record.id, a]));
    return {
      status,
      update,
      profiles: profiles.map((profile, i) => {
        const account = profile.accountId ? byAccount.get(profile.accountId) ?? null : null;
        const live = account?.usage?.reading ? account.usage : undefined;
        const desktop = desktopUsage(profile);
        const liveIsNewer = live?.reading && (!desktop?.reading || live.reading.fetchedAt >= desktop.reading.fetchedAt);
        return {
          profile,
          running: running[i] ?? false,
          account,
          usage: liveIsNewer ? live : desktop ?? live,
          usageSource: liveIsNewer ? "live" : desktop ? "desktop" : "none",
        };
      }),
    };
  }

  async sessions(profileName?: string): Promise<DesktopSession[]> {
    const profiles = await this.profiles();
    const selected = profileName ? [this.requireProfile(profiles, profileName)] : profiles;
    return (await Promise.all(selected.map((p) => listSessions(p)))).flat().sort((a, b) => (b.card.lastActivityAt ?? 0) - (a.card.lastActivityAt ?? 0));
  }

  async open(profileName: string): Promise<{ profile: DesktopProfile; how: WindowAction }> {
    const profile = this.requireProfile(await this.profiles(), profileName);
    return { profile, how: await this.windows.open(profile) };
  }

  async handoff({
    sessionId,
    to,
    force,
    open = true,
    restart = false,
    allowed,
  }: {
    sessionId: string;
    to?: string;
    force: boolean;
    open?: boolean;
    restart?: boolean;
    allowed?: ReadonlySet<AccountId>;
  }): Promise<HandoffOutcome> {
    await this.engine.pollAll().catch(() => []);
    const overview = await this.overview();
    const session = await findSession(
      overview.profiles.map((p) => p.profile),
      sessionId,
    );
    if (!session) throw new UserError(`No Desktop session matches "${sessionId}".`);
    const source = overview.profiles.find((p) => p.profile.dir === session.profile.dir);

    let target: ProfileState | undefined;
    if (to) {
      const wanted = this.requireProfile(
        overview.profiles.map((p) => p.profile),
        to,
      );
      target = overview.profiles.find((p) => p.profile === wanted);
      if (allowed && wanted.accountId && !allowed.has(wanted.accountId)) {
        throw new UserError(`Profile ${displayName(wanted)} is not allowed for this project. Allow it in Project Rules, or move the session with the project rule ignored.`);
      }
    } else {
      const decision = this.decide(overview, source, force, allowed);
      if (decision.kind === "stay") return decision;
      if (decision.kind === "exhausted") {
        const outside = decision.outside ? overview.profiles.find((p) => p.profile.name === decision.outside?.alias) ?? null : null;
        return { kind: "exhausted", soonestReset: decision.soonestReset, outside };
      }
      target = overview.profiles.find((p) => p.profile.name === decision.to.alias);
    }
    if (!target) throw new UserError("Target profile not found.");

    const result = await handoffSession({ session, target: target.profile, sourceRunning: source?.running ?? true, now: this.now() });
    return { kind: "moved", session, to: target, result, window: await this.showTarget(target, { open, restart }) };
  }

  private async showTarget(target: ProfileState, { open, restart }: { open: boolean; restart: boolean }): Promise<TargetWindow> {
    if (!target.running) return open ? this.windows.open(target.profile) : "left_closed";
    return restart ? this.windows.restart(target.profile) : "needs_reopen";
  }

  private decide(overview: Overview, source: ProfileState | undefined, force: boolean, allowed?: ReadonlySet<AccountId>): SwitchDecision {
    const sourceAccount = source?.profile.accountId ?? null;
    const seen = new Set<AccountId>();
    const pool: { candidate: Candidate; closed: boolean }[] = [];
    for (const p of overview.profiles) {
      if (!p.profile.accountId || p.profile.sessionRoots.length === 0) continue;
      const isSource = p.profile.dir === source?.profile.dir;
      if (!isSource && (p.profile.accountId === sourceAccount || seen.has(p.profile.accountId))) continue;
      seen.add(p.profile.accountId);
      pool.push({
        closed: isSource || !p.running,
        candidate: { id: p.profile.accountId, alias: p.profile.name, health: p.account?.record.health ?? { kind: "ok" }, usage: p.usage },
      });
    }
    const input = { live: sourceAccount, threshold: overview.status.config.threshold, now: this.now(), force, allowed };
    const closedFirst = decideSwitch({ ...input, candidates: pool.filter((p) => p.closed).map((p) => p.candidate) });
    if (closedFirst.kind !== "exhausted") return closedFirst;
    return decideSwitch({ ...input, candidates: pool.map((p) => p.candidate) });
  }

  private requireProfile(profiles: readonly DesktopProfile[], name: string): DesktopProfile {
    const profile = resolveProfile(profiles, name);
    if (!profile) throw new UserError(`Unknown Desktop profile "${name}". Known: ${profiles.map(displayName).join(", ")}.`);
    return profile;
  }
}

async function lastSessionChange(profile: DesktopProfile): Promise<number | null> {
  let latest: number | null = null;
  for (const root of profile.sessionRoots) {
    for (const file of await readdir(root.dir).catch(() => [])) {
      if (!file.endsWith(".json")) continue;
      const at = (await stat(join(root.dir, file)).catch(() => null))?.mtimeMs;
      if (at !== undefined && (latest === null || at > latest)) latest = at;
    }
  }
  return latest;
}

function desktopUsage(profile: DesktopProfile): UsageRecord | undefined {
  if (!profile.accountId || !profile.usage) return undefined;
  const { at, fiveHourPercent, sevenDayPercent } = profile.usage;
  const windows = [
    ...(fiveHourPercent !== null ? [{ kind: "session", group: "session", percent: fiveHourPercent, resetsAt: null, scope: null }] : []),
    ...(sevenDayPercent !== null ? [{ kind: "weekly", group: "weekly", percent: sevenDayPercent, resetsAt: null, scope: null }] : []),
  ];
  return { accountId: profile.accountId, checkedAt: at, reading: { fetchedAt: at, windows }, error: null };
}
