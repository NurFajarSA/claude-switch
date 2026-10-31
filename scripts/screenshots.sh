#!/bin/zsh
# Regenerates the README screenshots in docs/images from the demo fixtures in scripts/demo.
# Needs a built app (bun run build:app) and Screen Recording permission for the terminal that runs it.
set -euo pipefail

root=${0:A:h:h}
app="$root/dist/Accounts Manager for Claude.app/Contents/MacOS/AccountsManager"
out="$root/docs/images"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$out"
xcrun swiftc -O -o "$work/window-id" "$root/scripts/demo/window-id.swift"

# A throwaway home keeps your own paths out of the pictures and the demo out of your preferences.
home="$work/home"
mkdir -p "$home/.local/bin" "$home/.config/claude-switch" "$home/Library/LaunchAgents"
cp "$root"/scripts/demo/{cs,*.json} "$home/.local/bin/"
touch "$home/Library/LaunchAgents/app.claude-switch."{daemon,menubar}.plist
export CFFIXED_USER_HOME="$home"

# capture <file> <appearance> [VAR=value ...] [-- app arguments]
capture() {
  local file=$1 appearance=$2; shift 2
  local env_args=() app_args=()
  while (( $# )) && [[ $1 != -- ]]; do env_args+=("$1"); shift; done
  (( $# )) && shift && app_args=("$@")
  env ACCOUNTS_MANAGER_APPEARANCE=$appearance "${env_args[@]}" "$app" "${app_args[@]}" >/dev/null 2>&1 &
  local pid=$! window=""
  for _ in {1..20}; do
    sleep 0.5
    window=$("$work/window-id" "$pid" 2>/dev/null) && break
  done
  sleep 1.5
  if [[ -n $window ]]; then screencapture -x -l "$window" "$out/$file" && echo "$out/$file"; else echo "no window for $file" >&2; fi
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

capture menu-bar.png light ACCOUNTS_MANAGER_PREVIEW_PANEL=1
capture menu-bar-dark.png dark ACCOUNTS_MANAGER_PREVIEW_PANEL=1
capture menu-bar-switch.png light ACCOUNTS_MANAGER_PREVIEW_PANEL=1 ACCOUNTS_MANAGER_SNAPSHOT_OTHERS=1
for pane file in autoSwitch auto-switch rules project-rules profiles desktop-profiles connectors connectors general general; do
  capture "settings-$file.png" light ACCOUNTS_MANAGER_OPEN_SETTINGS=1 -- -settingsPane "$pane"
done
