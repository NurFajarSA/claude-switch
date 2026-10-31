# Architecture

claude-switch is one Bun binary (`cs`) with several entry points, plus a SwiftUI menu bar app that shells out to it.

```
src/
  domain/      pure types and decisions (accounts, usage windows, which account to pick)
  infra/       Keychain, Anthropic OAuth API, atomic JSON files, lock, log, paths
  core/        Engine: CLI accounts (register, park, switch, poll, reconcile)
  desktop/     Claude Desktop profiles, session cards, handoff, window control
  surfaces/    CLI views, MCP server, hook, daemon, installer
  cli.ts       command table
macos/         menu bar app (reads `cs status --json`, runs `cs` commands)
```

## CLI accounts

### Where the login lives

Claude Code stores its login in the macOS Keychain, generic password, service `Claude Code-credentials` (with a `-<sha256(configDir)[:8]>` suffix when `CLAUDE_CONFIG_DIR` is set), account `$USER`. The value is JSON:

```
{ "claudeAiOauth": { accessToken, refreshToken, expiresAt, scopes, ... },
  "organizationUuid": "...",
  "mcpOAuth": { "<server>|<hash>": { accessToken, refreshToken, ... }, ... } }
```

`mcpOAuth` holds the tokens of every remote MCP server. Swapping the whole item would disconnect them, so `LiveCredentials.install` replaces only `claudeAiOauth` and `organizationUuid` and keeps every other key.

Claude Code caches the item for 30 seconds and rereads it, which is why a switch reaches running sessions without a restart.

### One owner per refresh token

Refresh tokens rotate: each refresh returns a new one and invalidates the old. If two parties refresh the same account, one of them ends up logged out. The engine therefore keeps one owner per account at all times:

- The account Claude Code is logged in with is **live**. Only Claude Code refreshes it. claude-switch reads its access token for usage but never refreshes it.
- Every other account is **parked** in the Keychain service `claude-switch`, account `<accountUuid>`. Only claude-switch refreshes it, and it writes the rotated token back before using it.

The live account is identified from the token itself (`/api/oauth/profile`), not from claude-switch's own state, so a login made outside claude-switch is detected.

`Engine.reconcile` restores the invariant after a crash at any point of a switch: if the live account also has a parked copy, the parked copy is deleted (the live one is newer). The one exception is the window of `cs add`, where the current account is deliberately parked before the browser login replaces it; `login-pending.json` marks that window for 15 minutes.

### Switching

Under the state lock (`~/.config/claude-switch/lock`, a directory with a PID file, stale when the PID is gone):

1. Read the live item and identify its account.
2. Load the target's parked credential and refresh it if it expires within 5 minutes.
3. Park the live credential under its account.
4. Write the target credential into the live item, after rereading it and checking the refresh token did not change (Claude Code may have refreshed in between). On a change, the whole switch runs once more.
5. Delete the target's parked copy and set `oauthAccount` in `~/.claude.json` to the target's profile.

### Usage

`GET https://api.anthropic.com/api/oauth/usage` with `anthropic-beta: oauth-2025-04-20` returns a `limits` array (`session`, `weekly`, model-scoped weekly limits) with a percentage and reset time. The account's blocking percentage is the highest unscoped limit. Readings older than 15 minutes count as unknown when choosing an account. Each account's reading is its own file in `~/.config/claude-switch/usage/`, so pollers never write the same file.

## Claude Desktop

Each profile is a folder under `~/Library/Application Support/` named `Claude` or `Claude-<name>`, started with `--user-data-dir`. `config.json` holds `lastKnownAccountUuid`. `plan-usage-history.json` holds usage samples (`fh` 5-hour, `sd` 7-day) that Desktop records while the window is open.

A Code session is a card at `claude-code-sessions/<accountUuid>/<orgUuid>/local_<uuid>.json`. `cliSessionId` names the transcript in `~/.claude/projects/<cwd-slug>/<cliSessionId>.jsonl`, which every profile shares.

`handoffSession` copies a fixed list of fields (`CARRIED_FIELDS`) into a new card in the target profile and clears `enabledMcpTools` and `remoteMcpServersConfig`, which describe the source account's claude.ai connectors. Moving a session back to a profile that already has a card for the same transcript reuses that card. The source card is archived only when its window is closed, because a running Desktop may rewrite cards from memory.

A running Desktop window does not rescan `claude-code-sessions/`; a card written while it runs appears after the window restarts (observed on Claude Desktop with Claude Code 2.1.309). `DesktopHub.decide` therefore tries closed profiles first and falls back to open ones only when every closed profile is at its limit. For an open target, `handoff` reports `needs_reopen` unless the caller passes `restart`, which sends SIGTERM to that profile's main process, waits for it to exit and launches it again.

The hook and the MCP server know which Desktop session they run in from `CLAUDE_CODE_HOST_SESSION_ID` and `CLAUDE_CODE_ACCOUNT_UUID`, which Desktop sets for its Claude Code processes.

## Project rules

`~/.config/claude-switch/rules.json` maps folders to account ids. `ruleFor` picks the deepest rule whose folder contains the session folder (the hook's `cwd`, or the MCP server's working directory, which Claude Code sets to the project). `decideSwitch` takes the allowed set: an active account outside it must move even with usage left, candidates outside it are never chosen, and the best outside candidate is returned with `exhausted` so the hook can offer it as a one-off. Desktop profiles and CLI accounts share account ids, so one rule covers both.
