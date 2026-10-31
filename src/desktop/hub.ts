import { join } from "node:path";
import type { AccountView, Engine, Status } from "../core/engine.ts";
import { UserError } from "../core/engine.ts";
import type { AccountId } from "../domain/account.ts";
import { type Candidate, decideSwitch, type SwitchDecision, type UsageRecord } from "../domain/usage.ts";
import { type DesktopWindows, MacDesktopWindows, type WindowAction } from "./process.ts";
import { MAX_LABEL_LENGTH, ProfileLabels } from "./labels.ts";
import { type DesktopProfile, discoverProfiles, displayName, resolveProfile } from "./profiles.ts";
import { type DesktopSession, findSession, type HandoffResult, handoffSession, listSessions } from "./sessions.ts";

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
}

export type TargetWindow = WindowAction | "left_closed" | "needs_reopen";

export type HandoffOutcome =
  | { kind: "moved"; session: DesktopSession; to: ProfileState; result: HandoffResult; window: TargetWindow }
  | { kind: "stay"; reason: string }
  | { kind: "exhausted"; soonestReset: string | null };

export interface HubOptions {
  appSupportDir?: string;
  windows?: DesktopWindows;
  now?: () => number;
}

export class DesktopHub {
  private readonly appSupportDir: string;
  private readonly windows: DesktopWindows;
  private readonly now: () => number;
  private readonly labels: ProfileLabels;

  constructor(
    private readonly engine: Engine,
    options: HubOptions = {},
  ) {
    this.appSupportDir = options.appSupportDir ?? join(engine.paths.home, "Library", "Application Support");
    this.windows = options.windows ?? new MacDesktopWindows();
    this.now = options.now ?? Date.now;
    this.labels = new ProfileLabels(engine.paths.stateDir);
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

  private async profiles(): Promise<DesktopProfile[]> {
    return discoverProfiles(this.appSupportDir, await this.labels.load());
  }

  async overview(): Promise<Overview> {
    const [status, profiles] = await Promise.all([this.engine.status(), this.profiles()]);
    const running = await Promise.all(profiles.map((p) => this.windows.isRunning(p)));
    const byAccount = new Map(status.accounts.map((a) => [a.record.id, a]));
    return {
      status,
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
  }: {
    sessionId: string;
    to?: string;
    force: boolean;
    open?: boolean;
    restart?: boolean;
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
    } else {
      const decision = this.decide(overview, source, force);
      if (decision.kind !== "switch") return decision.kind === "stay" ? decision : { kind: "exhausted", soonestReset: decision.soonestReset };
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

  private decide(overview: Overview, source: ProfileState | undefined, force: boolean): SwitchDecision {
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
    const input = { live: sourceAccount, threshold: overview.status.config.threshold, now: this.now(), force };
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

function desktopUsage(profile: DesktopProfile): UsageRecord | undefined {
  if (!profile.accountId || !profile.usage) return undefined;
  const { at, fiveHourPercent, sevenDayPercent } = profile.usage;
  const windows = [
    ...(fiveHourPercent !== null ? [{ kind: "session", group: "session", percent: fiveHourPercent, resetsAt: null, scope: null }] : []),
    ...(sevenDayPercent !== null ? [{ kind: "weekly", group: "weekly", percent: sevenDayPercent, resetsAt: null, scope: null }] : []),
  ];
  return { accountId: profile.accountId, checkedAt: at, reading: { fetchedAt: at, windows }, error: null };
}
