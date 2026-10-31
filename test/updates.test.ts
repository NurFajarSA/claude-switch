import { describe, expect, test } from "bun:test";
import { REOPEN_WINDOW_MS, watchTick } from "../src/desktop/updates.ts";

const T = Date.parse("2026-10-31T10:00:00Z");

describe("watchTick", () => {
  test("reopens the profiles that were open shortly before Claude Desktop updated itself", () => {
    const before = watchTick({ previous: null, version: "4.4", running: ["default", "kantor", "klien"], now: T });
    const allQuit = watchTick({ previous: before.state, version: "4.4", running: [], now: T + 60_000 });

    const afterUpdate = watchTick({ previous: allQuit.state, version: "4.5", running: ["default"], now: T + 90_000 });

    expect(allQuit.reopen).toEqual([]);
    expect(afterUpdate.reopen).toEqual(["kantor", "klien"]);
  });

  test("does not reopen profiles the user closed long before the update", () => {
    const before = watchTick({ previous: null, version: "4.4", running: ["kantor"], now: T });
    const later = watchTick({ previous: before.state, version: "4.4", running: [], now: T + REOPEN_WINDOW_MS + 1 });

    const afterUpdate = watchTick({ previous: later.state, version: "4.5", running: [], now: T + REOPEN_WINDOW_MS + 2 });

    expect(afterUpdate.reopen).toEqual([]);
  });

  test("reopens nothing when the version is unchanged or unknown", () => {
    const first = watchTick({ previous: null, version: "4.4", running: ["kantor"], now: T });
    expect(watchTick({ previous: first.state, version: "4.4", running: [], now: T + 1 }).reopen).toEqual([]);
    expect(watchTick({ previous: first.state, version: null, running: [], now: T + 1 }).reopen).toEqual([]);
  });
});
