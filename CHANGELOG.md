# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- The menu bar app is now **Accounts Manager for Claude** (`Accounts Manager for Claude.app`, release zip `AccountsManager-<version>-macos-arm64.zip`, Homebrew cask `accounts-manager-for-claude`). `cs install` removes an old `Claude Accounts.app`. The bundle identifier is unchanged, so preferences and notification permission carry over.
- The menu bar panel shows only the CLI account in use. The other accounts sit behind **Switch Account**, sorted by usage left, with a hint naming the best one or how many need a new sign-in.
- Developer environment variables are renamed from `CLAUDE_ACCOUNTS_*` to `ACCOUNTS_MANAGER_*`.

### Added

- `scripts/screenshots.sh` regenerates the README screenshots from anonymised fixtures in `scripts/demo`.

## [1.0.0] - 2026-10-31

First release.

### Added

- Desktop session handoff: move a Claude Desktop conversation to another account with `cs handoff`, from the menu bar, or from an agent. The transcript is shared, so only the session card is copied. `--restart` reopens the target window so the session shows up.
- Live usage: the 5-hour and weekly limits of every Desktop profile and CLI account, in the menu bar and in `cs status` (with `--refresh` and `--json`).
- CLI switching: `cs switch <alias>` and `cs switch --auto` change the Claude Code CLI / VS Code login and keep MCP server tokens, settings and session history.
- Account setup: `cs add`, `cs link`, `cs register`, `cs relogin`, `cs rename`, `cs remove`, plus `cs new-profile`, `cs open` and `cs label` for Desktop profiles.
- MCP server `claude-switch` with `list_accounts`, `handoff_session` and `switch_cli_account`.
- Hooks on `UserPromptSubmit` and `StopFailure` that hand off or switch automatically when the current account reaches the threshold or hits a rate limit.
- Menu bar app "Claude Accounts" with a Control Center style panel, per-account rows, rename and move-session actions, and an "Other Profiles" group.
- Settings window: launch at login, auto-switch and warning levels, polling interval, a page per account and profile, and Claude Desktop update status.
- Claude Desktop update reopen: after an update installs, every profile that was open is reopened; `cs update-desktop` installs a waiting update and reopens them.
- Login expiry warnings: days left on each CLI and Desktop login, with a warning 5 days ahead.
- `cs install` and `cs uninstall` for the binary, LaunchAgent, menu bar app, MCP server and hooks.
- Release packaging: `scripts/package-release.sh` builds a zip of the app and a tarball of `cs`, with optional Developer ID signing and notarization, and a Homebrew cask template.

[Unreleased]: https://github.com/NurFajarSA/claude-switch/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/NurFajarSA/claude-switch/releases/tag/v1.0.0
