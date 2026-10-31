import type { AccountView, Status } from "../core/engine.ts";
import type { Overview } from "../desktop/hub.ts";
import { blockingWindow, freshReading, type LimitWindow } from "../domain/usage.ts";

export type Severity = "ok" | "warn" | "critical" | "unknown";

export interface WindowRow {
  label: string;
  percent: number;
  resetsIn: string | null;
  resetsAt: string | null;
}

export interface AccountRow {
  id: string;
  alias: string;
  email: string;
  plan: string;
  active: boolean;
  healthy: boolean;
  problem: string | null;
  percent: number | null;
  severity: Severity;
  windows: WindowRow[];
  checkedAgo: string | null;
  stale: boolean;
  loginDaysLeft: number | null;
  loginExpiring: boolean;
}

export const LOGIN_WARN_DAYS = 5;

function daysLeft(expiresAt: number | null, now: number): number | null {
  return expiresAt === null ? null : Math.max(0, Math.floor((expiresAt - now) / 86_400_000));
}

export interface StatusView {
  active: AccountRow | null;
  unregisteredActive: string | null;
  accounts: AccountRow[];
  threshold: number;
  warnAt: number;
  autoSwitch: boolean;
  pollSeconds: number;
  idleCloseHours: number;
  mcpCleanup: boolean;
}

export function toView(status: Status, now = Date.now()): StatusView {
  const { threshold, warnAt, autoSwitch, pollSeconds, idleCloseHours, mcpCleanup } = status.config;
  const accounts = status.accounts.map((a) => toRow(a, { threshold, warnAt, now }));
  return {
    active: accounts.find((a) => a.active) ?? null,
    unregisteredActive: status.live && !status.liveRegistered ? status.live.profile?.email ?? status.live.id : null,
    accounts,
    threshold,
    warnAt,
    autoSwitch,
    pollSeconds,
    idleCloseHours,
    mcpCleanup,
  };
}

function toRow(account: AccountView, { threshold, warnAt, now }: { threshold: number; warnAt: number; now: number }): AccountRow {
  const { record, usage } = account;
  const fresh = freshReading(usage, now);
  const reading = fresh ?? usage?.reading ?? null;
  const percent = reading ? blockingWindow(reading)?.percent ?? 0 : null;
  const problem = record.health.kind === "needs_login" ? `needs login: ${record.health.reason}` : usage?.error ?? null;
  return {
    id: record.id,
    alias: record.alias,
    email: record.email,
    plan: record.plan,
    active: account.live,
    healthy: record.health.kind === "ok",
    problem,
    percent,
    severity: record.health.kind !== "ok" || percent === null ? "unknown" : percent >= threshold ? "critical" : percent >= warnAt ? "warn" : "ok",
    windows: (reading?.windows ?? []).map((w) => windowRow(w, now)),
    checkedAgo: usage ? ago(Date.parse(usage.checkedAt), now) : null,
    stale: reading !== null && fresh === null,
    loginDaysLeft: daysLeft(account.loginExpiresAt, now),
    loginExpiring: account.loginExpiresAt !== null && account.loginExpiresAt - now < LOGIN_WARN_DAYS * 86_400_000,
  };
}

function windowRow(w: LimitWindow, now: number): WindowRow {
  const name = w.group === "session" ? "5-hour" : w.group === "weekly" ? "weekly" : w.group;
  return {
    label: w.scope ? `${name} (${w.scope})` : name,
    percent: w.percent,
    resetsAt: w.resetsAt,
    resetsIn: w.resetsAt ? until(Date.parse(w.resetsAt), now) : null,
  };
}

export function until(target: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((target - now) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function ago(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  return `${until(now, then)} ago`;
}

export function bar(percent: number, width = 10): string {
  const filled = Math.min(width, Math.max(0, Math.round((percent / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

const ANSI: Record<Severity, string> = { ok: "\x1b[32m", warn: "\x1b[33m", critical: "\x1b[31m", unknown: "\x1b[90m" };

export function renderTable(view: StatusView, color: boolean): string {
  const paint = (s: Severity, text: string) => (color ? `${ANSI[s]}${text}\x1b[0m` : text);
  const dim = (text: string) => (color ? `\x1b[2m${text}\x1b[0m` : text);
  if (view.accounts.length === 0) {
    return view.unregisteredActive
      ? `No accounts registered yet. Claude Code is logged in as ${view.unregisteredActive}.\nRun \`cs register\` to add it, then \`cs add\` for each other account.`
      : "No accounts registered. Log in with `claude auth login`, then run `cs register`.";
  }
  const aliasWidth = Math.max(...view.accounts.map((a) => a.alias.length), 5);
  const lines: string[] = [];
  for (const a of view.accounts) {
    const marker = a.active ? paint("ok", "●") : " ";
    const usage =
      a.percent === null ? dim("usage unknown".padEnd(16)) : `${paint(a.severity, bar(a.percent))} ${String(a.percent).padStart(3)}%`;
    const primary = a.windows.find((w) => w.label === "5-hour") ?? a.windows[0];
    const reset = primary?.resetsIn ? dim(`resets in ${primary.resetsIn}`) : "";
    lines.push(`${marker} ${a.alias.padEnd(aliasWidth)}  ${usage}  ${dim(a.plan.padEnd(14))} ${reset}`);
    const extra = a.windows.filter((w) => w !== primary);
    for (const w of extra) lines.push(dim(`  ${"".padEnd(aliasWidth)}  ${w.label}: ${w.percent}%${w.resetsIn ? `, resets in ${w.resetsIn}` : ""}`));
    if (a.problem) lines.push(`  ${"".padEnd(aliasWidth)}  ${paint(a.healthy ? "warn" : "critical", a.problem)}`);
    else if (a.loginExpiring) lines.push(`  ${"".padEnd(aliasWidth)}  ${paint("warn", `login expires in ${a.loginDaysLeft} day(s); run \`cs relogin ${a.alias}\``)}`);
    else if (a.stale) lines.push(dim(`  ${"".padEnd(aliasWidth)}  last checked ${a.checkedAgo}`));
  }
  if (view.unregisteredActive) lines.push("", paint("warn", `Claude Code is using ${view.unregisteredActive}, which is not registered. Run \`cs register\`.`));
  lines.push("", dim(`auto-switch ${view.autoSwitch ? "on" : "off"} at ${view.threshold}% · warn at ${view.warnAt}%`));
  return lines.join("\n");
}

export function summaryLine(view: StatusView): string {
  const active = view.active;
  if (!active) return "claude-switch: no active account";
  const others = view.accounts
    .filter((a) => !a.active)
    .map((a) => `${a.alias} ${a.percent === null ? "?" : `${a.percent}%`}`)
    .join(", ");
  return `${active.alias} ${active.percent === null ? "?" : `${active.percent}%`}${others ? ` · ${others}` : ""}`;
}

export interface ProfileRow {
  name: string;
  label: string;
  customLabel: boolean;
  folder: string;
  running: boolean;
  accountId: string | null;
  alias: string | null;
  email: string | null;
  plan: string | null;
  registered: boolean;
  percent: number | null;
  severity: Severity;
  windows: WindowRow[];
  usageSource: "live" | "desktop" | "none";
  usageAge: string | null;
  problem: string | null;
  loginDaysLeft: number | null;
  loginExpiring: boolean;
}

export interface OverviewView extends StatusView {
  profiles: ProfileRow[];
  desktopVersion: string | null;
  desktopUpdate: string | null;
}

export function toOverviewView(overview: Overview, now = Date.now()): OverviewView {
  const base = toView(overview.status, now);
  const { threshold, warnAt } = base;
  return {
    ...base,
    desktopVersion: overview.update.installed,
    desktopUpdate: overview.update.staged,
    profiles: overview.profiles.filter((p) => p.profile.accountId !== null).map((p) => {
      const reading = p.usage?.reading ?? null;
      const percent = reading ? blockingWindow(reading)?.percent ?? 0 : null;
      const record = p.account?.record;
      return {
        name: p.profile.name,
        label: p.profile.label ?? p.profile.name,
        customLabel: p.profile.label !== null,
        folder: p.profile.dir,
        running: p.running,
        accountId: p.profile.accountId,
        alias: record?.alias ?? null,
        email: record?.email ?? null,
        plan: record?.plan ?? null,
        registered: record !== undefined,
        percent,
        severity: percent === null ? "unknown" : percent >= threshold ? "critical" : percent >= warnAt ? "warn" : "ok",
        windows: (reading?.windows ?? []).map((w) => windowRow(w, now)),
        usageSource: p.usageSource,
        usageAge: reading ? ago(Date.parse(reading.fetchedAt), now) : null,
        problem: record?.health.kind === "needs_login" ? `needs login: ${record.health.reason}` : null,
        loginDaysLeft: daysLeft(p.profile.loginExpiresAt, now),
        loginExpiring: p.profile.loginExpiresAt !== null && p.profile.loginExpiresAt - now < LOGIN_WARN_DAYS * 86_400_000,
      };
    }),
  };
}

export function renderProfiles(view: OverviewView, color: boolean): string {
  const paint = (s: Severity, text: string) => (color ? `${ANSI[s]}${text}\x1b[0m` : text);
  const dim = (text: string) => (color ? `\x1b[2m${text}\x1b[0m` : text);
  if (view.profiles.length === 0) return "No Claude Desktop profiles found.";
  const width = Math.max(...view.profiles.map((p) => p.label.length), 7);
  const lines = view.profiles.map((p) => {
    const marker = p.running ? paint("ok", "●") : dim("○");
    const usage = p.percent === null ? dim("usage unknown".padEnd(16)) : `${paint(p.severity, bar(p.percent))} ${String(p.percent).padStart(3)}%`;
    const who = p.email ?? (p.accountId ? `account ${p.accountId.slice(0, 8)}` : "not signed in");
    const source = p.usageSource === "desktop" ? dim(` (Desktop, ${p.usageAge})`) : p.usageSource === "live" ? dim(` (live, ${p.usageAge})`) : "";
    const expiry = p.loginExpiring ? `  ${paint("warn", `login expires in ${p.loginDaysLeft} day(s); open this profile to extend it`)}` : "";
    return `${marker} ${p.label.padEnd(width)}  ${usage}  ${who}${source}${expiry}`;
  });
  return lines.join("\n");
}
