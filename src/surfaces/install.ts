import { copyFile, cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { isPlainObject, readRawJson, writeJsonAtomic } from "../infra/files.ts";
import type { Paths } from "../infra/paths.ts";

export const DAEMON_LABEL = "app.claude-switch.daemon";
const APP_LABEL = "app.claude-switch.menubar";
export const APP_NAME = "Accounts Manager for Claude.app";
const LEGACY_APP_NAMES = ["Claude Accounts.app"];
const SYSTEM_APP_DIR = "/Applications";
export const HOOK_EVENTS = ["UserPromptSubmit", "StopFailure"] as const;
export const MCP_NAME = "claude-switch";

export interface InstallLayout {
  bin: string;
  appDir: string;
  launchAgents: string;
}

export function layout(paths: Paths): InstallLayout {
  return {
    bin: join(paths.home, ".local", "bin", "cs"),
    appDir: join(paths.home, "Applications"),
    launchAgents: join(paths.home, "Library", "LaunchAgents"),
  };
}

export type Step = { name: string; ok: boolean; detail: string };

export async function install({ paths, sourceBinary, app }: { paths: Paths; sourceBinary: string; app?: string }): Promise<Step[]> {
  const l = layout(paths);
  const steps: Step[] = [];
  const step = async (name: string, fn: () => Promise<string>) => {
    try {
      steps.push({ name, ok: true, detail: await fn() });
    } catch (err) {
      steps.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };

  await step("binary", async () => {
    await mkdir(join(l.bin, ".."), { recursive: true });
    if (sourceBinary !== l.bin) {
      await rm(l.bin, { force: true });
      await copyFile(sourceBinary, l.bin);
    }
    await sh(["/bin/chmod", "755", l.bin]);
    await unquarantine(l.bin);
    return l.bin;
  });

  await step("background poller", async () => {
    const plist = join(l.launchAgents, `${DAEMON_LABEL}.plist`);
    await writeLaunchAgent(plist, DAEMON_LABEL, [l.bin, "daemon"], { keepAlive: true, log: paths.logFile });
    await reloadAgent(plist, DAEMON_LABEL);
    return `launchd ${DAEMON_LABEL}`;
  });

  await step("MCP server for Claude", async () => {
    const claude = Bun.which("claude") ?? "/opt/homebrew/bin/claude";
    await sh([claude, "mcp", "remove", "--scope", "user", MCP_NAME], { allowFailure: true });
    await sh([claude, "mcp", "add", "--scope", "user", MCP_NAME, "--", l.bin, "mcp"]);
    return `user-scope MCP "${MCP_NAME}"`;
  });

  await step("Claude Code hooks", async () => {
    await editHooks(paths.claudeSettings, hookCommand(l.bin), "add");
    return `${HOOK_EVENTS.join(", ")} in ${paths.claudeSettings}`;
  });

  if (app) {
    await step("menu bar app", async () => {
      await mkdir(l.appDir, { recursive: true });
      // An app already in an Applications folder (Homebrew puts it in /Applications) stays where it is.
      const source = resolve(app);
      const inPlace = [l.appDir, SYSTEM_APP_DIR].includes(dirname(source));
      const target = inPlace ? source : join(l.appDir, basename(app));
      for (const name of new Set([basename(app), ...LEGACY_APP_NAMES])) {
        const copy = join(l.appDir, name);
        if (copy !== target || !inPlace) await removeApp(copy);
      }
      if (!inPlace) await cp(app, target, { recursive: true });
      await unquarantine(target);
      const plist = join(l.launchAgents, `${APP_LABEL}.plist`);
      await writeLaunchAgent(plist, APP_LABEL, ["/usr/bin/open", "-a", target], { keepAlive: false, log: paths.logFile });
      await reloadAgent(plist, APP_LABEL);
      return `${target} (opens at login)`;
    });
  }
  return steps;
}

export async function uninstall({ paths }: { paths: Paths }): Promise<Step[]> {
  const l = layout(paths);
  const steps: Step[] = [];
  const attempt = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      steps.push({ name, ok: true, detail: "removed" });
    } catch (err) {
      steps.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };
  await attempt("Claude Code hooks", () => editHooks(paths.claudeSettings, hookCommand(l.bin), "remove"));
  await attempt("MCP server for Claude", async () => {
    const claude = Bun.which("claude") ?? "/opt/homebrew/bin/claude";
    await sh([claude, "mcp", "remove", "--scope", "user", MCP_NAME], { allowFailure: true });
  });
  for (const label of [DAEMON_LABEL, APP_LABEL]) {
    await attempt(`launchd ${label}`, async () => {
      await sh(["/bin/launchctl", "bootout", `gui/${process.getuid?.() ?? 501}/${label}`], { allowFailure: true });
      await rm(join(l.launchAgents, `${label}.plist`), { force: true });
    });
  }
  await attempt("menu bar app", async () => {
    for (const name of [APP_NAME, ...LEGACY_APP_NAMES]) await removeApp(join(l.appDir, name));
  });
  await attempt("binary", () => rm(l.bin, { force: true }));
  return steps;
}

export async function setLoginItem({ paths, enabled }: { paths: Paths; enabled: boolean }): Promise<boolean> {
  const l = layout(paths);
  const plist = join(l.launchAgents, `${APP_LABEL}.plist`);
  if (enabled) {
    const app = await installedApp(l);
    if (!app) throw new Error(`${APP_NAME} is not installed in ${l.appDir} or ${SYSTEM_APP_DIR}`);
    await writeLaunchAgent(plist, APP_LABEL, ["/usr/bin/open", "-a", app], { keepAlive: false, log: paths.logFile });
  } else {
    await sh(["/bin/launchctl", "bootout", `gui/${process.getuid?.() ?? 501}/${APP_LABEL}`], { allowFailure: true });
    await rm(plist, { force: true });
  }
  return loginItemEnabled(paths);
}

// A downloaded build without a Developer ID keeps the quarantine flag through the copy, and
// Gatekeeper then kills the poller and hooks without a prompt. Running install is the consent.
async function unquarantine(path: string): Promise<void> {
  await sh(["/usr/bin/xattr", "-dr", "com.apple.quarantine", path], { allowFailure: true });
}

async function installedApp(l: InstallLayout): Promise<string | null> {
  for (const dir of [l.appDir, SYSTEM_APP_DIR]) if (await exists(join(dir, APP_NAME))) return join(dir, APP_NAME);
  return null;
}

async function removeApp(app: string): Promise<void> {
  await sh(["/usr/bin/pkill", "-f", `${app}/Contents/MacOS/`], { allowFailure: true });
  await rm(app, { recursive: true, force: true });
}

export async function loginItemEnabled(paths: Paths): Promise<boolean> {
  return exists(join(layout(paths).launchAgents, `${APP_LABEL}.plist`));
}

export function hookCommand(bin: string): string {
  return `"${bin}" hook`;
}

const HookEntry = z.looseObject({ hooks: z.array(z.looseObject({ command: z.string().optional() })).optional() });

export async function editHooks(settingsPath: string, command: string, mode: "add" | "remove"): Promise<void> {
  const settings = (await readRawJson(settingsPath)) ?? {};
  const backup = `${settingsPath}.claude-switch.bak`;
  if (!(await exists(backup)) && (await exists(settingsPath))) await copyFile(settingsPath, backup);

  const hooks: Record<string, unknown> = isPlainObject(settings.hooks) ? { ...settings.hooks } : {};
  for (const event of HOOK_EVENTS) {
    const parsed = z.array(HookEntry).safeParse(hooks[event] ?? []);
    if (!parsed.success) throw new Error(`settings.json hooks.${event} has an unexpected shape; left untouched`);
    const others = parsed.data.filter((entry) => !entry.hooks?.some((h) => h.command === command));
    const next = mode === "add" ? [...others, { hooks: [{ type: "command", command, timeout: 30 }] }] : others;
    if (next.length > 0) hooks[event] = next;
    else delete hooks[event];
  }
  settings.hooks = hooks;
  await writeJsonAtomic(settingsPath, settings, 0o644);
}

async function writeLaunchAgent(path: string, label: string, args: string[], { keepAlive, log }: { keepAlive: boolean; log: string }) {
  const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>${keepAlive ? "<true/>" : "<false/>"}
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, plist, { mode: 0o644 });
}

async function reloadAgent(plist: string, label: string) {
  const domain = `gui/${process.getuid?.() ?? 501}`;
  await sh(["/bin/launchctl", "bootout", `${domain}/${label}`], { allowFailure: true });
  // bootout returns before the old job is gone, and bootstrapping over it fails with error 5.
  for (let i = 0; i < 50 && (await loaded(domain, label)); i++) await Bun.sleep(100);
  try {
    await sh(["/bin/launchctl", "bootstrap", domain, plist]);
  } catch {
    await Bun.sleep(1000);
    await sh(["/bin/launchctl", "bootstrap", domain, plist]);
  }
}

async function loaded(domain: string, label: string): Promise<boolean> {
  const proc = Bun.spawn(["/bin/launchctl", "print", `${domain}/${label}`], { stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function sh(cmd: string[], { allowFailure = false } = {}): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0 && !allowFailure) throw new Error(`${basename(cmd[0] ?? "")} ${cmd.slice(1, 3).join(" ")} failed: ${(stderr || stdout).trim()}`);
  return stdout;
}
