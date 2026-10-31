import { join } from "node:path";
import { z } from "zod";
import { type AccountId, AccountId as toAccountId } from "../domain/account.ts";
import { normalizeFolder, type ProjectRule } from "../domain/rules.ts";
import { readJson, writeJsonAtomic } from "../infra/files.ts";

const RulesFile = z.object({
  version: z.literal(1),
  rules: z.array(z.object({ path: z.string(), accounts: z.array(z.string().transform(toAccountId)) })),
});

export class RulesStore {
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = join(stateDir, "rules.json");
  }

  async list(): Promise<ProjectRule[]> {
    return (await readJson(this.file, RulesFile).catch(() => null))?.rules ?? [];
  }

  async set(path: string, accounts: readonly AccountId[]): Promise<ProjectRule> {
    const folder = normalizeFolder(path);
    const rule: ProjectRule = { path: folder, accounts: [...new Set(accounts)] };
    const rules = (await this.list()).filter((r) => normalizeFolder(r.path) !== folder);
    await this.save([...rules, rule]);
    return rule;
  }

  async allow(path: string, account: AccountId): Promise<ProjectRule | null> {
    const folder = normalizeFolder(path);
    const existing = (await this.list()).find((r) => normalizeFolder(r.path) === folder);
    if (!existing) return null;
    return this.set(folder, [...existing.accounts, account]);
  }

  async remove(path: string): Promise<boolean> {
    const folder = normalizeFolder(path);
    const rules = await this.list();
    const next = rules.filter((r) => normalizeFolder(r.path) !== folder);
    if (next.length === rules.length) return false;
    await this.save(next);
    return true;
  }

  private async save(rules: ProjectRule[]): Promise<void> {
    await writeJsonAtomic(this.file, { version: 1, rules: rules.sort((a, b) => a.path.localeCompare(b.path)) });
  }
}
