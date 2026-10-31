#!/bin/zsh
set -euo pipefail

here=${0:A:h}
out=${1:-$here/../dist}
app="$out/Claude Accounts.app"

sdk=$(xcrun --sdk macosx --show-sdk-version)
link_sdk=(-Xlinker -platform_version -Xlinker macos -Xlinker 15.0 -Xlinker "$sdk")
swift build --package-path "$here" -c release "${link_sdk[@]}"
bin="$(swift build --package-path "$here" -c release "${link_sdk[@]}" --show-bin-path)/ClaudeAccounts"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$bin" "$app/Contents/MacOS/ClaudeAccounts"
mkdir -p "$app/Contents/Resources"
cp "$here/icon/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"
if [[ -x "$out/cs" ]]; then
  mkdir -p "$app/Contents/Resources"
  cp "$out/cs" "$app/Contents/Resources/cs"
fi
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Claude Accounts</string>
  <key>CFBundleDisplayName</key><string>Claude Accounts</string>
  <key>CFBundleIdentifier</key><string>app.claude-switch.menubar</string>
  <key>CFBundleExecutable</key><string>ClaudeAccounts</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
codesign --force --sign - "$app" >/dev/null
echo "$app"
