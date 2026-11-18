#!/usr/bin/env bash
# Removes everything ./linux/install.sh set up: app copy, launcher, icons, notifier, theme template.
# Your notification settings in ~/.config/keyform are kept, unless you add --all.
# Usage:  ./linux/uninstall.sh [--all] [folder]     (folder only if you installed somewhere else)
set -euo pipefail
ALL=0; TARGET=""
for a in "$@"; do case "$a" in --all) ALL=1 ;; *) TARGET="$a" ;; esac; done
TARGET="${TARGET:-$HOME/Keyform}"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}"

systemctl --user disable --now keyform-notify.service >/dev/null 2>&1 || true
rm -f "$CONF/systemd/user/keyform-notify.service" "$HOME/.local/bin/keyform-notify"
systemctl --user daemon-reload 2>/dev/null || true

if [ -f "$CONF/matugen/config.toml" ]; then
  python3 - "$CONF/matugen/config.toml" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
s = re.sub(r'\n*\[templates\.keyform\]\n(?:(?!\[).*\n?)*', '\n', s).strip()
open(p, 'w').write(s + '\n' if s else '')
PY
fi
rm -f "$CONF/matugen/templates/keyform-theme.css" "$HOME/.local/bin/keyform-apply-theme"

rm -f "$DATA/applications/keyform.desktop"
find "$DATA/icons/hicolor" -path '*/apps/keyform.*' -delete 2>/dev/null || true
rm -rf "$DATA/keyform"
rm -f "$TARGET/keyform.html" "$TARGET/keyform-theme.css"
rmdir "$TARGET" 2>/dev/null || true
command -v update-desktop-database >/dev/null && update-desktop-database "$DATA/applications" || true
rm -f "${XDG_RUNTIME_DIR:-/tmp}/keyform-layer"
if [ "$ALL" = 1 ]; then
  rm -rf "$CONF/keyform"
  echo "Keyform removed completely, settings included."
else
  echo "Keyform removed. Your notification settings are still in $CONF/keyform (use --all to remove them too)."
fi
