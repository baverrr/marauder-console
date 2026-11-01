#!/bin/sh
# Installs Marauder Console for the current user (no root): a Python venv for the bridge, the built web
# frontend, a `marauder-console` launcher, and (with --service) a systemd --user service that keeps the
# bridge running. Run it from the checkout, wherever it lives; run it again after moving the checkout or
# pulling new code.
#   ./install.sh [--service] [--skip-frontend]
set -eu

APP_DIR=$(cd "$(dirname "$0")" && pwd)
BIN_DIR="$HOME/.local/bin"
UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE=no
BUILD_FRONTEND=yes
for arg in "$@"; do
    case "$arg" in
        --service) SERVICE=yes ;;
        --skip-frontend) BUILD_FRONTEND=no ;;
        *) echo "usage: $0 [--service] [--skip-frontend]" >&2; exit 2 ;;
    esac
done

# Paths go into a shell launcher and a systemd unit; refuse characters that would need different escaping.
case "$APP_DIR" in
    *[\"\$\`%\\]*) echo "Can't install from $APP_DIR: move the checkout to a path without \" \$ \` % or \\" >&2; exit 1 ;;
esac

sed_escape() { printf '%s' "$1" | sed 's/[|&]/\\&/g'; }
fill() {  # template -> destination, with @APP_DIR@ filled in
    mkdir -p "$(dirname "$2")"
    sed -e "s|@APP_DIR@|$(sed_escape "$APP_DIR")|g" "$1" > "$2"
}

command -v python3 >/dev/null || { echo "python3 is required." >&2; exit 1; }

echo "venv: $APP_DIR/venv"
[ -x "$APP_DIR/venv/bin/python" ] || python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install --quiet --upgrade pip
"$APP_DIR/venv/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

if [ "$BUILD_FRONTEND" = yes ]; then
    if command -v npm >/dev/null; then
        echo "frontend: building $APP_DIR/frontend/dist"
        ( cd "$APP_DIR/frontend" && npm install --no-fund --no-audit && npm run build )
    else
        echo "npm not found; skipping frontend build. Install Node.js and re-run, or use --skip-frontend" >&2
        echo "if a prebuilt frontend/dist is already present." >&2
    fi
fi

echo "launcher: $BIN_DIR/marauder-console"
fill "$APP_DIR/packaging/marauder-console.in" "$BIN_DIR/marauder-console"
chmod 755 "$BIN_DIR/marauder-console"

if [ "$SERVICE" = yes ]; then
    echo "service: $UNITS/marauder-console.service (http://127.0.0.1:8200)"
    fill "$APP_DIR/packaging/marauder-console.service.in" "$UNITS/marauder-console.service"
    systemctl --user daemon-reload
    systemctl --user enable --now marauder-console.service
    systemctl --user restart marauder-console.service  # pick up a moved checkout or new build
fi

# The bridge needs read/write on the serial device. On most distros that means the 'dialout' group.
if [ -e /dev/ttyUSB0 ] && ! id -nG | tr ' ' '\n' | grep -qx dialout; then
    echo "Note: you're not in the 'dialout' group, so opening /dev/ttyUSB0 may fail."
    echo "      Run: sudo usermod -aG dialout \"$USER\"   then log out and back in."
fi

case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "Note: $BIN_DIR isn't on your PATH; run the bridge with: $BIN_DIR/marauder-console" ;;
esac

echo "Done. Start it with 'marauder-console' (or 'marauder-console --mock' for no hardware),"
echo "then open http://127.0.0.1:8200"
