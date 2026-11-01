#!/usr/bin/env bash
# Build the distributable desktop bundle (AppImage + .deb) with the Python bridge bundled as a sidecar.
#
# This is the "ship to users" build (run mode 3 in docs/desktop-dev.md): the app spawns the bundled
# sidecar, no ./venv and no browser needed. For day-to-day dev use `tauri dev` instead.
#
# Prereqs: the Tauri toolchain (scripts/setup-tauri-toolchain.sh), the Python venv with the bridge deps +
# PyInstaller, and the Tauri CLI (npm --prefix frontend install).
#
#   bash scripts/build-bundle.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
command -v cargo >/dev/null 2>&1 || . "$HOME/.cargo/env" 2>/dev/null || true

echo "==> Building the bridge sidecar"
bash "$REPO/scripts/build-sidecar.sh"

echo "==> Building the Tauri bundle (AppImage + .deb)"
# The externalBin that bundles the sidecar lives in an overlay config, merged in only for packaging, so a
# plain `cargo build` / `tauri dev` still works without a prebuilt sidecar binary present.
npm --prefix "$REPO/frontend" run tauri -- build --config "$REPO/src-tauri/tauri.bundle.conf.json"

echo
echo "Done. Artifacts:"
find "$REPO/src-tauri/target/release/bundle" -maxdepth 2 -type f \( -name '*.AppImage' -o -name '*.deb' \) 2>/dev/null || true
