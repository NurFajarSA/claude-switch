import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readJson, writeJsonAtomic } from "../infra/files.ts";
import type { DesktopProfile, SessionRoot } from "./profiles.ts";

const SessionCard = z.looseObject({
  sessionId: z.string(),
  cliSessionId: z.string(),
  cwd: z.string().nullish(),
  title: z.string().nullish(),
  lastActivityAt: z.number().nullish(),
  isArchived: z.boolean().nullish(),
});
type SessionCard = z.infer<typeof SessionCard>;

export interface DesktopSession {
  profile: DesktopProfile;
  root: SessionRoot;
  path: string;
  card: SessionCard;
}

const CARRIED_FIELDS = [
  "cliSessionId",
  "cwd",
  "originCwd",
  "gitAnchorsFolderRealpath",
  "createdAt",
  "model",
  "effort",
  "effortInherited",
  "title",
  "titleSource",
  "permissionMode",
  "completedTurns",
  "titleTurn",
  "lastAssistantUuid",
  "chromePermissionMode",
] as const;

export class HandoffError extends Error {
  override name = "HandoffError";
}

export async function listSessions(profile: DesktopProfile, { includeArchived = false } = {}): Promise<DesktopSession[]> {
  const sessions: DesktopSession[] = [];
  for (const root of profile.sessionRoots) {
    const files = (await readdir(root.dir).catch(() => [])).filter((f) => f.startsWith("local_") && f.endsWith(".json"));
    for (const file of files) {
      const path = join(root.dir, file);
      const card = await readJson(path, SessionCard).catch(() => null);
      if (card && (includeArchived || !card.isArchived)) sessions.push({ profile, root, path, card });
    }
  }
  return sessions.sort((a, b) => (b.card.lastActivityAt ?? 0) - (a.card.lastActivityAt ?? 0));
}

export async function findSession(profiles: readonly DesktopProfile[], id: string): Promise<DesktopSession | undefined> {
  if (id.startsWith("local_")) {
    for (const profile of profiles) {
      for (const root of profile.sessionRoots) {
        const path = join(root.dir, `${id}.json`);
        const card = await readJson(path, SessionCard).catch(() => null);
        if (card) return { profile, root, path, card };
      }
    }
    return undefined;
  }
  for (const profile of profiles) {
    const match = (await listSessions(profile, { includeArchived: true })).find(
      (s) => s.card.sessionId === id || s.card.cliSessionId === id,
    );
    if (match) return match;
  }
  return undefined;
}

export interface HandoffResult {
  target: DesktopSession;
  reusedExistingCard: boolean;
  sourceArchived: boolean;
}

export async function handoffSession({
  session,
  target,
  sourceRunning,
  now = Date.now(),
}: {
  session: DesktopSession;
  target: DesktopProfile;
  sourceRunning: boolean;
  now?: number;
}): Promise<HandoffResult> {
  if (session.profile.dir === target.dir) throw new HandoffError(`The session already lives in profile "${target.name}".`);
  const root = await targetRoot(target);
  const existing = (await listSessions(target, { includeArchived: true })).find((s) => s.card.cliSessionId === session.card.cliSessionId);

  const carried = Object.fromEntries(CARRIED_FIELDS.filter((k) => k in session.card).map((k) => [k, session.card[k]]));
  const card: SessionCard = {
    ...carried,
    sessionId: existing?.card.sessionId ?? `local_${randomUUID()}`,
    cliSessionId: session.card.cliSessionId,
    isArchived: false,
    lastActivityAt: now,
    lastFocusedAt: now,
    enabledMcpTools: {},
    remoteMcpServersConfig: [],
  };
  const path = existing?.path ?? join(root.dir, `${card.sessionId}.json`);
  await writeJsonAtomic(path, card);

  const sourceArchived = !sourceRunning;
  if (sourceArchived) await writeJsonAtomic(session.path, { ...session.card, isArchived: true });

  return { target: { profile: target, root, path, card }, reusedExistingCard: existing !== undefined, sourceArchived };
}

async function targetRoot(target: DesktopProfile): Promise<SessionRoot> {
  const owned = target.sessionRoots.filter((r) => r.accountId === target.accountId);
  const candidates = owned.length > 0 ? owned : target.sessionRoots;
  if (candidates.length === 0) {
    throw new HandoffError(`Profile "${target.name}" has never opened the Code tab. Open Claude there, start one Code session, then retry.`);
  }
  const withTimes = await Promise.all(candidates.map(async (r) => ({ r, mtime: (await stat(r.dir)).mtimeMs })));
  return withTimes.sort((a, b) => b.mtime - a.mtime)[0]!.r;
}
