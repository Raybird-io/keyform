#!/usr/bin/env bash
# Installs everything Keyform needs on Linux, in one go:
#   - the app (keyform.html) in a normal folder, plus an app menu launcher and icons
#   - the layer notifier (background service that shows layer notifications)
#   - theme following (Keyform uses your DMS / matugen colours)
#
# Safe to run again at any time: each run first removes what an earlier run installed and
# puts the current version in its place. Your notification settings are kept.
#
# Usage:  ./linux/install.sh                 installs into ~/Keyform
#         ./linux/install.sh ~/somewhere     installs into that folder instead
#         --no-notifier / --no-theme         skip those parts
#
# The app goes in a normal (not hidden) folder on purpose: Snap and Flatpak browsers
# are not allowed to open files inside hidden folders like ~/.local.
set -euo pipefail

NOTIFIER=1; THEME=1; TARGET=""
for a in "$@"; do
  case "$a" in
    --no-notifier) NOTIFIER=0 ;;
    --no-theme) THEME=0 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) TARGET="$a" ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${TARGET:-$HOME/Keyform}"
TARGET="$(mkdir -p "$TARGET" && cd "$TARGET" && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}"
APPS="$DATA/applications"
ICONS="$DATA/icons/hicolor"
say() { printf '  %-11s %s\n' "$1" "$2"; }

# remove the [templates.keyform] block from matugen's config (it is written fresh below)
strip_matugen_block() {
  [ -f "$1" ] || return 0
  python3 - "$1" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
s = re.sub(r'\n*\[templates\.keyform\]\n(?:(?!\[).*\n?)*', '\n', s).strip()
open(p, 'w').write(s + '\n' if s else '')
PY
}

echo "Installing Keyform..."

# ---------------------------------------------------------------- 1. app, launcher, icons
cp "$REPO/keyform.html" "$TARGET/keyform.html"
find "$ICONS" -path '*/apps/keyform.*' -delete 2>/dev/null || true   # old icons, any size
rm -rf "$DATA/keyform"                                                # leftover from older versions
mkdir -p "$APPS" "$ICONS/scalable/apps"
cp "$REPO/icon/keyform.svg" "$ICONS/scalable/apps/keyform.svg"
for size in 32 48 64 128 256 512; do
  mkdir -p "$ICONS/${size}x${size}/apps"
  cp "$REPO/icon/keyform-$size.png" "$ICONS/${size}x${size}/apps/keyform.png"
done

# Open Keyform in its own app window (own icon in the dock) when a Chrome-type browser is
# installed; otherwise open it as a tab in the default browser.
URL="file://$TARGET/keyform.html"
EXEC=""
for b in chromium-browser chromium google-chrome-stable google-chrome brave-browser microsoft-edge; do
  if command -v "$b" >/dev/null; then EXEC="$b --app=$URL --class=Keyform"; break; fi
done
if [ -z "$EXEC" ] && command -v flatpak >/dev/null; then
  for f in org.chromium.Chromium com.google.Chrome com.brave.Browser com.microsoft.Edge; do
    if flatpak info "$f" >/dev/null 2>&1; then EXEC="flatpak run $f --app=$URL --class=Keyform"; break; fi
  done
fi
EXEC="${EXEC:-xdg-open \"$TARGET/keyform.html\"}"
WMCLASS="chrome-_$(printf '%s' "$TARGET/keyform.html" | tr '/' '_')-Default"

cat > "$APPS/keyform.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Keyform
Comment=Keymap editor for ZMK Studio keyboards
Exec=$EXEC
Icon=keyform
StartupWMClass=$WMCLASS
Terminal=false
Categories=Utility;Settings;HardwareSettings;
Keywords=keyboard;keymap;zmk;layers;
DESKTOP
command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$ICONS" || true
say "app" "$TARGET/keyform.html"
say "launcher" "$EXEC"

# ---------------------------------------------------------------- 2. layer notifier
BIN="$HOME/.local/bin/keyform-notify"
UNIT_DIR="$CONF/systemd/user"
if [ "$NOTIFIER" = 1 ]; then
  mkdir -p "$(dirname "$BIN")" "$UNIT_DIR" "$CONF/keyform"
  install -m 755 "$REPO/linux/notifier/keyform-notify.py" "$BIN"
  [ -f "$CONF/keyform/notify.json" ] || cp "$REPO/linux/notifier/notify.example.json" "$CONF/keyform/notify.json"
  # secret key for the link between Keyform and the notifier: made once, readable only by you
  if [ ! -s "$CONF/keyform/token" ]; then
    (umask 077; python3 -c 'import secrets; print(secrets.token_urlsafe(24))' > "$CONF/keyform/token")
  fi
  chmod 600 "$CONF/keyform/token"
  cat > "$UNIT_DIR/keyform-notify.service" <<UNIT
[Unit]
Description=Keyform layer notifications

[Service]
ExecStart=$BIN
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable keyform-notify.service >/dev/null 2>&1
  systemctl --user restart keyform-notify.service       # runs the version just installed
  say "notifier" "running (settings: $CONF/keyform/notify.json)"
  DEV="$("$BIN" --devices 2>/dev/null | head -1)"
  case "$DEV" in /dev/*) say "keyboard" "found at $DEV" ;; *) say "keyboard" "not found now (plug it in by USB; the notifier keeps looking)" ;; esac
else
  systemctl --user disable --now keyform-notify.service >/dev/null 2>&1 || true
  rm -f "$BIN" "$UNIT_DIR/keyform-notify.service" "$CONF/keyform/token"
  say "notifier" "skipped (and removed if it was installed)"
fi

# put the secret key into the installed Keyform (empty = no live link)
TOKEN="$(cat "$CONF/keyform/token" 2>/dev/null || true)"
sed -i "s|<meta name=\"keyform-token\" content=\"[^\"]*\">|<meta name=\"keyform-token\" content=\"$TOKEN\">|" "$TARGET/keyform.html"

# ---------------------------------------------------------------- 3. theme following
# matugen writes keyform-theme.css when your theme changes, then runs keyform-apply-theme,
# which copies the colours into keyform.html itself (works in Flatpak browsers too).
MATUGEN="$CONF/matugen"
APPLY="$HOME/.local/bin/keyform-apply-theme"
strip_matugen_block "$MATUGEN/config.toml"
if [ "$THEME" = 1 ]; then
  mkdir -p "$MATUGEN/templates" "$(dirname "$APPLY")"
  cp "$REPO/linux/theme/keyform-theme.css" "$MATUGEN/templates/keyform-theme.css"
  install -m 755 "$REPO/linux/theme/keyform-apply-theme.py" "$APPLY"
  touch "$MATUGEN/config.toml"
  if ! grep -q '^\[config\]' "$MATUGEN/config.toml"; then   # matugen needs this section
    { printf '[config]\n\n'; cat "$MATUGEN/config.toml"; } > "$MATUGEN/config.toml.new" && mv "$MATUGEN/config.toml.new" "$MATUGEN/config.toml"
  fi
  [ -n "$(tail -c1 "$MATUGEN/config.toml")" ] && echo >> "$MATUGEN/config.toml"
  echo >> "$MATUGEN/config.toml"
  cat >> "$MATUGEN/config.toml" <<TOML
[templates.keyform]
input_path = '$MATUGEN/templates/keyform-theme.css'
output_path = '$TARGET/keyform-theme.css'
post_hook = '$APPLY "$TARGET"'
TOML
  if [ -f "$TARGET/keyform-theme.css" ]; then
    "$APPLY" "$TARGET" >/dev/null
    say "theme" "following your desktop colours (current theme applied)"
  else
    say "theme" "ready: change your wallpaper or theme in DMS once to apply it"
  fi
else
  rm -f "$MATUGEN/templates/keyform-theme.css" "$TARGET/keyform-theme.css" "$APPLY"
  say "theme" "skipped (built-in colours)"
fi

echo "Done. Open Keyform from your app menu. Run this again any time to update."
