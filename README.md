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

Requirements: macOS 15+ on Apple silicon, Claude Code CLI.

### From a release

Download `ClaudeAccounts-<version>-macos-arm64.zip` from [Releases](https://github.com/NurFajarSA/claude-switch/releases), unzip it and move `Claude Accounts.app` to `~/Applications`. The app bundles the `cs` CLI at `Contents/Resources/cs`. A standalone `cs-<version>-macos-arm64.tar.gz` is there too, and each file has a `.sha256` next to it.

Or with Homebrew:

```bash
brew install --cask nurfajarsa/tap/claude-accounts
```

The cask lives in a separate tap repository, `NurFajarSA/homebrew-tap`, which has to exist before this works. Copy `packaging/homebrew/claude-accounts.rb` to `Casks/claude-accounts.rb` there; `scripts/update-cask.sh <version>` fills in the version and checksum after a release is packaged. The cask also links `cs` into your `PATH`.

Builds without a Developer ID signature are only ad-hoc signed. The first time, right-click the app and choose Open (then Open again in the dialog), or run `xattr -dr com.apple.quarantine "/Applications/Claude Accounts.app"`. Releases built with a Developer ID certificate are notarized and open normally.

Then run `cs install` to set up the poller, MCP server and hooks described below. It installs the app too, so pass the one you downloaded: `"/Applications/Claude Accounts.app/Contents/Resources/cs" install --app "/Applications/Claude Accounts.app"` (after a Homebrew install, `cs install --app "/Applications/Claude Accounts.app"`).

### From source

Requirements: [Bun](https://bun.sh) 1.3+, Xcode command line tools (Swift 5.10+).

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

Add each account once. One command sets it up for both Claude Desktop and the CLI:

```bash
cs register          # the account the CLI is logged in with now
cs add work          # new Desktop profile "work" opens; sign in there, then approve the CLI login in the browser
cs add personal
cs status
```

`cs add` creates the Desktop profile and waits for you to sign in to it, then runs the CLI login and checks that both use the same account. The CLI keeps using the account it had before. The browser step signs in with whatever claude.ai account the browser uses, so open the printed link in a private window when it is on a different account.

Already have a Desktop profile for an account? `cs link <profile>` adds only the CLI side. The menu bar has the same actions: "Add Account…" and, on a profile under "Other Profiles", "Set Up for CLI…".

### Logins expire

Measured on Claude Code 2.1: a CLI login lasts about 28 days from sign-in, and refreshing it does not extend that. Desktop profile logins also last about 28 days, and appear to be extended each time the profile is opened. claude-switch shows the days left and warns 5 days ahead; renew a CLI login with `cs relogin <alias>` (or "Sign In Again…" in the menu bar), and open a Desktop profile now and then to keep it signed in.

## Using it

**Menu bar.** Click the gauge for a Control Center style panel. Each Desktop profile and CLI account is a row with its usage. Click a Desktop row to open or show that window; click a CLI row to use that account. Right-click a row to rename it or move a recent session into it. Profiles whose account is not registered with `cs add` sit under "Other Profiles". Renaming a Desktop profile only changes how claude-switch shows it; the profile folder keeps its name.

**Connectors.** Settings › Connectors lists the MCP servers on this Mac, which every account uses and which stay signed in across switches, and the claude.ai connectors each of your accounts has. Connectors with a public URL (Figma, GitHub, Notion, Google, Linear and most others) can be added to this Mac with one click, or all at once; sign in to each once with `/mcp`. Anthropic-hosted ones (Claude Docs, visualize) only work inside claude.ai, and so do connectors whose sign-in accepts only claude.ai (seen with GitHub, Slack, Asana, Box and HubSpot): import adds each server, checks it, and removes it again with a note when its sign-in rejects other apps, so the claude.ai copy keeps working. Claude Code hides a claude.ai or plugin copy of a server that has the same URL as one on this Mac (seen in `claude mcp list` on Claude Code 2.1), so tools are not listed twice. From the terminal: `cs connectors [--check]`, `cs connectors import --all`, `cs connectors add <name> <url>`, `cs connectors remove <name>`.

**First run and notifications.** The first time the app opens without the background service or any account, a setup assistant installs everything with one click and walks through adding the first account ("Show Setup Assistant…" reopens it). The app posts a macOS notification when the CLI account switches, when an account crosses the warning level, and when a sign-in has three days or less left; turn them off in Settings › General.

**Settings.** "Settings…" in the menu bar opens a System Settings style window: launch at login, auto-switch on or off with adjustable switch and warning levels (`cs config threshold 90` does the same), how often usage is checked, every CLI account and Desktop profile with its own page (usage, sign-in expiry, rename, sign in again, move a session), and Claude Desktop update status.

To check the panel without opening it, render it to a PNG: `CLAUDE_ACCOUNTS_SNAPSHOT=/tmp/panel.png "dist/Claude Accounts.app/Contents/MacOS/ClaudeAccounts"` (add `CLAUDE_ACCOUNTS_SNAPSHOT_DARK=1` for dark mode). `CLAUDE_ACCOUNTS_OPEN_SETTINGS=1` and `CLAUDE_ACCOUNTS_OPEN_ONBOARDING=1` open those windows at launch.

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
cs doctor [--json]                  check that the Keychain, Anthropic endpoints, Claude Desktop and the install still match what claude-switch expects
cs sessions [profile]                 recent Desktop sessions
cs handoff <id> [--to name] [--restart]  move a Desktop session to another profile
cs open <profile>                     open or focus a Desktop window
cs new-profile <name>                 create a Desktop profile and open it to sign in
cs update-desktop                     install a downloaded Claude Desktop update, then reopen every open profile
cs switch <alias> | --auto            change the CLI login
cs add <name> / cs link <profile>     add an account to Desktop and the CLI / link the CLI to a Desktop profile
cs relogin <alias>                    renew a CLI login before it expires
cs register [alias]                   register the account the CLI uses now
cs label <profile> "<name>" | --clear   display name for a Desktop profile (folder unchanged)
cs rename <alias> <new> / cs remove <alias>
cs config [key] [value]               threshold (95), warnAt (85), pollSeconds (120), autoSwitch (true)
```

## Claude Desktop updates

Claude Desktop installs an update only after every window has quit, and then reopens only the default profile. The background poller watches for that: when the installed version changes, it reopens every profile that was open in the 15 minutes before. When an update is downloaded and waiting, the menu bar shows it; installing from there (or `cs update-desktop`) quits every open profile, waits for the new version and reopens them.

## Limits

- A Claude Desktop window reads its session list only when it starts. A session moved into a window that is already open shows up after you quit (Cmd+Q) and reopen it. `cs handoff --restart` and the menu bar app can do that for you. Automatic moves prefer a profile whose window is closed for this reason.
- If the source window is still open, the moved session stays in both sidebars. Keep working in one of them only.
- Connectors you added on claude.ai belong to that account. After a move, the session uses the connectors of the new account. MCP servers added locally (`claude mcp add --scope user`) work the same in every account.
- Usage numbers come from an endpoint Claude Code uses for `/usage`. It is undocumented and may change. Run `cs doctor` after a Claude Code or Claude Desktop update. It prints one line per check and exits 1 when something is broken.

## Development

```bash
bun install
bun run check        # typecheck + tests
CI_NO_KEYCHAIN=1 bun test   # skip test/keychain-e2e.test.ts, which uses throwaway items in the real macOS Keychain
bun src/cli.ts status
./macos/build-app.sh
```

### Releasing

The version lives in `package.json` and feeds `cs --version`, the MCP server and the app's `Info.plist`. To release, bump it, move the `CHANGELOG.md` entries under the new version, and push a tag `v<version>`. The `Release` workflow tests, runs `scripts/package-release.sh` and publishes the zip and tarball with their checksums. Run the script locally to get the same files in `dist/release/`.

Signing is optional. Set `DEVELOPER_ID_APP` to a codesign identity to sign with the hardened runtime. Add `NOTARY_PROFILE` (a `notarytool` keychain profile) or `APPLE_ID`, `APPLE_TEAM_ID` and `APPLE_APP_PASSWORD` to notarize and staple. In CI, set the secrets `MACOS_CERT_P12_BASE64` and `MACOS_CERT_PASSWORD` for signing and the three `APPLE_*` secrets for notarization; without them the release is ad-hoc signed.

Logs: `~/.config/claude-switch/claude-switch.log`.

## License

[MIT](LICENSE)
