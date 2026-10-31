import type { DesktopProfile } from "./profiles.ts";

const MAIN_BINARY = "/Applications/Claude.app/Contents/MacOS/Claude";
const QUIT_TIMEOUT_MS = 20_000;
const PS_CACHE_MS = 500;

export type WindowAction = "focused" | "launched" | "restarted";

export interface DesktopWindows {
  isRunning(profile: DesktopProfile): Promise<boolean>;
  open(profile: DesktopProfile): Promise<WindowAction>;
  restart(profile: DesktopProfile): Promise<WindowAction>;
  quit(profile: DesktopProfile): Promise<void>;
}

export class MacDesktopWindows implements DesktopWindows {
  async isRunning(profile: DesktopProfile): Promise<boolean> {
    return (await this.pid(profile)) !== undefined;
  }

  async open(profile: DesktopProfile): Promise<WindowAction> {
    const pid = await this.pid(profile);
    if (pid !== undefined) {
      await exec(["/usr/bin/osascript", "-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`]);
      return "focused";
    }
    await this.launch(profile);
    return "launched";
  }

  async restart(profile: DesktopProfile): Promise<WindowAction> {
    const wasRunning = await this.isRunning(profile);
    await this.quit(profile);
    await this.launch(profile);
    return wasRunning ? "restarted" : "launched";
  }

  async quit(profile: DesktopProfile): Promise<void> {
    const pid = await this.pid(profile);
    if (pid === undefined) return;
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + QUIT_TIMEOUT_MS;
    while ((await this.pid(profile)) !== undefined) {
      if (Date.now() > deadline) throw new Error(`Claude (${profile.name}) did not quit within ${QUIT_TIMEOUT_MS / 1000}s`);
      await Bun.sleep(250);
    }
  }

  private snapshot: { at: number; running: Promise<Map<string, number>> } | null = null;

  private async pid(profile: DesktopProfile): Promise<number | undefined> {
    if (!this.snapshot || Date.now() - this.snapshot.at > PS_CACHE_MS) this.snapshot = { at: Date.now(), running: runningProfiles() };
    return profilePid(await this.snapshot.running, profile);
  }

  private async launch(profile: DesktopProfile): Promise<void> {
    const args = profile.isDefault ? ["-n", "-a", "Claude"] : ["-n", "-a", "Claude", "--args", `--user-data-dir=${profile.dir}`];
    await exec(["/usr/bin/open", ...args]);
  }
}

export async function runningProfiles(): Promise<Map<string, number>> {
  const proc = Bun.spawn(["/bin/ps", "-axo", "pid=,command="], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  const running = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match?.[2]?.startsWith(MAIN_BINARY)) continue;
    const args = match[2].slice(MAIN_BINARY.length);
    const dir = args.match(/--user-data-dir=(.+?)(?:\s+--|$)/)?.[1]?.trim() ?? "default";
    running.set(dir, Number(match[1]));
  }
  return running;
}

function profilePid(running: Map<string, number>, profile: DesktopProfile): number | undefined {
  return running.get(profile.isDefault ? "default" : profile.dir) ?? (profile.isDefault ? running.get(profile.dir) : undefined);
}

async function exec(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`${cmd[0]} failed: ${stderr.trim()}`);
}
