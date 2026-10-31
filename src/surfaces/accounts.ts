import { UserError } from "../core/engine.ts";
import type { Overview } from "../desktop/hub.ts";
import { displayName } from "../desktop/profiles.ts";
import type { AccountId } from "../domain/account.ts";

export interface AccountEntry {
  id: AccountId;
  names: string[];
  email: string | null;
  folders: string[];
}

export function accountDirectory(overview: Overview): AccountEntry[] {
  const entries = new Map<AccountId, AccountEntry>();
  const entry = (id: AccountId) => {
    const existing = entries.get(id) ?? { id, names: [], email: null, folders: [] };
    entries.set(id, existing);
    return existing;
  };
  for (const account of overview.status.accounts) {
    const e = entry(account.record.id);
    e.names.push(account.record.alias);
    e.email = account.record.email;
  }
  for (const p of overview.profiles) {
    if (!p.profile.accountId) continue;
    const e = entry(p.profile.accountId);
    const name = displayName(p.profile);
    if (!e.names.includes(`${name} (Desktop)`)) e.names.push(`${name} (Desktop)`);
    e.folders.push(p.profile.name.toLowerCase());
  }
  return [...entries.values()];
}

export function resolveAccount(directory: readonly AccountEntry[], query: string): AccountEntry {
  const q = query.trim().toLowerCase();
  const match =
    directory.find((e) => e.id === query) ??
    directory.find((e) => e.email?.toLowerCase() === q) ??
    directory.find((e) => e.names.some((n) => n.toLowerCase() === q || n.toLowerCase() === `${q} (desktop)`)) ??
    directory.find((e) => e.folders.includes(q));
  if (!match) throw new UserError(`Unknown account "${query}". Known: ${directory.map((e) => e.names[0] ?? e.id).join(", ")}.`);
  return match;
}

export function namesOf(directory: readonly AccountEntry[], ids: readonly AccountId[]): string {
  return ids.map((id) => directory.find((e) => e.id === id)?.names[0] ?? id.slice(0, 8)).join(", ");
}
