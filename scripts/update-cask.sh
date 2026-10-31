#!/bin/zsh
# Fill packaging/homebrew/claude-accounts.rb with a version and the SHA-256 of its release zip.
# Usage: scripts/update-cask.sh <version>   (needs dist/release/ClaudeAccounts-<version>-macos-arm64.zip)
set -euo pipefail

root=${0:A:h:h}
version=${1:?usage: scripts/update-cask.sh <version>}
version=${version#v}
zip="$root/dist/release/ClaudeAccounts-$version-macos-arm64.zip"
cask="$root/packaging/homebrew/claude-accounts.rb"

[[ -f "$zip" ]] || { echo "missing $zip; run scripts/package-release.sh first" >&2; exit 1; }
sha=$(shasum -a 256 "$zip" | awk '{print $1}')

sed -i '' -E \
  -e "s/^( *version )\".*\"/\\1\"$version\"/" \
  -e "s/^( *sha256 )\".*\"/\\1\"$sha\"/" \
  "$cask"
echo "Updated $cask: version $version, sha256 $sha"
