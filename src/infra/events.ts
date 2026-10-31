import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

const Event = z.object({
  ts: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type AppEvent = z.infer<typeof Event>;

const KEEP = 200;

export class EventLog {
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = join(stateDir, "events.jsonl");
  }

  async emit(event: Omit<AppEvent, "ts">, now = Date.now()): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await appendFile(this.file, `${JSON.stringify({ ts: new Date(now).toISOString(), ...event })}\n`, { mode: 0o600 });
    const lines = (await readFile(this.file, "utf8")).split("\n").filter(Boolean);
    if (lines.length > KEEP * 2) await writeFile(this.file, `${lines.slice(-KEEP).join("\n")}\n`, { mode: 0o600 });
  }

  async since(iso: string | null): Promise<AppEvent[]> {
    const text = await readFile(this.file, "utf8").catch(() => "");
    const after = iso ? Date.parse(iso) : 0;
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => Event.safeParse(JSON.parse(line)))
      .flatMap((r) => (r.success ? [r.data] : []))
      .filter((e) => Date.parse(e.ts) > after);
  }
}
