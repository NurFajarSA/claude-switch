# Security

claude-switch handles OAuth tokens for your Claude accounts. This page says where they go and how to report a problem.

## What it stores and where

| Data | Location | Notes |
| --- | --- | --- |
| Login of the account the CLI uses | Keychain item `Claude Code-credentials` (owned by Claude Code) | claude-switch replaces only its `claudeAiOauth` and `organizationUuid` keys during a switch. |
| Logins of the other CLI accounts | Keychain items under the service `claude-switch`, one per account id | Refreshed in the background; removed by `cs remove`. |
| Account list, usage readings, profile labels, config | `~/.config/claude-switch/` (files are `0600`) | No tokens. Account emails and ids are stored. |
| Log | `~/.config/claude-switch/claude-switch.log` | Events and errors, never token values. |

Network calls go only to `api.anthropic.com` (profile and usage) and `platform.claude.com` (token refresh), the same hosts Claude Code uses. There is no telemetry.

Writing the Claude Code credential item passes it to `/usr/bin/security`. Short values go through stdin; values over about 4 KB go on the command line, as Claude Code itself does, where another process of the same user could briefly read them.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability). Include the version (`cs --version`), macOS version, and steps to reproduce. You should get a reply within a week.
