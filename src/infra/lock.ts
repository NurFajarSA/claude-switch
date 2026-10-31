import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const ORPHAN_LOCK_MS = 30_000;

export class LockTimeoutError extends Error {
  override name = "LockTimeoutError";
}

export async function withLock<T>(lockDir: string, fn: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
  await mkdir(dirname(lockDir), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
      if (await isStale(lockDir)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new LockTimeoutError(`timed out waiting for ${lockDir}`);
      await Bun.sleep(100);
    }
  }
  await writeFile(join(lockDir, "pid"), String(process.pid));
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function isStale(lockDir: string): Promise<boolean> {
  let pid: number;
  try {
    pid = Number(await readFile(join(lockDir, "pid"), "utf8"));
  } catch {
    const info = await stat(lockDir).catch(() => null);
    return info !== null && Date.now() - info.mtimeMs > ORPHAN_LOCK_MS;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "ESRCH";
  }
}
