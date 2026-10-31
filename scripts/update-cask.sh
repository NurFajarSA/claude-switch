#!/bin/zsh
# Fill packaging/homebrew/accounts-manager-for-claude.rb with a version and the SHA-256 of its release zip.
# Usage: scripts/update-cask.sh <version> [tap-checkout]
# The checksum comes from the published GitHub release, which CI built, not from a local build.
# With a tap checkout, the filled cask is also copied to <tap-checkout>/Casks/.
set -euo pipefail

root=${0:A:h:h}
version=${1:?usage: scripts/update-cask.sh <version> [tap-checkout]}
version=${version#v}
tap=${2:-}
zip="AccountsManager-$version-macos-arm64.zip"
url="https://github.com/NurFajarSA/claude-switch/releases/download/v$version/$zip.sha256"
cask="$root/packaging/homebrew/accounts-manager-for-claude.rb"

sha=$(curl -fsSL "$url" | awk '{print $1}') || { echo "could not fetch $url; is v$version published?" >&2; exit 1; }
[[ $sha =~ ^[0-9a-f]{64}$ ]] || { echo "unexpected checksum from $url: $sha" >&2; exit 1; }

sed -i '' -E \
  -e "s/^( *version )\".*\"/\\1\"$version\"/" \
  -e "s/^( *sha256 )\".*\"/\\1\"$sha\"/" \
  "$cask"
echo "Updated $cask: version $version, sha256 $sha"

if [[ -n $tap ]]; then
  mkdir -p "$tap/Casks"
  awk '/^cask /{found = 1} found' "$cask" > "$tap/Casks/${cask:t}"
  echo "Copied to $tap/Casks/${cask:t}"
fi
