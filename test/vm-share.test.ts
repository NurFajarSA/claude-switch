import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planShares, shareVmFiles, type VmFile, VmShareStore } from "../src/housekeeping/vm-share.ts";

const MB = 1024 * 1024;

function file(profile: string, ino: number, rel = "claudevm.bundle/rootfs.img"): VmFile {
  return { profile, path: `/p/${profile}/vm_bundles/${rel}`, rel, ino, size: 10 * MB, mtimeMs: 1, allocated: 10 * MB };
}

function hashed(files: VmFile[], sha = (f: VmFile) => "same") {
  return Object.fromEntries(files.map((f) => [f.path, { ino: f.ino, size: f.size, mtimeMs: f.mtimeMs, sha256: sha(f) }]));
}

describe("planShares", () => {
  test("clones every identical copy from the first profile's", () => {
    const files = [file("Claude", 1), file("Claude-a", 2), file("Claude-b", 3)];
    const plans = planShares({ files, hashes: hashed(files), shared: {}, busy: () => false });
    expect(plans.map((p) => [p.source.profile, p.target.profile])).toEqual([
      ["Claude", "Claude-a"],
      ["Claude", "Claude-b"],
    ]);
  });

  test("leaves copies with different content, unhashed copies, and finished clones alone", () => {
    const files = [file("Claude", 1), file("Claude-a", 2), file("Claude-b", 3), file("Claude-c", 4)];
    const hashes = hashed(files, (f) => (f.profile === "Claude-b" ? "other" : "same"));
    delete hashes[files[3]!.path];
    const shared = { [files[1]!.path]: { ino: 2, size: 10 * MB, mtimeMs: 1, source: files[0]!.path } };
    expect(planShares({ files, hashes, shared, busy: () => false })).toEqual([]);
  });

  test("redoes a clone that was rewritten, and keeps the earlier source", () => {
    const files = [file("Claude", 1), file("Claude-a", 2), file("Claude-b", 9)];
    const shared = {
      [files[1]!.path]: { ino: 2, size: 10 * MB, mtimeMs: 1, source: files[2]!.path },
      [files[0]!.path]: { ino: 5, size: 10 * MB, mtimeMs: 1, source: files[2]!.path },
    };
    const plans = planShares({ files, hashes: hashed(files), shared, busy: () => false });
    expect(plans.map((p) => [p.source.profile, p.target.profile])).toEqual([["Claude-b", "Claude"]]);
  });

  test("skips a group member whose profile is busy, and the whole group when the source is", () => {
    const files = [file("Claude", 1), file("Claude-a", 2), file("Claude-b", 3)];
    expect(planShares({ files, hashes: hashed(files), shared: {}, busy: (f) => f.profile === "Claude-a" }).map((p) => p.target.profile)).toEqual(["Claude-b"]);
    expect(planShares({ files, hashes: hashed(files), shared: {}, busy: (f) => f.profile === "Claude" })).toEqual([]);
  });
});

describe("shareVmFiles", () => {
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "vm-share-"));
    const body = Buffer.alloc(2 * MB, 7);
    const profiles = [];
    for (const name of ["Claude", "Claude-a", "Claude-b", "Claude-c"]) {
      const dir = join(root, name);
      await mkdir(join(dir, "vm_bundles", "claudevm.bundle"), { recursive: true });
      const content = name === "Claude-c" ? Buffer.alloc(2 * MB, 9) : body;
      await writeFile(join(dir, "vm_bundles", "claudevm.bundle", "rootfs.img"), content);
      await writeFile(join(dir, "vm_bundles", "claudevm.bundle", "small"), "tiny");
      profiles.push({ name, dir });
    }
    return { root, profiles, store: new VmShareStore(join(root, "state")) };
  }

  test("replaces identical copies with clones, keeps content, and is idempotent", async () => {
    const { profiles, store } = await setup();
    await mkdir(join(profiles[0]!.dir, "..", "state"), { recursive: true });
    const before = await stat(join(profiles[1]!.dir, "vm_bundles/claudevm.bundle/rootfs.img"));

    const dry = await shareVmFiles({ profiles, store, isRunning: () => false, isOpen: async () => false, dryRun: true });
    expect(dry.shared.map((s) => s.profile)).toEqual(["Claude-a", "Claude-b"]);
    expect((await stat(join(profiles[1]!.dir, "vm_bundles/claudevm.bundle/rootfs.img"))).ino).toBe(before.ino);

    const first = await shareVmFiles({ profiles, store, isRunning: () => false, isOpen: async () => false });
    expect(first.shared.map((s) => s.profile)).toEqual(["Claude-a", "Claude-b"]);
    expect(first.sharedBytes).toBe(4 * MB);
    const after = await stat(join(profiles[1]!.dir, "vm_bundles/claudevm.bundle/rootfs.img"));
    expect(after.ino).not.toBe(before.ino);
    expect(after.mtimeMs).toBe((await stat(join(profiles[0]!.dir, "vm_bundles/claudevm.bundle/rootfs.img"))).mtimeMs);
    expect(await readFile(join(profiles[2]!.dir, "vm_bundles/claudevm.bundle/rootfs.img"))).toEqual(Buffer.alloc(2 * MB, 7));
    expect(await readFile(join(profiles[3]!.dir, "vm_bundles/claudevm.bundle/rootfs.img"))).toEqual(Buffer.alloc(2 * MB, 9));

    const second = await shareVmFiles({ profiles, store, isRunning: () => false, isOpen: async () => false });
    expect(second.shared).toEqual([]);
    expect(second.sharedBytes).toBe(4 * MB);
    expect((await store.load()).sharedBytes).toBe(4 * MB);
  });

  test("does not touch a profile whose window is open or a file in use", async () => {
    const { profiles, store } = await setup();
    await mkdir(join(profiles[0]!.dir, "..", "state"), { recursive: true });
    const inUse = join(profiles[2]!.dir, "vm_bundles/claudevm.bundle/rootfs.img");
    const result = await shareVmFiles({ profiles, store, isRunning: (p) => p === "Claude-a", isOpen: async (path) => path === inUse });
    expect(result.shared).toEqual([]);
    expect(result.skipped.map((s) => `${s.profile}: ${s.reason}`).sort()).toEqual(["Claude-a: the profile's window is open", "Claude-b: the file is in use"]);
  });
});
