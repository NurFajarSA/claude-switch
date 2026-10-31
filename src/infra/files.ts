import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";

export async function readJson<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S> | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  return schema.parse(JSON.parse(text));
}

export async function readRawJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return isPlainObject(value) ? value : null;
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

export async function writeJsonAtomic(path: string, data: unknown, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode });
  await chmod(tmp, mode);
  await rename(tmp, path);
}

export async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

export function isMissing(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
