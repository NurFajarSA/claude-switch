# claude-switch

Use several Claude accounts on one Mac without logging out and back in.

- **See every account's usage** in the menu bar: the 5-hour and weekly limits for each Claude Desktop profile and each CLI account.
- **Move a Claude Desktop conversation to another account** and keep the whole transcript. One click in the menu bar, or the agent does it itself when the current account reaches 95%.
- **Switch the Claude Code CLI / VS Code login** automatically when an account runs low. MCP servers, settings and session history stay the same.

> Unofficial. Not affiliated with or endorsed by Anthropic. It relies on how Claude Code and Claude Desktop store data on disk today, which can change in any release. Check the [Anthropic terms](https://www.anthropic.com/legal/consumer-terms) that apply to your accounts before using several of them.

macOS only (Keychain, launchd, SwiftUI).

## How it works

Claude Desktop keeps one signed-in account per profile folder (`~/Library/Application Support/Claude-<name>`, started with `--user-data-dir`). Each Code session there is a small card in `claude-code-sessions/<account>/<org>/local_<id>.json` that points to a transcript in `~/.claude/projects/`. Transcripts are shared by every profile. Moving a session to another account means copying its card into that account's profile, so nothing has to be exported or replayed.

The Claude Code CLI keeps one login in the Keychain item `Claude Code-credentials`. That item also holds the OAuth tokens of your MCP servers. claude-switch replaces only the `claudeAiOauth` part, so MCP connections survive a switch. Logins for the other accounts are parked in separate Keychain items and refreshed in the background.

More detail, including the invariants that keep refresh tokens valid, is in [docs/architecture.md](docs/architecture.md).

## Install

Requirements: macOS 14+, [Bun](https://bun.sh) 1.3+, Xcode command line tools (Swift 5.10+), Claude Code CLI.

```bash
git clone https://github.com/NurFajarSA/claude-switch.git
cd claude-switch
bun install
bun run install:local
```

`install:local` builds the `cs` binary and the menu bar app, then:

| What | Where |
| --- | --- |
| `cs` binary | `~/.local/bin/cs` |
| Background usage poller | LaunchAgent `app.claude-switch.daemon` |
| Menu bar app | `~/Applications/Claude Accounts.app`, opens at login |
| MCP server `claude-switch` | Claude Code user scope (`claude mcp add --scope user`) |
| Hooks on `UserPromptSubmit` and `StopFailure` | `~/.claude/settings.json` (a backup is written next to it first) |

`cs uninstall` removes all of it. Stored logins stay in the Keychain under the service `claude-switch` until you `cs remove` them.

## First run

Claude Desktop profiles are picked up automatically. Usage for a profile comes from the numbers Claude Desktop records while that window is open.

For live numbers on every account, and for CLI switching, log each account in once:

```bash
cs register          # the account the CLI is logged in with now
cs add work          # opens a browser login for another account, keeps the current one
cs add personal
cs status
```

```
Claude Desktop (● window open)
● fajar-x    ████████░░  82%  work@example.com (live, 40s ago)
○ personal   █░░░░░░░░░   9%  me@example.com (live, 40s ago)

Claude Code CLI / VS Code login (● active)
● work       ████████░░  82%  Max 5x         resets in 1h 12m
  personal   █░░░░░░░░░   9%  Max 5x
```

## Using it

**Menu bar.** Click the gauge. Each Desktop profile shows its usage and an action menu (also on right-click): open the window, rename it, or move any recent session into it. Profiles whose account is not registered with `cs add` are folded under "Lainnya". The CLI section switches and renames CLI accounts. Renaming a Desktop profile only changes how claude-switch shows it; the profile folder keeps its name.

**From an agent.** The MCP server gives Claude three tools:

| Tool | Does |
| --- | --- |
| `list_accounts` | Every profile and account with its usage |
| `handoff_session` | Moves the current Desktop conversation to the account with the most headroom, or to a named profile, and opens that window |
| `switch_cli_account` | Changes the CLI / VS Code login |

**Automatically.** With `autoSwitch` on (the default), the hook checks usage before each prompt:

- In Claude Desktop, when the window's account is at or above the threshold, the session is copied to the profile with the most headroom, preferring profiles whose window is closed, and that window opens. The agent answers the current message and tells you to continue there.
- In the CLI or VS Code, the login is switched. Running sessions pick up the new login within about 30 seconds.
- When a request fails on a rate limit (`StopFailure`), the same happens immediately.

**Commands.**

```
cs status [--refresh] [--json]        usage for every profile and account
cs sessions [profile]                 recent Desktop sessions
cs handoff <id> [--to name] [--restart]  move a Desktop session to another profile
cs open <profile>                     open or focus a Desktop window
cs switch <alias> | --auto            change the CLI login
cs add [alias] / cs register [alias]  add accounts
cs label <profile> "<name>" | --clear   display name for a Desktop profile (folder unchanged)
cs rename <alias> <new> / cs remove <alias>
cs config [key] [value]               threshold (95), warnAt (85), pollSeconds (120), autoSwitch (true)
```

## Limits

- A Claude Desktop window reads its session list only when it starts. A session moved into a window that is already open shows up after you quit (Cmd+Q) and reopen it. `cs handoff --restart` and the menu bar app can do that for you. Automatic moves prefer a profile whose window is closed for this reason.
- If the source window is still open, the moved session stays in both sidebars. Keep working in one of them only.
- Connectors you added on claude.ai belong to that account. After a move, the session uses the connectors of the new account. MCP servers added locally (`claude mcp add --scope user`) work the same in every account.
- Usage numbers come from an endpoint Claude Code uses for `/usage`. It is undocumented and may change.

## Development

```bash
bun install
bun run check        # typecheck + tests
bun src/cli.ts status
./macos/build-app.sh
```

Logs: `~/.config/claude-switch/claude-switch.log`.

## License

[MIT](LICENSE)
