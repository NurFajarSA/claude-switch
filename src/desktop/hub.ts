import { join } from "node:path";
import type { AccountView, Engine, Status } from "../core/engine.ts";
import { UserError } from "../core/engine.ts";
import type { AccountId } from "../domain/account.ts";
import { type Candidate, decideSwitch, type SwitchDecision, type UsageRecord } from "../domain/usage.ts";
import { openProfile, profilePid, runningProfiles } from "./process.ts";
import { type DesktopProfile, discoverProfiles, resolveProfile } from "./profiles.ts";
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

export type HandoffOutcome =
  | { kind: "moved"; session: DesktopSession; to: ProfileState; result: HandoffResult; opened: "focused" | "launched" | "skipped" }
  | { kind: "stay"; reason: string }
  | { kind: "exhausted"; soonestReset: string | null };

export class DesktopHub {
  constructor(
    private readonly engine: Engine,
    private readonly appSupportDir = join(engine.paths.home, "Library", "Application Support"),
    private readonly now: () => number = Date.now,
  ) {}

  async overview(): Promise<Overview> {
    const [status, profiles, running] = await Promise.all([this.engine.status(), discoverProfiles(this.appSupportDir), runningProfiles()]);
    const byAccount = new Map(status.accounts.map((a) => [a.record.id, a]));
    return {
      status,
      profiles: profiles.map((profile) => {
        const account = profile.accountId ? byAccount.get(profile.accountId) ?? null : null;
        const live = account?.usage?.reading ? account.usage : undefined;
        const desktop = desktopUsage(profile);
        const liveIsNewer = live?.reading && (!desktop?.reading || live.reading.fetchedAt >= desktop.reading.fetchedAt);
        return {
          profile,
          running: profilePid(running, profile) !== undefined,
          account,
          usage: liveIsNewer ? live : desktop ?? live,
          usageSource: liveIsNewer ? "live" : desktop ? "desktop" : "none",
        };
      }),
    };
  }

  async sessions(profileName?: string): Promise<DesktopSession[]> {
    const profiles = await discoverProfiles(this.appSupportDir);
    const selected = profileName ? [this.requireProfile(profiles, profileName)] : profiles;
    return (await Promise.all(selected.map((p) => listSessions(p)))).flat().sort((a, b) => (b.card.lastActivityAt ?? 0) - (a.card.lastActivityAt ?? 0));
  }

  async open(profileName: string): Promise<{ profile: DesktopProfile; how: "focused" | "launched" }> {
    const profile = this.requireProfile(await discoverProfiles(this.appSupportDir), profileName);
    return { profile, how: await openProfile(profile) };
  }

  async handoff({
    sessionId,
    to,
    force,
    open = true,
  }: {
    sessionId: string;
    to?: string;
    force: boolean;
    open?: boolean;
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
      target = overview.profiles.find((p) => p.profile === this.requireProfile(overview.profiles.map((s) => s.profile), to));
    } else {
      const decision = this.decide(overview, source, force);
      if (decision.kind !== "switch") return decision.kind === "stay" ? decision : { kind: "exhausted", soonestReset: decision.soonestReset };
      target = overview.profiles.find((p) => p.profile.name === decision.to.alias);
    }
    if (!target) throw new UserError("Target profile not found.");

    const result = await handoffSession({ session, target: target.profile, sourceRunning: source?.running ?? true, now: this.now() });
    const opened = open ? await openProfile(target.profile) : "skipped";
    return { kind: "moved", session, to: target, result, opened };
  }

  private decide(overview: Overview, source: ProfileState | undefined, force: boolean): SwitchDecision {
    const sourceAccount = source?.profile.accountId ?? null;
    const seen = new Set<AccountId>();
    const candidates: Candidate[] = [];
    for (const p of overview.profiles) {
      if (!p.profile.accountId || p.profile.sessionRoots.length === 0) continue;
      const isSource = p.profile.dir === source?.profile.dir;
      if (!isSource && (p.profile.accountId === sourceAccount || seen.has(p.profile.accountId))) continue;
      seen.add(p.profile.accountId);
      candidates.push({
        id: p.profile.accountId,
        alias: p.profile.name,
        health: p.account?.record.health ?? { kind: "ok" },
        usage: p.usage,
      });
    }
    return decideSwitch({ live: sourceAccount, candidates, threshold: overview.status.config.threshold, now: this.now(), force });
  }

  private requireProfile(profiles: readonly DesktopProfile[], name: string): DesktopProfile {
    const profile = resolveProfile(profiles, name);
    if (!profile) throw new UserError(`Unknown Desktop profile "${name}". Known: ${profiles.map((p) => p.name).join(", ")}.`);
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
