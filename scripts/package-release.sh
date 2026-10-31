#!/bin/zsh
# Build cs and the menu bar app, then package release artifacts in dist/release.
# Optional signing: DEVELOPER_ID_APP="Developer ID Application: Name (TEAMID)"
# Optional notarization: NOTARY_PROFILE=<notarytool keychain profile>
#   or APPLE_ID + APPLE_TEAM_ID + APPLE_APP_PASSWORD
set -euo pipefail

root=${0:A:h:h}
cd "$root"

version=$(bun -e 'console.log(JSON.parse(await Bun.file("package.json").text()).version)')
[[ -n "$version" ]] || { echo "could not read version from package.json" >&2; exit 1; }
arch=arm64
dist="$root/dist"
rel="$dist/release"
app="$dist/Accounts Manager for Claude.app"
zip="$rel/AccountsManager-$version-macos-$arch.zip"
tgz="$rel/cs-$version-macos-$arch.tar.gz"

notary_args=()
if [[ -n "${NOTARY_PROFILE:-}" ]]; then
  notary_args=(--keychain-profile "$NOTARY_PROFILE")
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_TEAM_ID:-}" && -n "${APPLE_APP_PASSWORD:-}" ]]; then
  notary_args=(--apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD")
fi

if [[ -n "${DEVELOPER_ID_APP:-}" ]]; then
  echo "Signing with: $DEVELOPER_ID_APP"
else
  echo "NOTICE: DEVELOPER_ID_APP is not set. Artifacts stay ad-hoc signed; install with install.sh or clear the quarantine flag." >&2
  if (( ${#notary_args[@]} )); then
    echo "NOTICE: notarization needs a Developer ID signature, so it is skipped." >&2
    notary_args=()
  fi
fi

sign() {
  codesign --force --options runtime --timestamp --sign "$DEVELOPER_ID_APP" "$@"
}

echo "Packaging claude-switch $version ($arch)"
bun run build

if [[ -n "${DEVELOPER_ID_APP:-}" ]]; then
  sign --identifier app.claude-switch.cli "$dist/cs"
fi

"$root/macos/build-app.sh" "$dist" >/dev/null

if [[ -n "${DEVELOPER_ID_APP:-}" ]]; then
  # Inside-out: the nested cs first, then the bundle.
  sign --identifier app.claude-switch.cli "$app/Contents/Resources/cs"
  sign --deep "$app"
  codesign --verify --deep --strict "$app"
fi

rm -rf "$rel"
mkdir -p "$rel"
ditto -c -k --norsrc --keepParent "$app" "$zip"

if (( ${#notary_args[@]} )); then
  echo "Submitting to the Apple notary service (this can take several minutes)"
  xcrun notarytool submit "$zip" "${notary_args[@]}" --wait
  xcrun stapler staple "$app"
  rm -f "$zip"
  ditto -c -k --norsrc --keepParent "$app" "$zip"
elif [[ -n "${DEVELOPER_ID_APP:-}" ]]; then
  echo "NOTICE: signed but not notarized (set NOTARY_PROFILE or APPLE_ID/APPLE_TEAM_ID/APPLE_APP_PASSWORD)." >&2
fi

tar -C "$dist" -czf "$tgz" cs

for f in "$zip" "$tgz"; do
  (cd "$rel" && shasum -a 256 "${f:t}" > "${f:t}.sha256")
done

echo
echo "Artifacts in $rel:"
ls -1 "$rel"
