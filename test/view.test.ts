import { describe, expect, test } from "bun:test";
import type { Overview, ProfileState } from "../src/desktop/hub.ts";
import type { DesktopProfile, ProfileName } from "../src/desktop/profiles.ts";
import { AccountId } from "../src/domain/account.ts";
import { toOverviewView } from "../src/surfaces/view.ts";

const state = (name: string, accountId: string | null): ProfileState => ({
  profile: {
    name: name as ProfileName,
    label: null,
    dir: `/profiles/Claude-${name}`,
    isDefault: false,
    accountId: accountId ? AccountId(accountId) : null,
    sessionRoots: [],
    usage: null,
  } satisfies DesktopProfile,
  running: false,
  account: null,
  usage: undefined,
  usageSource: "none",
});

describe("toOverviewView", () => {
  test("lists only Desktop profiles that are signed in to an account", () => {
    const overview: Overview = {
      status: { live: null, liveRegistered: false, accounts: [], config: { threshold: 95, warnAt: 85, pollSeconds: 120, autoSwitch: true } },
      profiles: [state("kantor", "acct-kantor"), state("kosong", null)],
    };

    expect(toOverviewView(overview).profiles.map((p) => p.name)).toEqual(["kantor"]);
  });
});
