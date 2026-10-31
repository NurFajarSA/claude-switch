import type { AccountId } from "./account.ts";

export interface ProjectRule {
  path: string;
  accounts: AccountId[];
}

export function normalizeFolder(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export function ruleFor(rules: readonly ProjectRule[], cwd: string | null | undefined): ProjectRule | null {
  if (!cwd) return null;
  const folder = normalizeFolder(cwd);
  let best: ProjectRule | null = null;
  for (const rule of rules) {
    const root = normalizeFolder(rule.path);
    const inside = folder === root || folder.startsWith(`${root}/`);
    if (inside && (!best || root.length > normalizeFolder(best.path).length)) best = rule;
  }
  return best;
}

export function allowedSet(rule: ProjectRule | null): ReadonlySet<AccountId> | undefined {
  return rule ? new Set(rule.accounts) : undefined;
}
