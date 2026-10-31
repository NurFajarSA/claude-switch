#!/bin/sh
# Installs Accounts Manager for Claude and the cs CLI from the latest GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/NurFajarSA/claude-switch/main/install.sh | sh
#
# Environment:
#   ACCOUNTS_MANAGER_VERSION   install this version (for example 1.0.0) instead of the latest
#   ACCOUNTS_MANAGER_BASE_URL  download from here instead of GitHub (a mirror, or file:// for testing)
#
# The release is checked against its published SHA-256, then `cs install` sets up the app,
# the background poller, the MCP server and the Claude Code hooks.
set -eu

repo="NurFajarSA/claude-switch"
app_name="Accounts Manager for Claude.app"

say() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail "Accounts Manager for Claude runs on macOS only."
[ "$(uname -m)" = arm64 ] || fail "Releases are built for Apple silicon (arm64). Build from source on Intel Macs."
major=$(sw_vers -productVersion | cut -d. -f1)
[ "$major" -ge 15 ] || fail "macOS 15 or later is required (this Mac runs $(sw_vers -productVersion))."

version=${ACCOUNTS_MANAGER_VERSION:-}
if [ -z "$version" ]; then
  latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest") \
    || fail "could not reach GitHub to find the latest release."
  version=${latest##*/v}
  case $version in
    ''|*/*) fail "no published release found at https://github.com/$repo/releases" ;;
  esac
fi
version=${version#v}

base=${ACCOUNTS_MANAGER_BASE_URL:-https://github.com/$repo/releases/download/v$version}
zip="AccountsManager-$version-macos-arm64.zip"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

say "Downloading Accounts Manager for Claude $version"
curl -fL --progress-bar -o "$work/$zip" "$base/$zip" || fail "download failed: $base/$zip"
curl -fsSL -o "$work/$zip.sha256" "$base/$zip.sha256" || fail "checksum download failed: $base/$zip.sha256"

expected=$(cut -d' ' -f1 < "$work/$zip.sha256")
actual=$(shasum -a 256 "$work/$zip" | cut -d' ' -f1)
[ -n "$expected" ] && [ "$expected" = "$actual" ] || fail "checksum mismatch for $zip (expected $expected, got $actual)."
say "Checksum verified"

ditto -x -k "$work/$zip" "$work"
[ -x "$work/$app_name/Contents/Resources/cs" ] || fail "the release does not contain $app_name with the cs command."

"$work/$app_name/Contents/Resources/cs" install --app "$work/$app_name"

say ""
say "Done. Accounts Manager for Claude is in your menu bar, and cs is in ~/.local/bin."
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) say "Add ~/.local/bin to your PATH to use cs in a terminal:  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zprofile" ;;
esac
say "Next: run 'cs add <name>' to add your first account, or open the setup assistant from the menu bar."
