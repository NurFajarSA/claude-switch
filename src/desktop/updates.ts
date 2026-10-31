import { join } from "node:path";
import { z } from "zod";
import { readJson, writeJsonAtomic } from "../infra/files.ts";

export interface DesktopUpdateState {
  installed: string | null;
  staged: string | null;
}

export interface UpdatePaths {
  appBundle: string;
  shipItState: string;
}

export function updatePaths(home: string): UpdatePaths {
  return {
    appBundle: "/Applications/Claude.app",
    shipItState: join(home, "Library", "Caches", "com.anthropic.claudefordesktop.ShipIt", "ShipItState.plist"),
  };
}

export async function readUpdateState(paths: UpdatePaths): Promise<DesktopUpdateState> {
  const installed = await bundleVersion(paths.appBundle);
  const stagedUrl = await plistValue(paths.shipItState, "updateBundleURL");
  const stagedPath = stagedUrl ? decodeURIComponent(stagedUrl.replace(/^file:\/\//, "")) : null;
  const staged = stagedPath ? await bundleVersion(stagedPath) : null;
  return { installed, staged: staged && staged !== installed ? staged : null };
}

async function bundleVersion(bundle: string): Promise<string | null> {
  return plistValue(join(bundle, "Contents", "Info.plist"), "CFBundleShortVersionString");
}

async function plistValue(file: string, key: string): Promise<string | null> {
  const proc = Bun.spawn(["/usr/bin/plutil", "-extract", key, "raw", file], { stdout: "pipe", stderr: "ignore" });
  const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 && text.trim() ? text.trim() : null;
}

const WatchState = z.object({
  version: z.string().nullable(),
  lastSeenRunning: z.record(z.string(), z.number()),
});
export type WatchState = z.infer<typeof WatchState>;

export const REOPEN_WINDOW_MS = 15 * 60_000;

export interface WatchTick {
  state: WatchState;
  reopen: string[];
}

export function watchTick({
  previous,
  version,
  running,
  now,
}: {
  previous: WatchState | null;
  version: string | null;
  running: readonly string[];
  now: number;
}): WatchTick {
  const lastSeenRunning: Record<string, number> = {};
  for (const [name, at] of Object.entries(previous?.lastSeenRunning ?? {})) {
    if (now - at <= REOPEN_WINDOW_MS) lastSeenRunning[name] = at;
  }
  const updated = previous !== null && previous.version !== null && version !== null && previous.version !== version;
  const reopen = updated ? Object.keys(lastSeenRunning).filter((name) => !running.includes(name)) : [];
  for (const name of running) lastSeenRunning[name] = now;
  return { state: { version, lastSeenRunning }, reopen: reopen.sort() };
}

export class WatchStore {
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = join(stateDir, "desktop-watch.json");
  }

  async load(): Promise<WatchState | null> {
    return readJson(this.file, WatchState).catch(() => null);
  }

  async save(state: WatchState): Promise<void> {
    await writeJsonAtomic(this.file, state);
  }
}
