#!/usr/bin/env bash
# Install Marauder Console as a desktop app for the current user: build the release binary, install a
# launcher and a themed icon, and (on KDE Plasma) pin it to the task manager.
#
# User-local, no sudo. Re-runnable. Prereqs: the Tauri toolchain (scripts/setup-tauri-toolchain.sh) and
# the Python venv (install.sh). The installed launcher runs the bridge from this repo's ./venv, so keep
# the repo in place — if you move it, re-run this script.
#
#   bash scripts/install-desktop.sh
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
ok()   { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m!!  %s\033[0m\n' "$*"; }

# Make cargo available if it was installed user-local by the toolchain script.
command -v cargo >/dev/null 2>&1 || . "$HOME/.cargo/env" 2>/dev/null || true

ok "1/4  Build frontend + release binary"
npm --prefix "$REPO/frontend" run build
cargo build --release --manifest-path "$REPO/src-tauri/Cargo.toml"
BIN="$REPO/src-tauri/target/release/marauder-console"
[ -x "$BIN" ] || { warn "binary not found at $BIN — did the build fail?"; exit 1; }

ok "2/4  Install themed icon (named 'marauder-console' under hicolor)"
SVG="$REPO/src-tauri/icons/icon.svg"
HC="$HOME/.local/share/icons/hicolor"
install -Dm644 "$SVG" "$HC/scalable/apps/marauder-console.svg"
if command -v rsvg-convert >/dev/null 2>&1; then
  for s in 48 64 128 256; do
    rsvg-convert -w "$s" -h "$s" "$SVG" -o "$HC/${s}x${s}/apps/marauder-console.png" 2>/dev/null || true
  done
fi

ok "3/4  Install launcher"
APPS="$HOME/.local/share/applications"
mkdir -p "$APPS"
DEST="$APPS/marauder-console.desktop"
sed "s#@EXEC@#${BIN}#" "$REPO/packaging/marauder-console.desktop.in" > "$DEST"
chmod +x "$DEST"
command -v desktop-file-validate >/dev/null 2>&1 && desktop-file-validate "$DEST" || true
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" 2>/dev/null || true
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  [ -f "$HC/index.theme" ] || cp /usr/share/icons/hicolor/index.theme "$HC/index.theme" 2>/dev/null || true
  gtk-update-icon-cache -q -f "$HC" 2>/dev/null || true
fi

ok "4/4  Pin to the task manager (KDE Plasma only)"
if command -v qdbus6 >/dev/null 2>&1 && qdbus6 org.kde.plasmashell >/dev/null 2>&1; then
  # Append the launcher to every task manager applet, once. The machine's own launcher-sync, if present,
  # keeps multiple panels mirrored.
  qdbus6 org.kde.plasmashell /PlasmaShell org.kde.PlasmaShell.evaluateScript '
    var entry = "applications:marauder-console.desktop";
    panels().forEach(function (p) {
      p.widgets().forEach(function (w) {
        if (w.type != "org.kde.plasma.icontasks" && w.type != "org.kde.plasma.taskmanager") return;
        w.currentConfigGroup = ["General"];
        var cur = String(w.readConfig("launchers"));
        var list = cur.length ? cur.split(",") : [];
        if (list.indexOf(entry) === -1) { list.push(entry); w.writeConfig("launchers", list); w.reloadConfig(); }
      });
    });
    print("pinned");' >/dev/null 2>&1 || warn "pin step failed (non-fatal) — pin it from the taskbar manually."
  command -v kbuildsycoca6 >/dev/null 2>&1 && kbuildsycoca6 >/dev/null 2>&1 || true
else
  warn "Not KDE Plasma (or qdbus6 missing) — the launcher is installed; pin it from your taskbar if you want."
fi

ok "Done — launch 'Marauder Console' from the menu or the pinned icon."
echo "  The launcher runs the bridge from $REPO/venv; keep the repo here, or re-run this script after moving it."
