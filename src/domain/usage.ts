import type { AccountHealth, AccountId } from "./account.ts";

export interface LimitWindow {
  kind: string;
  group: string;
  percent: number;
  resetsAt: string | null;
  scope: string | null;
}

export interface UsageReading {
  fetchedAt: string;
  windows: LimitWindow[];
}

export interface UsageRecord {
  accountId: AccountId;
  checkedAt: string;
  reading: UsageReading | null;
  error: string | null;
}

export const STALE_AFTER_MS = 15 * 60_000;

export function blockingWindow(reading: UsageReading): LimitWindow | null {
  let worst: LimitWindow | null = null;
  for (const w of reading.windows) {
    if (w.scope !== null) continue;
    if (!worst || w.percent > worst.percent) worst = w;
  }
  return worst;
}

export function blockingPercent(reading: UsageReading): number {
  return blockingWindow(reading)?.percent ?? 0;
}

export function freshReading(record: UsageRecord | undefined, now: number): UsageReading | null {
  if (!record?.reading) return null;
  return now - Date.parse(record.reading.fetchedAt) <= STALE_AFTER_MS ? record.reading : null;
}

export interface Candidate {
  id: AccountId;
  alias: string;
  health: AccountHealth;
  usage: UsageRecord | undefined;
}

export type SwitchDecision =
  | { kind: "switch"; to: Candidate; reason: string }
  | { kind: "stay"; reason: string }
  | { kind: "exhausted"; soonestReset: string | null };

export interface DecisionInput {
  live: AccountId | null;
  candidates: readonly Candidate[];
  threshold: number;
  now: number;
  force: boolean;
}

export function decideSwitch({ live, candidates, threshold, now, force }: DecisionInput): SwitchDecision {
  const liveCandidate = candidates.find((c) => c.id === live);
  const liveReading = freshReading(liveCandidate?.usage, now);
  const livePercent = liveReading ? blockingPercent(liveReading) : null;

  if (!force && live !== null && (livePercent === null || livePercent < threshold)) {
    return {
      kind: "stay",
      reason: livePercent === null ? "no fresh usage for the active account" : `active account at ${livePercent}%`,
    };
  }

  const ranked = candidates
    .filter((c) => c.id !== live && c.health.kind === "ok")
    .map((c) => {
      const reading = freshReading(c.usage, now);
      return { c, percent: reading ? blockingPercent(reading) : null };
    })
    .filter((r) => r.percent === null || r.percent < threshold)
    .sort((a, b) => rank(a.percent) - rank(b.percent));

  const best = ranked[0];
  if (best) {
    const from = livePercent === null ? "active account" : `active account at ${livePercent}%`;
    const to = best.percent === null ? "usage unknown" : `${best.percent}%`;
    return { kind: "switch", to: best.c, reason: `${from}; ${best.c.alias} at ${to}` };
  }
  return { kind: "exhausted", soonestReset: soonestReset(candidates, now) };
}

function rank(percent: number | null): number {
  return percent === null ? 1000 : percent;
}

function soonestReset(candidates: readonly Candidate[], now: number): string | null {
  const resets = candidates
    .filter((c) => c.health.kind === "ok")
    .map((c) => freshReading(c.usage, now))
    .map((r) => (r ? blockingWindow(r)?.resetsAt ?? null : null))
    .filter((r): r is string => r !== null && Date.parse(r) > now)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return resets[0] ?? null;
}
