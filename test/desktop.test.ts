import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopHub } from "../src/desktop/hub.ts";
import type { DesktopWindows, WindowAction } from "../src/desktop/process.ts";
import type { DesktopProfile } from "../src/desktop/profiles.ts";
import { discoverProfiles } from "../src/desktop/profiles.ts";
import { findSession, handoffSession } from "../src/desktop/sessions.ts";
import { setup } from "./support.ts";

const NOW = Date.parse("2026-10-31T10:00:00Z");

class FakeWindows implements DesktopWindows {
  readonly actions: string[] = [];
  constructor(private readonly running = new Set<string>()) {}
  async isRunning(profile: DesktopProfile) {
    return this.running.has(profile.name);
  }
  async open(profile: DesktopProfile): Promise<WindowAction> {
    this.actions.push(`open ${profile.name}`);
    return this.running.has(profile.name) ? "focused" : "launched";
  }
  async restart(profile: DesktopProfile): Promise<WindowAction> {
    this.actions.push(`restart ${profile.name}`);
    return "restarted";
  }
  async quit(profile: DesktopProfile) {
    this.actions.push(`quit ${profile.name}`);
    this.running.delete(profile.name);
  }
}

interface FixtureProfile {
  folder: string;
  account: string | null;
  org?: string;
  usage?: { fh?: number; sd?: number; minutesAgo: number };
  sessions?: Record<string, unknown>[];
}

async function fixture(profiles: FixtureProfile[]) {
  const root = await mkdtemp(join(tmpdir(), "claude-switch-desktop-"));
  for (const p of profiles) {
    const dir = join(root, p.folder);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify(p.account ? { lastKnownAccountUuid: p.account, locale: "en" } : {}));
    if (p.usage) {
      const sample = { t: NOW - p.usage.minutesAgo * 60_000, org: "org", u: { fh: p.usage.fh, sd: p.usage.sd } };
      await writeFile(join(dir, "plan-usage-history.json"), JSON.stringify({ version: 2, samples: [{ ...sample, t: sample.t - 3_600_000, u: { fh: 1 } }, sample] }));
    }
    if (p.account && p.sessions) {
      const sessionDir = join(dir, "claude-code-sessions", p.account, p.org ?? `org-${p.account}`);
      await mkdir(sessionDir, { recursive: true });
      for (const s of p.sessions) await writeFile(join(sessionDir, `${s.sessionId}.json`), JSON.stringify(s));
    }
  }
  return root;
}

const card = (id: string, extra: Record<string, unknown> = {}) => ({
  sessionId: id,
  cliSessionId: `cli-${id}`,
  cwd: "/work/project",
  originCwd: "/work/project",
  createdAt: NOW - 86_400_000,
  lastActivityAt: NOW - 60_000,
  model: "claude-opus-5-5",
  effort: "high",
  isArchived: false,
  title: "Refactor billing",
  titleSource: "auto",
  permissionMode: "auto",
  completedTurns: 12,
  enabledMcpTools: { "connector-a:tool": true },
  remoteMcpServersConfig: [{ uuid: "connector-a", name: "Docs", url: "https://example.test/mcp", tools: [] }],
  spawnSeed: "profile-specific",
  ...extra,
});

const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

describe("discoverProfiles", () => {
  test("names profiles after their folder and reads the account and latest Desktop usage sample", async () => {
    const root = await fixture([
      { folder: "Claude", account: "acct-main", usage: { fh: 8, sd: 40, minutesAgo: 5 } },
      { folder: "Claude-kantor", account: "acct-kantor", sessions: [card("local_1")] },
      { folder: "Claude-empty", account: null },
      { folder: "NotClaude", account: "x" },
    ]);

    const profiles = await discoverProfiles(root);

    expect(profiles.map((p): unknown[] => [p.name, p.isDefault, p.accountId])).toEqual([
      ["default", true, "acct-main"],
      ["empty", false, null],
      ["kantor", false, "acct-kantor"],
    ]);
    expect(profiles[0]?.usage).toEqual({ at: new Date(NOW - 5 * 60_000).toISOString(), fiveHourPercent: 8, sevenDayPercent: 40 });
    expect(profiles[2]?.sessionRoots.map((r) => r.organizationId)).toEqual(["org-acct-kantor"]);
  });
});

describe("handoffSession", () => {
  const twoProfiles = () =>
    fixture([
      { folder: "Claude-kantor", account: "acct-kantor", sessions: [card("local_src")] },
      { folder: "Claude-pribadi", account: "acct-pribadi", sessions: [card("local_other", { cliSessionId: "cli-other" })] },
    ]);

  test("copies the session card into the target account's folder without the source account's connectors", async () => {
    const profiles = await discoverProfiles(await twoProfiles());
    const session = (await findSession(profiles, "local_src"))!;
    const target = profiles.find((p) => p.name === "pribadi")!;

    const result = await handoffSession({ session, target, sourceRunning: false, now: NOW });

    const copied = await json(result.target.path);
    expect(result.target.path).toContain(join("Claude-pribadi", "claude-code-sessions", "acct-pribadi", "org-acct-pribadi"));
    expect(copied.sessionId).toMatch(/^local_[0-9a-f-]{36}$/);
    expect(copied).toMatchObject({
      cliSessionId: "cli-local_src",
      cwd: "/work/project",
      title: "Refactor billing",
      completedTurns: 12,
      isArchived: false,
      lastActivityAt: NOW,
      enabledMcpTools: {},
      remoteMcpServersConfig: [],
    });
    expect(copied.spawnSeed).toBeUndefined();
  });

  test("archives the source card only when its window is closed", async () => {
    const closed = await discoverProfiles(await twoProfiles());
    const closedResult = await handoffSession({
      session: (await findSession(closed, "local_src"))!,
      target: closed[1]!,
      sourceRunning: false,
      now: NOW,
    });
    const open = await discoverProfiles(await twoProfiles());
    const openSession = (await findSession(open, "local_src"))!;
    const openResult = await handoffSession({ session: openSession, target: open[1]!, sourceRunning: true, now: NOW });

    expect(closedResult.sourceArchived).toBe(true);
    expect((await findSession(closed, "local_src"))?.card.isArchived).toBe(true);
    expect(openResult.sourceArchived).toBe(false);
    expect((await json(openSession.path)).isArchived).toBe(false);
  });

  test("moving a session back reuses the original card instead of creating a duplicate", async () => {
    const profiles = await discoverProfiles(await twoProfiles());
    const [kantor, pribadi] = profiles;
    const there = await handoffSession({ session: (await findSession(profiles, "local_src"))!, target: pribadi!, sourceRunning: false, now: NOW });

    const back = await handoffSession({ session: there.target, target: kantor!, sourceRunning: false, now: NOW + 1000 });

    expect(back.reusedExistingCard).toBe(true);
    expect(back.target.card.sessionId).toBe("local_src");
    expect((await json(back.target.path)).isArchived).toBe(false);
    expect((await findSession(profiles, there.target.card.sessionId))?.card.isArchived).toBe(true);
  });

  test("refuses a target profile that has never opened the Code tab", async () => {
    const profiles = await discoverProfiles(
      await fixture([
        { folder: "Claude-kantor", account: "acct-kantor", sessions: [card("local_src")] },
        { folder: "Claude-baru", account: "acct-baru" },
      ]),
    );

    await expect(
      handoffSession({ session: (await findSession(profiles, "local_src"))!, target: profiles[0]!, sourceRunning: false }),
    ).rejects.toThrow("never opened the Code tab");
  });
});

describe("DesktopHub.handoff", () => {
  test("picks the profile with the most headroom, ranking stale readings last and skipping exhausted ones", async () => {
    const t = await setup();
    const root = await fixture([
      { folder: "Claude-kantor", account: "acct-kantor", usage: { fh: 97, minutesAgo: 2 }, sessions: [card("local_src")] },
      { folder: "Claude-pribadi", account: "acct-pribadi", usage: { fh: 40, minutesAgo: 3 }, sessions: [card("local_p", { cliSessionId: "p" })] },
      { folder: "Claude-klien", account: "acct-klien", usage: { fh: 5, minutesAgo: 3 }, sessions: [card("local_k", { cliSessionId: "k" })] },
      { folder: "Claude-lama", account: "acct-lama", usage: { fh: 0, minutesAgo: 600 }, sessions: [card("local_l", { cliSessionId: "l" })] },
      { folder: "Claude-penuh", account: "acct-penuh", usage: { fh: 99, minutesAgo: 1 }, sessions: [card("local_x", { cliSessionId: "x" })] },
    ]);
    const hub = new DesktopHub(t.engine, { appSupportDir: root, windows: new FakeWindows(), now: () => NOW });

    const outcome = await hub.handoff({ sessionId: "local_src", force: false, open: false });

    expect(outcome.kind).toBe("moved");
    expect(outcome.kind === "moved" ? String(outcome.to.profile.name) : null).toBe("klien");
  });

  test("stays when the session's account is under the threshold", async () => {
    const t = await setup();
    const root = await fixture([
      { folder: "Claude-kantor", account: "acct-kantor", usage: { fh: 50, minutesAgo: 2 }, sessions: [card("local_src")] },
      { folder: "Claude-klien", account: "acct-klien", usage: { fh: 5, minutesAgo: 3 }, sessions: [card("local_k", { cliSessionId: "k" })] },
    ]);

    const hub = new DesktopHub(t.engine, { appSupportDir: root, windows: new FakeWindows(), now: () => NOW });
    const outcome = await hub.handoff({ sessionId: "local_src", force: false, open: false });

    expect(outcome).toEqual({ kind: "stay", reason: "active account at 50%" });
  });

  test("prefers a closed window over an open one with more headroom, because open windows only load sessions at startup", async () => {
    const t = await setup();
    const root = await fixture([
      { folder: "Claude-kantor", account: "acct-kantor", usage: { fh: 97, minutesAgo: 2 }, sessions: [card("local_src")] },
      { folder: "Claude-terbuka", account: "acct-terbuka", usage: { fh: 2, minutesAgo: 2 }, sessions: [card("local_o", { cliSessionId: "o" })] },
      { folder: "Claude-tertutup", account: "acct-tertutup", usage: { fh: 60, minutesAgo: 2 }, sessions: [card("local_c", { cliSessionId: "c" })] },
    ]);
    const windows = new FakeWindows(new Set(["kantor", "terbuka"]));
    const hub = new DesktopHub(t.engine, { appSupportDir: root, windows, now: () => NOW });

    const outcome = await hub.handoff({ sessionId: "local_src", force: false });

    expect(outcome.kind === "moved" ? [String(outcome.to.profile.name), outcome.window] : null).toEqual(["tertutup", "launched"]);
    expect(windows.actions).toEqual(["open tertutup"]);
  });

  test("an open target is left alone and reported as needing a reopen unless restart is requested", async () => {
    const t = await setup();
    const fixtureProfiles: FixtureProfile[] = [
      { folder: "Claude-kantor", account: "acct-kantor", sessions: [card("local_src")] },
      { folder: "Claude-terbuka", account: "acct-terbuka", sessions: [card("local_o", { cliSessionId: "o" })] },
    ];
    const plainWindows = new FakeWindows(new Set(["terbuka"]));
    const plain = new DesktopHub(t.engine, { appSupportDir: await fixture(fixtureProfiles), windows: plainWindows, now: () => NOW });
    const restartWindows = new FakeWindows(new Set(["terbuka"]));
    const restarting = new DesktopHub(t.engine, { appSupportDir: await fixture(fixtureProfiles), windows: restartWindows, now: () => NOW });

    const left = await plain.handoff({ sessionId: "local_src", to: "terbuka", force: true });
    const restarted = await restarting.handoff({ sessionId: "local_src", to: "terbuka", force: true, restart: true });

    expect(left.kind === "moved" && left.window).toBe("needs_reopen");
    expect(plainWindows.actions).toEqual([]);
    expect(restarted.kind === "moved" && restarted.window).toBe("restarted");
    expect(restartWindows.actions).toEqual(["restart terbuka"]);
  });
});

describe("profile labels", () => {
  const labelled = async () => {
    const t = await setup();
    const root = await fixture([
      { folder: "Claude", account: "acct-main", sessions: [card("local_src")] },
      { folder: "Claude-3p", account: "acct-3p", sessions: [card("local_3", { cliSessionId: "c3" })] },
    ]);
    return { t, hub: new DesktopHub(t.engine, { appSupportDir: root, windows: new FakeWindows(), now: () => NOW }) };
  };

  test("a label replaces the folder name in the overview and can be used to pick a handoff target", async () => {
    const { hub } = await labelled();
    await hub.setLabel("3p", "  Klien 3P  ");

    const names = (await hub.overview()).profiles.map((p) => [String(p.profile.name), p.profile.label]);
    const outcome = await hub.handoff({ sessionId: "local_src", to: "klien 3p", force: true, open: false });

    expect(names).toEqual([
      ["default", null],
      ["3p", "Klien 3P"],
    ]);
    expect(outcome.kind === "moved" ? String(outcome.to.profile.name) : null).toBe("3p");
  });

  test("clearing a label, or setting it to the folder name, shows the folder name again", async () => {
    const { hub } = await labelled();
    await hub.setLabel("3p", "Klien");
    await hub.setLabel("Klien", null);
    await hub.setLabel("default", "default");

    expect((await hub.overview()).profiles.map((p) => p.profile.label)).toEqual([null, null]);
  });

  test("rejects labels that are too long or already name another profile", async () => {
    const { hub } = await labelled();
    await expect(hub.setLabel("3p", "x".repeat(41))).rejects.toThrow("at most 40");
    await expect(hub.setLabel("3p", "Default")).rejects.toThrow("already used by profile default");
  });
});

describe("Desktop profiles and updates", () => {
  const plist = (entries: Record<string, string>) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${Object.entries(entries)
      .map(([k, v]) => `<key>${k}</key><string>${v}</string>`)
      .join("")}</dict></plist>\n`;

  const appWithUpdate = async (installed: string, staged: string | null) => {
    const root = await mkdtemp(join(tmpdir(), "claude-switch-update-"));
    const appBundle = join(root, "Claude.app");
    const stagedBundle = join(root, "update.x", "Claude.app");
    const shipItState = join(root, "ShipItState.plist");
    await mkdir(join(appBundle, "Contents"), { recursive: true });
    await writeFile(join(appBundle, "Contents", "Info.plist"), plist({ CFBundleShortVersionString: installed }));
    if (staged) {
      await mkdir(join(stagedBundle, "Contents"), { recursive: true });
      await writeFile(join(stagedBundle, "Contents", "Info.plist"), plist({ CFBundleShortVersionString: staged }));
      await writeFile(shipItState, plist({ updateBundleURL: `file://${stagedBundle}/` }));
    }
    return { appBundle, shipItState, install: () => writeFile(join(appBundle, "Contents", "Info.plist"), plist({ CFBundleShortVersionString: staged ?? installed })) };
  };

  test("creates a new profile folder and opens a window for it", async () => {
    const t = await setup();
    const root = await fixture([{ folder: "Claude-kantor", account: "acct-kantor", sessions: [card("local_src")] }]);
    const windows = new FakeWindows();
    const hub = new DesktopHub(t.engine, { appSupportDir: root, windows, now: () => NOW });

    const { profile } = await hub.createProfile("klien-baru");

    expect(profile.dir).toBe(join(root, "Claude-klien-baru"));
    expect((await stat(profile.dir)).isDirectory()).toBe(true);
    expect(windows.actions).toEqual(["open klien-baru"]);
    await expect(hub.createProfile("kantor")).rejects.toThrow("already exists");
    await expect(hub.createProfile("bad name")).rejects.toThrow("letters, digits");
  });

  test("reports a downloaded update only when its version differs from the installed one", async () => {
    const t = await setup();
    const waiting = await appWithUpdate("4.4", "4.5");
    const none = await appWithUpdate("4.4", null);
    const root = await fixture([]);

    const withUpdate = await new DesktopHub(t.engine, { appSupportDir: root, windows: new FakeWindows(), updates: waiting }).overview();
    const without = await new DesktopHub(t.engine, { appSupportDir: root, windows: new FakeWindows(), updates: none }).overview();

    expect(withUpdate.update).toEqual({ installed: "4.4", staged: "4.5" });
    expect(without.update).toEqual({ installed: "4.4", staged: null });
  });

  test("installing an update quits every open profile, waits for the new version and reopens them", async () => {
    const t = await setup();
    const app = await appWithUpdate("4.4", "4.5");
    const root = await fixture([
      { folder: "Claude-kantor", account: "acct-kantor", sessions: [card("local_src")] },
      { folder: "Claude-klien", account: "acct-klien", sessions: [card("local_k", { cliSessionId: "k" })] },
      { folder: "Claude-tutup", account: "acct-tutup", sessions: [card("local_t", { cliSessionId: "t" })] },
    ]);
    const windows = new FakeWindows(new Set(["kantor", "klien"]));
    const realQuit = windows.quit.bind(windows);
    windows.quit = async (profile) => {
      await realQuit(profile);
      if (windows.actions.filter((a) => a.startsWith("quit")).length === 2) await app.install();
    };
    const hub = new DesktopHub(t.engine, { appSupportDir: root, windows, updates: app });

    const result = await hub.installUpdate();

    expect(result).toEqual({ from: "4.4", to: "4.5", installed: true, reopened: ["kantor", "klien"] });
    expect(windows.actions).toEqual(["quit kantor", "quit klien", "open kantor", "open klien"]);
  });
});
