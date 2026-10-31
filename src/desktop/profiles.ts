import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { type AccountId, AccountId as toAccountId } from "../domain/account.ts";
import { readJson } from "../infra/files.ts";

export type ProfileName = string & { readonly __brand: "ProfileName" };

export interface DesktopProfile {
  name: ProfileName;
  label: string | null;
  dir: string;
  isDefault: boolean;
  accountId: AccountId | null;
  sessionRoots: SessionRoot[];
  usage: DesktopUsageSample | null;
  loginExpiresAt: number | null;
}

export interface SessionRoot {
  accountId: AccountId;
  organizationId: string;
  dir: string;
}

export interface DesktopUsageSample {
  at: string;
  fiveHourPercent: number | null;
  sevenDayPercent: number | null;
}

const DesktopConfig = z.looseObject({ lastKnownAccountUuid: z.string().nullish() });

const UsageHistory = z.object({
  samples: z.array(
    z.object({
      t: z.number(),
      org: z.string().nullish(),
      u: z.looseObject({ fh: z.number().nullish(), sd: z.number().nullish() }),
    }),
  ),
});

const PROFILE_DIR = /^Claude(-[A-Za-z0-9._-]+)?$/;

export async function discoverProfiles(appSupportDir: string, labels: Readonly<Record<string, string>> = {}): Promise<DesktopProfile[]> {
  const entries = await readdir(appSupportDir, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((e) => e.isDirectory() && PROFILE_DIR.test(e.name)).map((e) => join(appSupportDir, e.name));
  const profiles = await Promise.all(dirs.map((dir) => loadProfile(dir, labels)));
  return profiles.filter((p): p is DesktopProfile => p !== null).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
}

async function loadProfile(dir: string, labels: Readonly<Record<string, string>>): Promise<DesktopProfile | null> {
  const config = await readJson(join(dir, "config.json"), DesktopConfig).catch(() => null);
  if (!config) return null;
  const folder = basename(dir);
  const isDefault = folder === "Claude";
  const name = (isDefault ? "default" : folder.slice("Claude-".length)) as ProfileName;
  return {
    name,
    label: labels[name] ?? null,
    dir,
    isDefault,
    accountId: config.lastKnownAccountUuid ? toAccountId(config.lastKnownAccountUuid) : null,
    sessionRoots: await sessionRoots(dir),
    usage: await latestUsage(dir),
    loginExpiresAt: await sessionCookieExpiry(dir),
  };
}

async function sessionRoots(dir: string): Promise<SessionRoot[]> {
  const base = join(dir, "claude-code-sessions");
  const accounts = await readdir(base, { withFileTypes: true }).catch(() => []);
  const roots: SessionRoot[] = [];
  for (const account of accounts.filter((a) => a.isDirectory())) {
    const orgs = await readdir(join(base, account.name), { withFileTypes: true }).catch(() => []);
    for (const org of orgs.filter((o) => o.isDirectory())) {
      roots.push({ accountId: toAccountId(account.name), organizationId: org.name, dir: join(base, account.name, org.name) });
    }
  }
  return roots;
}

async function latestUsage(dir: string): Promise<DesktopUsageSample | null> {
  const history = await readJson(join(dir, "plan-usage-history.json"), UsageHistory).catch(() => null);
  const last = history?.samples.reduce<(typeof history.samples)[number] | null>((acc, s) => (!acc || s.t > acc.t ? s : acc), null);
  if (!last) return null;
  return { at: new Date(last.t).toISOString(), fiveHourPercent: last.u.fh ?? null, sevenDayPercent: last.u.sd ?? null };
}

const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000;

async function sessionCookieExpiry(dir: string): Promise<number | null> {
  const db = join(dir, "Cookies");
  if (!(await Bun.file(db).exists())) return null;
  const proc = Bun.spawn(
    ["/usr/bin/sqlite3", "-readonly", `file:${db}?immutable=1`, "select max(expires_utc) from cookies where name = 'sessionKey' and host_key like '%claude.ai'"],
    { stdout: "pipe", stderr: "ignore" },
  );
  const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const micros = Number(text.trim());
  return code === 0 && micros > 0 ? Math.round(micros / 1000 - CHROME_EPOCH_OFFSET_MS) : null;
}

export function resolveProfile(profiles: readonly DesktopProfile[], query: string): DesktopProfile | undefined {
  const q = query.trim().toLowerCase();
  return (
    profiles.find((p) => p.name.toLowerCase() === q) ??
    profiles.find((p) => p.label?.toLowerCase() === q) ??
    profiles.find((p) => basename(p.dir).toLowerCase() === q)
  );
}

export function displayName(profile: DesktopProfile): string {
  return profile.label ?? profile.name;
}
