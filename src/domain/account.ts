export type AccountId = string & { readonly __brand: "AccountId" };
export const AccountId = (raw: string) => raw as AccountId;

export interface OAuthCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
  [extra: string]: unknown;
}

export type AccountHealth =
  | { kind: "ok" }
  | { kind: "needs_login"; reason: string; since: string };

export interface AccountRecord {
  id: AccountId;
  alias: string;
  email: string;
  organizationName: string | null;
  organizationUuid: string | null;
  plan: string;
  addedAt: string;
  oauthAccount: Record<string, unknown> | null;
  health: AccountHealth;
}

export interface Profile {
  id: AccountId;
  email: string;
  organizationUuid: string | null;
  organizationName: string | null;
  organizationType: string | null;
  rateLimitTier: string | null;
}

const TIER_LABELS: Record<string, string> = {
  default_claude_max_20x: "Max 20x",
  default_claude_max_5x: "Max 5x",
  default_claude_pro: "Pro",
};

export function planLabel(profile: Profile): string {
  const tier = profile.rateLimitTier ? TIER_LABELS[profile.rateLimitTier] ?? profile.rateLimitTier : "unknown";
  return profile.organizationType === "claude_team" || profile.organizationType === "claude_enterprise"
    ? `${profile.organizationType === "claude_team" ? "Team" : "Enterprise"} · ${tier}`
    : tier;
}

export function aliasFromEmail(email: string, taken: ReadonlySet<string>): string {
  const base = (email.split("@")[0] ?? "account").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "account";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
