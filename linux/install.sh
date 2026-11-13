#!/usr/bin/env bash
# Adds Keyform to your Linux app menu.
# Usage:  ./linux/install.sh            (installs into ~/Keyform)
#         ./linux/install.sh ~/somewhere (installs into that folder instead)
#
# The app goes in a normal (not hidden) folder on purpose: Snap and Flatpak
# browsers are not allowed to open files inside hidden folders like ~/.local.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-$HOME/Keyform}"
TARGET="$(mkdir -p "$TARGET" && cd "$TARGET" && pwd)"

APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"

cp "$REPO/keyform.html" "$TARGET/keyform.html"
mkdir -p "$APPS" "$ICONS/scalable/apps"
cp "$REPO/icon/keyform.svg" "$ICONS/scalable/apps/keyform.svg"
for size in 32 48 64 128 256 512; do
  mkdir -p "$ICONS/${size}x${size}/apps"
  cp "$REPO/icon/keyform-$size.png" "$ICONS/${size}x${size}/apps/keyform.png"
done

cat > "$APPS/keyform.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Keyform
Comment=Keymap editor for ZMK Studio keyboards
Exec=xdg-open "$TARGET/keyform.html"
Icon=keyform
Terminal=false
Categories=Utility;Settings;HardwareSettings;
Keywords=keyboard;keymap;zmk;layers;
DESKTOP

command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$ICONS" || true

echo "Keyform installed:"
echo "  app:      $TARGET/keyform.html"
echo "  launcher: $APPS/keyform.desktop"
echo "Search for 'Keyform' in your app menu. If it doesn't show yet, log out and back in."
