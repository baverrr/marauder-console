#!/usr/bin/env bash
# Bundle the Python bridge into a single-file "sidecar" binary for the Tauri desktop app.
#
# Dev mode does NOT need this — the shell runs the bridge from ./venv directly. This is for packaging:
# it produces src-tauri/binaries/marauder-bridge-<target-triple>, the name Tauri's `externalBin` expects.
#
# Usage (from anywhere):  bash scripts/build-sidecar.sh
# Prereq: PyInstaller in ./venv (installed by scripts/setup-tauri-toolchain.sh) and a Rust toolchain.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

PYI="$REPO/venv/bin/pyinstaller"
[ -x "$PYI" ] || { echo "PyInstaller not found at $PYI — run scripts/setup-tauri-toolchain.sh first." >&2; exit 1; }

RUSTC="${RUSTC:-$HOME/.cargo/bin/rustc}"
command -v "$RUSTC" >/dev/null 2>&1 || RUSTC="rustc"
TRIPLE="$("$RUSTC" -Vv | awk '/^host:/{print $2}')"
[ -n "$TRIPLE" ] || { echo "could not determine the Rust host triple from $RUSTC" >&2; exit 1; }

echo "Building sidecar for target triple: $TRIPLE"
rm -rf "$REPO/build/marauder-bridge" "$REPO/dist/marauder-bridge"

# Why each flag:
#  --collect-submodules uvicorn   uvicorn's loop/protocol backends are imported dynamically.
#  --collect-all anthropic        the Claude assistant SDK (lazy-imported by assistant_runner).
#  --collect-all keyring + jeepney/secretstorage  keyring finds its OS backend via entry points, and the
#                                 Linux Secret Service backend needs jeepney + secretstorage bundled.
#  serial_source / assistant / assistant_runner / capture_store / session_store / pcap_reader / wigle_reader
#    are first-party modules beside bridge.py; --paths "$REPO" puts them on the search path, and the
#    lazy/local ones are named as hidden imports so PyInstaller definitely includes them.
# If the bundled bridge ever fails to open a WebSocket, add:  --collect-all websockets  (or wsproto).
"$PYI" --noconfirm --onefile --clean \
  --name marauder-bridge \
  --paths "$REPO" \
  --collect-submodules uvicorn \
  --collect-all anthropic \
  --collect-all keyring \
  --collect-submodules secretstorage \
  --hidden-import jeepney \
  --hidden-import serial_asyncio \
  --hidden-import assistant \
  --hidden-import assistant_runner \
  --hidden-import capture_store \
  --hidden-import session_store \
  --hidden-import pcap_reader \
  --hidden-import wigle_reader \
  "$REPO/bridge.py"

mkdir -p "$REPO/src-tauri/binaries"
install -m 0755 "$REPO/dist/marauder-bridge" "$REPO/src-tauri/binaries/marauder-bridge-$TRIPLE"

cat <<EOF

Done: src-tauri/binaries/marauder-bridge-$TRIPLE

To have Tauri bundle and spawn it, add this to the "bundle" object in src-tauri/tauri.conf.json:
    "externalBin": ["binaries/marauder-bridge"]
Then \`npm --prefix frontend run tauri build\` (or \`cargo tauri build\`) will include it, and the shell
will spawn it next to the app binary. Until then the shell falls back to the ./venv bridge in dev.
EOF
