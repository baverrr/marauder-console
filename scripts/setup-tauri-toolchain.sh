#!/usr/bin/env bash
# Install the Tauri v2 + sidecar toolchain for the marauder-console desktop build.
#
# RUN THIS IN A REAL TERMINAL (e.g. Konsole), not inside an AI-agent shell — sandboxed agent shells
# set NoNewPrivs, which stops sudo from elevating. The apt step needs sudo; everything else is user-local.
#
#   bash scripts/setup-tauri-toolchain.sh
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ok()   { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m!!  %s\033[0m\n' "$*"; }

# 1) Tauri v2 system libraries (Ubuntu 24.04+ / 26.04 -> webkit2gtk-4.1). Needs root.
ok "1/3  System libraries (sudo apt)"
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libxdo-dev \
  libssl-dev \
  curl wget file || { warn "apt install failed — stopping."; exit 1; }

# 2) Rust toolchain via rustup (user-local: ~/.cargo, ~/.rustup; no sudo).
ok "2/3  Rust (rustup)"
if [ ! -x "$HOME/.cargo/bin/cargo" ] && ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
fi
# shellcheck disable=SC1091
. "$HOME/.cargo/env"
rustc --version && cargo --version

# 3) PyInstaller into the project venv (for bundling the bridge as a sidecar).
ok "3/3  PyInstaller (into venv)"
if [ -x "$REPO/venv/bin/pip" ]; then
  "$REPO/venv/bin/pip" install --upgrade pip >/dev/null
  if "$REPO/venv/bin/pip" install pyinstaller; then
    "$REPO/venv/bin/pyinstaller" --version
  else
    warn "PyInstaller install failed — the sidecar build can use a separate venv later; this does not"
    warn "block dev mode, which runs the bridge from ./venv directly."
  fi
else
  warn "No venv at \$REPO/venv — run ./install.sh first if you need the sidecar build."
fi

ok "Done — versions:"
echo "  rustc:       $(rustc --version 2>/dev/null || echo MISSING)"
echo "  cargo:       $(cargo --version 2>/dev/null || echo MISSING)"
echo "  webkit2gtk:  $(pkg-config --modversion webkit2gtk-4.1 2>/dev/null || echo MISSING)"
echo "  pyinstaller: $("$REPO/venv/bin/pyinstaller" --version 2>/dev/null || echo 'not installed')"
echo
echo "Next: npm --prefix frontend install   (pulls the Tauri CLI), then see docs/desktop-dev.md"
