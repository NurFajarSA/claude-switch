# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-11-01

### Added

- Profile picker: opening Accounts Manager from the Dock, Finder or Spotlight shows a Chrome-style window with every Claude Desktop profile, its account and usage; one click opens that profile's window. Also under **Choose Profile…** in the menu bar. It stays hidden when the app starts at login (the launch agent passes `--at-login`; run `cs install` again to update it) and can be turned off from its own checkbox.

## [1.0.1] - 2026-11-01

### Added

- The Usage page in Settings lists every account and Desktop profile with a bar per limit (5-hour, weekly), coloured by the warning and switch levels, and when each one resets.
- Homebrew: `brew install --cask nurfajarsa/tap/accounts-manager-for-claude`. `scripts/update-cask.sh` takes the checksum from the published release and copies the cask into a tap checkout.

### Fixed

- `cs install --app` leaves an app that is already in `/Applications` or `~/Applications` in place instead of copying it to `~/Applications`, and Launch at Login finds the app in either folder. Before, a Homebrew install ended up with two copies, and after `brew upgrade` the one opened at login was the old copy.
- The Connectors page in Settings opens at once with the statuses from the last health check and when it ran, instead of a spinner for the whole check (about 7 seconds with 28 servers, up to 90 with slow ones). It checks again in the background only when the last check is more than 10 minutes old. `cs connectors list --json` includes the cached statuses and `checkedAt`.
- `cs share-vm` names profiles as the menu bar does (for example `xplodia`), not by folder (`fajar-x`).

## [1.0.0] - 2026-11-01

First release.

### Added

- Desktop session handoff: move a Claude Desktop conversation to another account with `cs handoff`, from the menu bar, or from an agent. The transcript is shared, so only the session card is copied. `--restart` reopens the target window so the session shows up.
- Live usage: the 5-hour and weekly limits of every Desktop profile and CLI account, in the menu bar and in `cs status` (with `--refresh` and `--json`).
- CLI switching: `cs switch <alias>` and `cs switch --auto` change the Claude Code CLI / VS Code login and keep MCP server tokens, settings and session history.
- Account setup: `cs add`, `cs link`, `cs register`, `cs relogin`, `cs rename`, `cs remove`, plus `cs new-profile`, `cs open` and `cs label` for Desktop profiles.
- MCP server `claude-switch` with `list_accounts`, `handoff_session`, `switch_cli_account` and `allow_account_for_project`.
- Hooks on `UserPromptSubmit` and `StopFailure` that hand off or switch automatically when the current account reaches the threshold or hits a rate limit.
- Menu bar app "Accounts Manager for Claude" with a Control Center style panel, per-account rows, rename and move-session actions, an "Other Profiles" group, and a "Switch Account" group that keeps the CLI accounts not in use out of the way, sorted by usage left.
- Settings window: launch at login, auto-switch and warning levels, polling interval, a page per account and profile, and Claude Desktop update status.
- Claude Desktop update reopen: after an update installs, every profile that was open is reopened; `cs update-desktop` installs a waiting update and reopens them.
- Login expiry warnings: days left on each CLI and Desktop login, with a warning 5 days ahead.
- Project rules: `cs rules` and a Settings page that limit a project folder to chosen accounts. When every allowed account is used up, Claude asks whether to wait, use another account once, or allow it for the project.
- Connectors: `cs connectors` and a Settings page to list MCP servers with their health, import claude.ai connectors as local servers so they work in every account, and sign in to them from the app.
- Housekeeping: Desktop profiles idle for a set time are closed (with **Open Again** in the notification), MCP servers unused for 30 days are offered for removal once a month, and identical Claude Desktop VM files (about 11 GB per profile) are stored once as APFS clones (`cs share-vm`).
- `cs install` and `cs uninstall` for the binary, LaunchAgent, menu bar app, MCP server and hooks. `cs install` clears the quarantine flag on what it installs, so ad-hoc signed releases run.
- `install.sh`: a one-line installer that downloads the latest release, verifies its SHA-256 and runs `cs install`.
- Release packaging: `scripts/package-release.sh` builds a zip of the app and a tarball of `cs`, with optional Developer ID signing and notarization, and a Homebrew cask template.
- `scripts/screenshots.sh` regenerates the README screenshots from anonymised fixtures in `scripts/demo`.

[Unreleased]: https://github.com/NurFajarSA/claude-switch/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/NurFajarSA/claude-switch/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/NurFajarSA/claude-switch/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/NurFajarSA/claude-switch/releases/tag/v1.0.0
