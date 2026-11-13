#!/usr/bin/env bash
# Removes the Keyform launcher and icon. Your copy of keyform.html is left alone.
set -euo pipefail
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
rm -f "$DATA/applications/keyform.desktop"
rm -f "$DATA/icons/hicolor/scalable/apps/keyform.svg"
for size in 32 48 64 128 256 512; do rm -f "$DATA/icons/hicolor/${size}x${size}/apps/keyform.png"; done
command -v update-desktop-database >/dev/null && update-desktop-database "$DATA/applications" || true
echo "Keyform launcher removed."
