import { describe, expect, test } from "bun:test";
import { AccountId, planLabel, type Profile } from "../src/domain/account.ts";

const profile = (overrides: Partial<Profile>): Profile => ({
  id: AccountId("a"),
  email: "a@example.com",
  organizationUuid: null,
  organizationName: null,
  organizationType: "claude_max",
  rateLimitTier: null,
  hasClaudeMax: false,
  hasClaudePro: false,
  ...overrides,
});

describe("planLabel", () => {
  test("names known rate limit tiers", () => {
    expect(planLabel(profile({ rateLimitTier: "default_claude_max_20x" }))).toBe("Max 20x");
  });

  test("falls back to the account's plan flags for tiers it does not know", () => {
    expect(planLabel(profile({ rateLimitTier: "default_claude_ai", hasClaudePro: true }))).toBe("Pro");
    expect(planLabel(profile({ rateLimitTier: "default_claude_ai", hasClaudeMax: true }))).toBe("Max");
    expect(planLabel(profile({ rateLimitTier: "default_claude_ai" }))).toBe("Free");
  });

  test("prefixes Team and Enterprise organizations", () => {
    expect(planLabel(profile({ organizationType: "claude_team", rateLimitTier: "default_claude_max_5x" }))).toBe("Team · Max 5x");
  });
});
