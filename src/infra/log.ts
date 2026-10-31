import { appendFile, mkdir, stat, rename } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_BYTES = 1_000_000;

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  flush(): Promise<void>;
}

export function fileLogger(path: string): Logger {
  let chain: Promise<void> = Promise.resolve();
  const write = (level: string, event: string, fields: Record<string, unknown> = {}) => {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), level, event, pid: process.pid, ...fields })}\n`;
    chain = chain
      .then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const size = await stat(path).then((s) => s.size, () => 0);
        if (size > MAX_BYTES) await rename(path, `${path}.1`);
        await appendFile(path, line, { mode: 0o600 });
      })
      .catch(() => {});
  };
  return {
    info: (e, f) => write("info", e, f),
    warn: (e, f) => write("warn", e, f),
    error: (e, f) => write("error", e, f),
    flush: () => chain,
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {}, flush: async () => {} };
