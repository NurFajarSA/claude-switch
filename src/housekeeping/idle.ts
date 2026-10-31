export interface IdleCandidate {
  name: string;
  pid: number;
  startedAt: number | null;
  lastActivity: number | null;
}

export function idleProfiles({
  candidates,
  frontmostPid,
  idleMs,
  now,
}: {
  candidates: readonly IdleCandidate[];
  frontmostPid: number | null;
  idleMs: number;
  now: number;
}): string[] {
  if (idleMs <= 0) return [];
  return candidates
    .filter((c) => c.pid !== frontmostPid)
    .filter((c) => c.lastActivity !== null && now - c.lastActivity >= idleMs)
    .filter((c) => c.startedAt === null || now - c.startedAt >= idleMs)
    .map((c) => c.name);
}
