import { join } from "node:path";
import { z } from "zod";
import { readJson, writeJsonAtomic } from "../infra/files.ts";

const LabelsFile = z.object({ version: z.literal(1), labels: z.record(z.string(), z.string()) });

export const MAX_LABEL_LENGTH = 40;

export class ProfileLabels {
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = join(stateDir, "profile-labels.json");
  }

  async load(): Promise<Record<string, string>> {
    return (await readJson(this.file, LabelsFile).catch(() => null))?.labels ?? {};
  }

  async set(profileName: string, label: string | null): Promise<void> {
    const labels = await this.load();
    if (label === null) delete labels[profileName];
    else labels[profileName] = label;
    await writeJsonAtomic(this.file, { version: 1, labels });
  }
}
