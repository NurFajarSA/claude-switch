import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { idleProfiles } from "../src/housekeeping/idle.ts";
import { scanTranscripts, toolKey, unusedServers } from "../src/housekeeping/mcp-usage.ts";
import { EventLog } from "../src/infra/events.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-01T10:00:00Z");

describe("idleProfiles", () => {
  const base = { startedAt: NOW - 10 * HOUR };

  test("closes windows whose sessions have not changed for the idle period", () => {
    const names = idleProfiles({
      candidates: [
        { name: "kantor", pid: 1, ...base, lastActivity: NOW - 4 * HOUR },
        { name: "pribadi", pid: 2, ...base, lastActivity: NOW - 1 * HOUR },
      ],
      frontmostPid: null,
      idleMs: 3 * HOUR,
      now: NOW,
    });
    expect(names).toEqual(["kantor"]);
  });

  test("keeps the window in front, windows opened recently, windows with no sessions, and everything when off", () => {
    const candidates = [
      { name: "front", pid: 1, ...base, lastActivity: NOW - 9 * HOUR },
      { name: "fresh", pid: 2, startedAt: NOW - 1 * HOUR, lastActivity: NOW - 9 * HOUR },
      { name: "empty", pid: 3, ...base, lastActivity: null },
    ];
    expect(idleProfiles({ candidates, frontmostPid: 1, idleMs: 3 * HOUR, now: NOW })).toEqual([]);
    expect(idleProfiles({ candidates, frontmostPid: null, idleMs: 0, now: NOW })).toEqual([]);
  });
});

describe("MCP usage", () => {
  test("finds servers no session used in 30 days, ignoring servers added recently", async () => {
    const projects = await mkdtemp(join(tmpdir(), "claude-switch-projects-"));
    await mkdir(join(projects, "app"), { recursive: true });
    const recent = join(projects, "app", "a.jsonl");
    await writeFile(recent, `{"type":"assistant","content":[{"type":"tool_use","name":"mcp__notion__notion-search"}]}\n{"name":"mcp__plugin_firebase_firebase__deploy"}\n`);
    await utimes(recent, new Date(NOW - 2 * DAY), new Date(NOW - 2 * DAY));

    const usage = await scanTranscripts({
      projectsDir: projects,
      usage: { version: 1, scannedAt: 0, lastUsed: {}, firstSeen: { notion: NOW - 60 * DAY, canva: NOW - 60 * DAY, figma: NOW - 5 * DAY }, notifiedAt: null },
      servers: ["notion", "canva", "figma", "google-calendar"],
      now: NOW,
    });

    expect(usage.lastUsed[toolKey("notion")]).toBe(NOW - 2 * DAY);
    expect(usage.lastUsed[toolKey("plugin:firebase:firebase")]).toBe(NOW - 2 * DAY);
    expect(usage.firstSeen["google-calendar"]).toBe(NOW);
    expect(unusedServers({ usage, servers: ["notion", "canva", "figma", "google-calendar"], days: 30, now: NOW })).toEqual([{ name: "canva", lastUsed: null }]);
  });
});

describe("EventLog", () => {
  test("returns events after a given time, oldest first", async () => {
    const log = new EventLog(await mkdtemp(join(tmpdir(), "claude-switch-events-")));
    await log.emit({ kind: "a", title: "A", body: "", data: {} }, NOW - 2000);
    await log.emit({ kind: "b", title: "B", body: "", data: { x: 1 } }, NOW - 1000);

    expect((await log.since(null)).map((e) => e.kind)).toEqual(["a", "b"]);
    expect((await log.since(new Date(NOW - 1500).toISOString())).map((e) => e.title)).toEqual(["B"]);
  });
});
