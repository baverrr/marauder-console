#!/usr/bin/env bash
# Flash the bundled ESP32 Marauder firmware onto the board with esptool.
#
# Safe by design:
#   - verifies every firmware file's sha256 against firmware/manifest.json before touching the board;
#   - refuses to run while the serial port is in use (disconnect the console / stop the service first) —
#     the bridge is the sole serial owner, and nothing flashes while a session is connected;
#   - does a read-only connectivity check, then asks for explicit confirmation before writing;
#   - uses the vendor's embedded flash params (mode/freq/size "keep") so it can't mis-set them.
#
# Usage:
#   bash scripts/flash-firmware.sh [--port /dev/ttyUSB0] [--board cyd_2432S028] [--baud 921600]
#                                  [--dry-run] [--yes]
#
# Prereq: the project venv (install.sh). esptool is installed into it on demand (requirements-flash.txt).
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${MARAUDER_CONSOLE_SERIAL_PORT:-/dev/ttyUSB0}"
BOARD="cyd_2432S028"
BAUD="921600"
DRY_RUN=0
ASSUME_YES=0
MANIFEST="$REPO/firmware/manifest.json"
PY="$REPO/venv/bin/python"

err(){ printf '\033[1;31m%s\033[0m\n' "$*" >&2; }
ok(){  printf '\033[1;32m==> %s\033[0m\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --port)  PORT="$2"; shift 2;;
    --board) BOARD="$2"; shift 2;;
    --baud)  BAUD="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    --yes|-y) ASSUME_YES=1; shift;;
    -h|--help) sed -n '2,20p' "$0"; exit 0;;
    *) err "unknown argument: $1"; exit 2;;
  esac
done

[ -x "$PY" ] || { err "No project venv at $PY — run ./install.sh first."; exit 1; }
[ -f "$MANIFEST" ] || { err "Missing $MANIFEST"; exit 1; }

# esptool on demand (user-local, no sudo).
if ! "$PY" -m esptool version >/dev/null 2>&1; then
  ok "Installing esptool into the venv"
  "$PY" -m pip install -r "$REPO/requirements-flash.txt" || { err "Could not install esptool."; exit 1; }
fi

# Parse the manifest for this board, verify sha256, and emit "chip<TAB>offset<TAB>abspath" lines.
PLAN="$("$PY" - "$MANIFEST" "$BOARD" "$REPO/firmware" <<'PY'
import hashlib, json, sys
manifest, board, fwdir = sys.argv[1], sys.argv[2], sys.argv[3]
import os
m = json.load(open(manifest))
boards = m.get("boards", {})
if board not in boards:
    sys.stderr.write("unknown board '%s'. Available: %s\n" % (board, ", ".join(sorted(boards))))
    sys.exit(3)
chip = m.get("chip", "esp32")
for f in boards[board]["files"]:
    p = os.path.join(fwdir, f["path"])
    if not os.path.isfile(p):
        sys.stderr.write("missing firmware file: %s\n" % p); sys.exit(4)
    got = hashlib.sha256(open(p, "rb").read()).hexdigest()
    if got != f["sha256"]:
        sys.stderr.write("sha256 mismatch for %s\n  expected %s\n  got      %s\n" % (p, f["sha256"], got))
        sys.exit(5)
    print("%s\t%s\t%s" % (chip, f["offset"], p))
PY
)" || { err "Firmware verification failed."; exit 1; }

CHIP="$(printf '%s\n' "$PLAN" | head -1 | cut -f1)"
ok "Firmware verified (sha256 OK) — board '$BOARD', chip $CHIP"

# Refuse to flash while something holds the serial port. Prefer fuser; fall back to lsof (not every
# distro ships fuser); if neither is installed, say so rather than silently assuming the port is free.
if [ -e "$PORT" ]; then
  holder=""
  if command -v fuser >/dev/null 2>&1; then
    holder="$(fuser "$PORT" 2>/dev/null || true)"
  elif command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -t "$PORT" 2>/dev/null | tr '\n' ' ' || true)"
    [ -n "${pids// /}" ] && holder=" ${pids% }"  # lead with a space to match fuser's " <pid>" format
  else
    err "Note: neither 'fuser' nor 'lsof' is installed — cannot check whether $PORT is in use."
    err "Make sure Marauder Console is disconnected (or the service stopped) before you continue."
  fi
  if [ -n "$holder" ]; then
    err "Serial port $PORT is in use (pid$holder). Disconnect in Marauder Console (or stop the"
    err "marauder-console service), then re-run. Nothing was flashed."
    exit 1
  fi
else
  err "Serial port $PORT not found. Plug in the board (or pass --port). Nothing was flashed."
  exit 1
fi

# Read-only connectivity check.
ok "Reading chip info from $PORT (read-only)"
"$PY" -m esptool --chip "$CHIP" --port "$PORT" flash_id || {
  err "Could not talk to the board on $PORT. Check the cable/port and that it's not in use. Nothing was flashed."
  exit 1
}

# Build the esptool write_flash argument list: <offset> <file> pairs.
WRITE_ARGS=()
while IFS=$'\t' read -r _chip offset path; do
  [ -n "$offset" ] && WRITE_ARGS+=("$offset" "$path")
done <<< "$PLAN"

echo
ok "About to flash board '$BOARD' on $PORT (chip $CHIP, baud $BAUD):"
i=0
while [ $i -lt ${#WRITE_ARGS[@]} ]; do
  printf '    %-8s %s\n' "${WRITE_ARGS[$i]}" "$(basename "${WRITE_ARGS[$((i+1))]}")"
  i=$((i+2))
done
echo "  This OVERWRITES the firmware on the board. Make sure this is the right board target."

if [ "$DRY_RUN" = "1" ]; then
  ok "Dry run — not writing. (Board reachable and firmware verified.)"
  exit 0
fi

if [ "$ASSUME_YES" != "1" ]; then
  printf "Type 'flash' to proceed: "
  read -r ans
  [ "$ans" = "flash" ] || { err "Aborted — nothing was flashed."; exit 1; }
fi

ok "Flashing…"
"$PY" -m esptool --chip "$CHIP" --port "$PORT" --baud "$BAUD" \
  --before default_reset --after hard_reset \
  write_flash --flash_mode keep --flash_freq keep --flash_size keep \
  "${WRITE_ARGS[@]}" || { err "Flashing failed. The board may need re-flashing before it will boot."; exit 1; }

ver="$("$PY" -c 'import json,sys; print(json.load(open(sys.argv[1]))["upstream"]["tag"])' "$MANIFEST" 2>/dev/null || echo "?")"
ok "Done — flashed ESP32 Marauder $ver. Reconnect in Marauder Console."
