import { readdir, rename, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import { readJson, writeJsonAtomic } from "../infra/files.ts";

// Every Claude Desktop profile downloads its own copy of the same Linux VM (about 11 GB).
// Identical copies are replaced with APFS clones: each file keeps its own name and metadata,
// the data blocks are stored once, and a later write to one copy only splits the blocks it touches.

export const VM_DIR = "vm_bundles";
const MIN_SIZE = 1024 * 1024;
const TEMP_SUFFIX = ".cs-share";

const Version = z.object({ ino: z.number(), size: z.number(), mtimeMs: z.number() });
const StateFile = z.object({
  version: z.literal(1),
  hashes: z.record(z.string(), Version.extend({ sha256: z.string() })),
  shared: z.record(z.string(), Version.extend({ source: z.string() })),
  sharedBytes: z.number(),
});
export type VmShareState = z.infer<typeof StateFile>;
type FileVersion = z.infer<typeof Version>;

export interface VmFile extends FileVersion {
  profile: string;
  path: string;
  rel: string;
  allocated: number;
}

export interface SharePlan {
  source: VmFile;
  target: VmFile;
}

export class VmShareStore {
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = join(stateDir, "vm-share.json");
  }

  async load(): Promise<VmShareState> {
    return (await readJson(this.file, StateFile).catch(() => null)) ?? { version: 1, hashes: {}, shared: {}, sharedBytes: 0 };
  }

  async save(state: VmShareState): Promise<void> {
    await writeJsonAtomic(this.file, state);
  }
}

export async function listVmFiles(profiles: readonly { name: string; dir: string }[]): Promise<VmFile[]> {
  const files: VmFile[] = [];
  for (const profile of profiles) {
    const root = join(profile.dir, VM_DIR);
    const entries = await readdir(root, { withFileTypes: true, recursive: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith(TEMP_SUFFIX)) continue;
      const path = join(entry.parentPath, entry.name);
      const info = await stat(path).catch(() => null);
      if (!info || info.size < MIN_SIZE) continue;
      files.push({ profile: profile.name, path, rel: relative(root, path), ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, allocated: info.blocks * 512 });
    }
  }
  return files;
}

function sameVersion(a: FileVersion | undefined, b: FileVersion): boolean {
  return a !== undefined && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Files that have a twin at the same place in another profile, so hashing the rest is wasted work. */
export function candidates(files: readonly VmFile[]): VmFile[] {
  const counts = new Map<string, number>();
  for (const f of files) counts.set(`${f.rel}\0${f.size}`, (counts.get(`${f.rel}\0${f.size}`) ?? 0) + 1);
  return files.filter((f) => (counts.get(`${f.rel}\0${f.size}`) ?? 0) > 1);
}

/**
 * Which copies to replace with a clone. Copies are grouped by place in the bundle and content; each group
 * keeps one source (the copy others were cloned from before, else the first profile's), and every other
 * copy that is not already a clone of it, and that no running profile or open handle is using, becomes one.
 */
export function planShares({
  files,
  hashes,
  shared,
  busy,
}: {
  files: readonly VmFile[];
  hashes: VmShareState["hashes"];
  shared: VmShareState["shared"];
  busy: (file: VmFile) => boolean;
}): SharePlan[] {
  const groups = new Map<string, VmFile[]>();
  for (const file of files) {
    const hash = hashes[file.path];
    if (!sameVersion(hash, file)) continue;
    const key = `${file.rel}\0${file.size}\0${hash!.sha256}`;
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  const plans: SharePlan[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const previous = new Set(group.map((f) => shared[f.path]?.source).filter(Boolean));
    const source = group.find((f) => previous.has(f.path)) ?? group[0]!;
    for (const target of group) {
      if (target === source) continue;
      const record = shared[target.path];
      if (record && sameVersion(record, target) && record.source === source.path) continue;
      if (busy(source) || busy(target)) continue;
      plans.push({ source, target });
    }
  }
  return plans;
}

export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

export interface ShareResult {
  shared: { profile: string; rel: string; size: number }[];
  freedBytes: number;
  sharedBytes: number;
  skipped: { profile: string; rel: string; reason: string }[];
}

export async function shareVmFiles({
  profiles,
  store,
  isRunning,
  isOpen = fileIsOpen,
  dryRun = false,
}: {
  profiles: readonly { name: string; dir: string }[];
  store: VmShareStore;
  isRunning: (profile: string) => boolean;
  isOpen?: (path: string) => Promise<boolean>;
  dryRun?: boolean;
}): Promise<ShareResult> {
  const state = await store.load();
  const files = await listVmFiles(profiles);
  const twins = candidates(files);
  for (const file of twins) {
    if (!sameVersion(state.hashes[file.path], file)) state.hashes[file.path] = { ino: file.ino, size: file.size, mtimeMs: file.mtimeMs, sha256: await sha256File(file.path) };
  }
  const present = new Set(files.map((f) => f.path));
  for (const path of Object.keys(state.hashes)) if (!present.has(path)) delete state.hashes[path];
  for (const path of Object.keys(state.shared)) if (!present.has(path)) delete state.shared[path];

  const open = new Set<string>();
  for (const file of twins) if (!isRunning(file.profile) && (await isOpen(file.path))) open.add(file.path);
  const skipped: ShareResult["skipped"] = [];
  const busy = (file: VmFile) => {
    const reason = isRunning(file.profile) ? "the profile's window is open" : open.has(file.path) ? "the file is in use" : null;
    if (reason && !skipped.some((s) => s.profile === file.profile && s.rel === file.rel)) skipped.push({ profile: file.profile, rel: file.rel, reason });
    return reason !== null;
  };
  const plans = planShares({ files: twins, hashes: state.hashes, shared: state.shared, busy });

  const result: ShareResult = { shared: [], freedBytes: 0, sharedBytes: 0, skipped };
  for (const { source, target } of plans) {
    if (dryRun) {
      result.shared.push({ profile: target.profile, rel: target.rel, size: target.size });
      result.freedBytes += target.allocated;
      continue;
    }
    const clone = await cloneOver(source, target);
    if (!clone) {
      skipped.push({ profile: target.profile, rel: target.rel, reason: "it changed or could not be cloned" });
      continue;
    }
    state.hashes[target.path] = { ...clone, sha256: state.hashes[source.path]!.sha256 };
    state.shared[target.path] = { ...clone, source: source.path };
    result.shared.push({ profile: target.profile, rel: target.rel, size: target.size });
    result.freedBytes += target.allocated;
  }

  for (const [path, record] of Object.entries(state.shared)) {
    const info = await stat(path).catch(() => null);
    if (info && sameVersion(record, { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs })) result.sharedBytes += record.size;
    else delete state.shared[path];
  }
  state.sharedBytes = result.sharedBytes;
  if (dryRun) result.sharedBytes += result.freedBytes;
  await store.save(state);
  return result;
}

/** Clones source to a temporary name next to target, then renames it over target, if neither changed since it was hashed. */
async function cloneOver(source: VmFile, target: VmFile): Promise<FileVersion | null> {
  const current = async (f: VmFile) => {
    const info = await stat(f.path).catch(() => null);
    return info !== null && sameVersion(f, { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs });
  };
  if (!(await current(source)) || !(await current(target))) return null;
  const temp = target.path + TEMP_SUFFIX;
  await rm(temp, { force: true });
  const proc = Bun.spawn(["/bin/cp", "-c", "-p", source.path, temp], { stdout: "ignore", stderr: "ignore" });
  const info = (await proc.exited) === 0 ? await stat(temp).catch(() => null) : null;
  if (!info || info.size !== target.size || !(await current(target))) {
    await rm(temp, { force: true });
    return null;
  }
  await rename(temp, target.path);
  const placed = await stat(target.path);
  return { ino: placed.ino, size: placed.size, mtimeMs: placed.mtimeMs };
}

async function fileIsOpen(path: string): Promise<boolean> {
  const proc = Bun.spawn(["/usr/sbin/lsof", "-t", "--", path], { stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0;
}
