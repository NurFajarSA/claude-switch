import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { Engine } from "../core/engine.ts";
import { Vault } from "../core/stores.ts";
import { discoverProfiles } from "../desktop/profiles.ts";
import { SessionCard } from "../desktop/sessions.ts";
import { type DesktopUpdateState, readUpdateState, type UpdatePaths, updatePaths } from "../desktop/updates.ts";
import { type AnthropicApi, ApiError, describeApiError, HttpAnthropicApi } from "../infra/anthropic.ts";
import { isPlainObject, readJson, readRawJson } from "../infra/files.ts";
import { MacKeychain, type SecretStore } from "../infra/keychain.ts";
import type { Paths } from "../infra/paths.ts";
import { DAEMON_LABEL, HOOK_EVENTS, hookCommand, layout, MCP_NAME } from "./install.ts";

export const TESTED_CLAUDE_CODE = "2.1";
export const TESTED_CLAUDE_DESKTOP = ["4."] as const;
export const REFRESH_WARN_DAYS = 5;

const DAY_MS = 86_400_000;
const SESSION_FILES_PER_ROOT = 50;
const MCP_KEYS_SHOWN = 3;

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

type Outcome = Omit<CheckResult, "id" | "title">;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DoctorDeps {
  paths: Paths;
  secrets: SecretStore;
  api: AnthropicApi;
  engine: Engine;
  now: () => number;
  appSupportDir: string;
  updates: UpdatePaths;
  uid: number;
  which: (name: string) => string | null;
  exec: (cmd: string[]) => Promise<ExecResult>;
}

interface Check {
  id: string;
  title: string;
  run: (deps: DoctorDeps) => Promise<Outcome>;
}

const ok = (detail: string): Outcome => ({ status: "ok", detail });
const warn = (detail: string, fix?: string): Outcome => ({ status: "warn", detail, ...(fix ? { fix } : {}) });
const fail = (detail: string, fix?: string): Outcome => ({ status: "fail", detail, ...(fix ? { fix } : {}) });

const SEVERITY: Record<CheckStatus, number> = { ok: 0, warn: 1, fail: 2 };

function worst(statuses: readonly CheckStatus[]): CheckStatus {
  return statuses.reduce<CheckStatus>((acc, s) => (SEVERITY[s] > SEVERITY[acc] ? s : acc), "ok");
}

function joinOutcomes(parts: readonly Outcome[]): Outcome {
  const status = worst(parts.map((p) => p.status));
  const fixes = [...new Set(parts.flatMap((p) => (p.status !== "ok" && p.fix ? [p.fix] : [])))];
  return { status, detail: parts.map((p) => p.detail).join("; "), ...(fixes.length > 0 ? { fix: fixes.join(" ") } : {}) };
}

const LiveBlob = z.looseObject({
  claudeAiOauth: z.looseObject({ accessToken: z.string().min(1), refreshToken: z.string().min(1), expiresAt: z.number() }).optional(),
  mcpOAuth: z.unknown().optional(),
});

function describeIssues(error: z.ZodError): string {
  return error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
}

const claudeCli: Check = {
  id: "claude-cli",
  title: "Claude Code CLI",
  run: async ({ which, exec }) => {
    const bin = which("claude");
    if (!bin) return fail("`claude` is not on PATH", "Install Claude Code and make sure `claude` is on PATH.");
    const { code, stdout, stderr } = await exec([bin, "--version"]);
    const version = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
    if (code !== 0 || !version) return fail(`\`claude --version\` gave no version (exit ${code}): ${(stderr || stdout).trim().slice(0, 120)}`);
    const full = `${version[1]}.${version[2]}.${version[3]}`;
    const majorMinor = `${version[1]}.${version[2]}`;
    return majorMinor === TESTED_CLAUDE_CODE
      ? ok(`${full} at ${bin}`)
      : warn(`${full} at ${bin}; claude-switch was tested on ${TESTED_CLAUDE_CODE}.x`, "Expect breakage and report it if the checks below fail.");
  },
};

const liveCredential: Check = {
  id: "live-credential",
  title: "Live Keychain credential",
  run: async ({ secrets, paths, now }) => {
    const service = paths.liveService;
    const raw = await secrets.get(service, paths.keychainAccount);
    if (raw === null) return fail(`no Keychain item "${service}"`, "Log in with `claude auth login`.");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return fail(`item "${service}" is not valid JSON`, "Log in again with `claude auth login`.");
    }
    if (!isPlainObject(json)) return fail(`item "${service}" is not a JSON object`);
    const blob = LiveBlob.safeParse(json);
    if (!blob.success) return fail(`claudeAiOauth has an unexpected shape (${describeIssues(blob.error)})`, "Claude Code may have changed its credential format.");
    const oauth = blob.data.claudeAiOauth;
    if (!oauth) return fail("item has no claudeAiOauth", "Log in with `claude auth login`.");
    const mcpKeys = isPlainObject(blob.data.mcpOAuth) ? Object.keys(blob.data.mcpOAuth).sort() : [];
    const shown = mcpKeys.slice(0, MCP_KEYS_SHOWN).join(", ");
    const more = mcpKeys.length > MCP_KEYS_SHOWN ? `, +${mcpKeys.length - MCP_KEYS_SHOWN} more` : "";
    const mcp = mcpKeys.length > 0 ? `mcpOAuth present (${mcpKeys.length} keys: ${shown}${more})` : "mcpOAuth absent";
    const remaining = oauth.expiresAt - now();
    const expiry = remaining > 0 ? `access token valid for ${Math.floor(remaining / 60_000)} min` : "access token expired (Claude Code refreshes it on next use)";
    return ok(`claudeAiOauth ok, ${expiry}; ${mcp}`);
  },
};

const endpoints: Check = {
  id: "endpoints",
  title: "Anthropic endpoints",
  run: async ({ secrets, paths, api, now }) => {
    const raw = await secrets.get(paths.liveService, paths.keychainAccount);
    const parsed = raw === null ? null : LiveBlob.safeParse(safeJson(raw));
    const oauth = parsed?.success ? parsed.data.claudeAiOauth : undefined;
    if (!oauth) return warn("skipped, no live token to test with", "Fix the live credential check first.");
    if (oauth.expiresAt <= now()) return warn("skipped, live access token is expired", "Run any `claude` command so Claude Code refreshes it, then rerun `cs doctor`.");
    const probes: [string, () => Promise<unknown>][] = [
      ["/api/oauth/profile", () => api.profile(oauth.accessToken)],
      ["/api/oauth/usage", () => api.usage(oauth.accessToken)],
    ];
    const results = await Promise.all(
      probes.map(async ([path, call]): Promise<Outcome> => {
        try {
          await call();
          return ok(`${path} ok`);
        } catch (err) {
          const transient = err instanceof ApiError && (err.kind === "server" || err.kind === "rate_limited");
          return (transient ? warn : fail)(`${path}: ${describeApiError(err)}`, endpointFix(err));
        }
      }),
    );
    return joinOutcomes(results);
  },
};

function endpointFix(err: unknown): string {
  if (err instanceof ApiError && err.kind === "network") return "Check the network connection.";
  if (err instanceof ApiError && err.kind === "unauthorized") return "Log in again with `claude auth login`.";
  if (err instanceof ApiError && (err.kind === "server" || err.kind === "rate_limited")) return "Temporary on Anthropic's side; rerun later.";
  return "The undocumented endpoint changed; update the zod parsers in src/infra/anthropic.ts.";
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const vault: Check = {
  id: "vault",
  title: "Account vault",
  run: async ({ engine, secrets, paths, now }) => {
    const status = await engine.status();
    if (status.accounts.length === 0) return warn("no registered accounts", "Run `cs register` while Claude Code is logged in.");
    const store = new Vault(secrets, paths);
    const parts = await Promise.all(
      status.accounts.map(async ({ record, live, loginExpiresAt }): Promise<Outcome> => {
        const name = record.alias;
        if (!live && !(await store.get(record.id))) return fail(`${name}: no parked credential`, `Run \`cs relogin ${name}\` or \`cs add ${name}\`.`);
        const where = live ? "live" : "parked";
        if (loginExpiresAt === null) return ok(`${name}: ${where}, refresh token expiry unknown`);
        const days = Math.floor((loginExpiresAt - now()) / DAY_MS);
        if (loginExpiresAt <= now()) return fail(`${name}: ${where}, refresh token expired`, `Run \`cs relogin ${name}\`.`);
        const left = `${name}: ${where}, ${days}d left`;
        return days < REFRESH_WARN_DAYS ? warn(left, `Run \`cs relogin ${name}\` soon.`) : ok(left);
      }),
    );
    return joinOutcomes(parts);
  },
};

const desktopApp: Check = {
  id: "desktop-app",
  title: "Claude Desktop",
  run: async ({ updates }) => {
    const state: DesktopUpdateState = await readUpdateState(updates);
    if (!state.installed) return warn(`no readable version at ${updates.appBundle}`, "Install Claude Desktop, or ignore if you only use the CLI.");
    const tested = TESTED_CLAUDE_DESKTOP.some((prefix) => state.installed?.startsWith(prefix));
    const staged = state.staged ? `, update ${state.staged} waiting` : "";
    return tested
      ? ok(`${state.installed}${staged}`)
      : warn(`${state.installed}${staged}; claude-switch was tested on ${TESTED_CLAUDE_DESKTOP.join(", ")}x`, "Expect breakage and report it if the checks below fail.");
  },
};

const desktopProfiles: Check = {
  id: "desktop-profiles",
  title: "Desktop profiles",
  run: async ({ appSupportDir }) => {
    const profiles = await discoverProfiles(appSupportDir);
    if (profiles.length === 0) return warn(`no profiles under ${appSupportDir}`, "Open Claude Desktop once, or run `cs new-profile <name>`.");
    const parts = profiles.map((p): Outcome => {
      if (!p.accountId) return ok(`${p.name}: not signed in`);
      return p.sessionRoots.length > 0
        ? ok(`${p.name}: ${p.sessionRoots.length} session root(s)`)
        : warn(`${p.name}: signed in but has no claude-code-sessions root`, `Open the Code tab in the "${p.name}" window and start one session.`);
    });
    return joinOutcomes(parts);
  },
};

const desktopSessions: Check = {
  id: "desktop-sessions",
  title: "Desktop session cards",
  run: async ({ appSupportDir }) => {
    const profiles = await discoverProfiles(appSupportDir);
    let files = 0;
    let parsed = 0;
    for (const root of profiles.flatMap((p) => p.sessionRoots)) {
      const names = (await readdir(root.dir).catch(() => [])).filter((f) => f.startsWith("local_") && f.endsWith(".json")).slice(0, SESSION_FILES_PER_ROOT);
      for (const name of names) {
        files++;
        if (await readJson(join(root.dir, name), SessionCard).then(() => true, () => false)) parsed++;
      }
    }
    if (files === 0) return warn("no session cards found to verify", "Start one Code session in Claude Desktop.");
    if (parsed === 0) return fail(`0 of ${files} session cards parse`, "Desktop changed its card format; update SessionCard in src/desktop/sessions.ts.");
    if (parsed < files) return warn(`${parsed} of ${files} session cards parse`, "Some cards have an unexpected shape; check SessionCard in src/desktop/sessions.ts.");
    return ok(`${parsed} of ${files} session cards parse`);
  },
};

const installBinary: Check = {
  id: "install-binary",
  title: "cs binary",
  run: async ({ paths }) => {
    const bin = layout(paths).bin;
    return (await exists(bin)) ? ok(bin) : fail(`${bin} is missing`, "Run `bun run install:local`.");
  },
};

const installDaemon: Check = {
  id: "install-daemon",
  title: "Background poller",
  run: async ({ paths, exec, uid }) => {
    const plist = join(layout(paths).launchAgents, `${DAEMON_LABEL}.plist`);
    if (!(await exists(plist))) return fail(`${plist} is missing`, "Run `bun run install:local`.");
    const { code, stdout } = await exec(["/bin/launchctl", "print", `gui/${uid}/${DAEMON_LABEL}`]);
    if (code !== 0) return fail(`${DAEMON_LABEL} is not loaded in launchd`, `Run \`launchctl bootstrap gui/${uid} ${plist}\`.`);
    const state = /^\s*state = (\S+)/m.exec(stdout)?.[1] ?? "unknown";
    return state === "running"
      ? ok(`${DAEMON_LABEL} running`)
      : fail(`${DAEMON_LABEL} state is ${state}`, `Check ${paths.logFile}, then \`launchctl kickstart -k gui/${uid}/${DAEMON_LABEL}\`.`);
  },
};

const installMcp: Check = {
  id: "install-mcp",
  title: "MCP server",
  run: async ({ which, exec }) => {
    const claude = which("claude");
    if (!claude) return fail("`claude` is not on PATH, cannot query MCP servers");
    const { code } = await exec([claude, "mcp", "get", MCP_NAME]);
    return code === 0 ? ok(`"${MCP_NAME}" registered`) : fail(`"${MCP_NAME}" is not registered`, "Run `bun run install:local`.");
  },
};

const installHooks: Check = {
  id: "install-hooks",
  title: "Claude Code hooks",
  run: async ({ paths }) => {
    const settings = await readRawJson(paths.claudeSettings);
    const hooks = isPlainObject(settings?.hooks) ? settings.hooks : {};
    const command = hookCommand(layout(paths).bin);
    const missing = HOOK_EVENTS.filter((event) => !hasHook(hooks[event], command));
    return missing.length === 0
      ? ok(`${HOOK_EVENTS.join(", ")} in ${paths.claudeSettings}`)
      : fail(`missing in ${paths.claudeSettings}: ${missing.join(", ")}`, "Run `bun run install:local`.");
  },
};

function hasHook(entries: unknown, command: string): boolean {
  return Array.isArray(entries) && entries.some((e) => isPlainObject(e) && Array.isArray(e.hooks) && e.hooks.some((h) => isPlainObject(h) && h.command === command));
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export const CHECKS: readonly Check[] = [
  claudeCli,
  liveCredential,
  endpoints,
  vault,
  desktopApp,
  desktopProfiles,
  desktopSessions,
  installBinary,
  installDaemon,
  installMcp,
  installHooks,
];

export async function runDoctor(deps: DoctorDeps, checks: readonly Check[] = CHECKS): Promise<CheckResult[]> {
  return Promise.all(
    checks.map(async ({ id, title, run }): Promise<CheckResult> => {
      try {
        return { id, title, ...(await run(deps)) };
      } catch (err) {
        return { id, title, ...fail(`check crashed: ${err instanceof Error ? err.message : String(err)}`) };
      }
    }),
  );
}

const MARKS: Record<CheckStatus, { symbol: string; ansi: string }> = {
  ok: { symbol: "✓", ansi: "32" },
  warn: { symbol: "!", ansi: "33" },
  fail: { symbol: "✗", ansi: "31" },
};

export function renderDoctor(results: readonly CheckResult[], color: boolean): string {
  const paint = (status: CheckStatus) => (color ? `\x1b[${MARKS[status].ansi}m${MARKS[status].symbol}\x1b[0m` : MARKS[status].symbol);
  const width = Math.max(0, ...results.map((r) => r.title.length));
  return results
    .flatMap((r) => [`${paint(r.status)} ${r.title.padEnd(width)}  ${r.detail}`, ...(r.fix && r.status !== "ok" ? [`  ${" ".repeat(width)}  fix: ${r.fix}`] : [])])
    .join("\n");
}

export async function exec(cmd: string[], timeoutMs = 20_000): Promise<ExecResult> {
  try {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  } catch (err) {
    return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

export function systemDeps(paths: Paths): DoctorDeps {
  const secrets = new MacKeychain();
  const api = new HttpAnthropicApi();
  return {
    paths,
    secrets,
    api,
    engine: new Engine({ paths, secrets, api }),
    now: Date.now,
    appSupportDir: join(paths.home, "Library", "Application Support"),
    updates: updatePaths(paths.home),
    uid: process.getuid?.() ?? 501,
    which: (name) => Bun.which(name),
    exec,
  };
}

export async function doctorCommand(args: string[], { paths, color, out }: { paths: Paths; color: boolean; out: (text: string) => void }): Promise<void> {
  const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
  const results = await runDoctor(systemDeps(paths));
  out(values.json ? JSON.stringify(results, null, 2) : renderDoctor(results, color));
  if (results.some((r) => r.status === "fail")) process.exitCode = 1;
}
