#!/bin/zsh
set -euo pipefail
here=${0:A:h}
work=$(mktemp -d)
swift "$here/make-icon.swift" "$work/icon-1024.png"
iconset="$work/AppIcon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z $size $size "$work/icon-1024.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$work/icon-1024.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$here/AppIcon.icns"
cp "$work/icon-1024.png" "$here/AppIcon-1024.png"
rm -rf "$work"
echo "$here/AppIcon.icns"
