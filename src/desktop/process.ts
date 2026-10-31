import type { DesktopProfile } from "./profiles.ts";

const MAIN_BINARY = "/Applications/Claude.app/Contents/MacOS/Claude";

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

export function profilePid(running: Map<string, number>, profile: DesktopProfile): number | undefined {
  return running.get(profile.isDefault ? "default" : profile.dir) ?? (profile.isDefault ? running.get(profile.dir) : undefined);
}

export async function openProfile(profile: DesktopProfile): Promise<"focused" | "launched"> {
  const pid = profilePid(await runningProfiles(), profile);
  if (pid !== undefined) {
    await exec(["/usr/bin/osascript", "-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`]);
    return "focused";
  }
  const args = profile.isDefault ? ["-n", "-a", "Claude"] : ["-n", "-a", "Claude", "--args", `--user-data-dir=${profile.dir}`];
  await exec(["/usr/bin/open", ...args]);
  return "launched";
}

async function exec(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`${cmd[0]} failed: ${stderr.trim()}`);
}
