#!/usr/bin/env bash
# Re-verify the bundled firmware against the upstream ESP32 Marauder release, over the network.
#
# The flasher (flash-firmware.sh) only checks the bundled .bin files against firmware/manifest.json —
# an internal consistency check. This script closes the loop: it downloads the upstream release named in
# the manifest and confirms every bundled firmware file is byte-for-byte identical to the matching entry
# in the upstream per-board installer bundle (`marauder-installer-assets.zip`). That proves the firmware
# we ship is the unmodified upstream build, not just self-consistent.
#
# No credentials needed — it fetches the public release asset over HTTPS (curl). Run it when bumping the
# bundled firmware, or any time you want to re-establish provenance.
#
#   bash scripts/verify-firmware-upstream.sh
#
# Note on the standalone web-flasher asset: upstream also publishes a standalone
# `esp32_marauder_<ver>_<date>_<board>.bin`. That file is byte-identical to the installer-bundle app
# image EXCEPT for the two self-referential ESP-IDF SHA-256 fields (the esp_app_desc app_elf_sha256 and
# the appended image hash), because upstream post-processes it separately. We source from, and verify
# against, the installer bundle, which is the authoritative per-component set.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$REPO/firmware/manifest.json"
PY="$(command -v python3 || echo "$REPO/venv/bin/python")"

err(){ printf '\033[1;31m%s\033[0m\n' "$*" >&2; }
ok(){  printf '\033[1;32m==> %s\033[0m\n' "$*"; }

[ -f "$MANIFEST" ] || { err "Missing $MANIFEST"; exit 1; }
command -v curl >/dev/null 2>&1 || { err "curl is required."; exit 1; }

# Build the release download URL + the installer-asset filename from the manifest.
read -r BASE_URL ASSET < <("$PY" - "$MANIFEST" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
up = m["upstream"]
repo = up["repo"].rstrip("/")            # https://github.com/<owner>/<name>
tag = up["tag"]
print(f"{repo}/releases/download/{tag}", "marauder-installer-assets.zip")
PY
)

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ZIP="$TMP/$ASSET"

ok "Downloading $ASSET from $BASE_URL"
curl -fsSL "$BASE_URL/$ASSET" -o "$ZIP" || { err "Download failed: $BASE_URL/$ASSET"; exit 1; }

ok "Comparing every bundled firmware file against the upstream installer bundle"
"$PY" - "$MANIFEST" "$REPO/firmware" "$ZIP" <<'PY'
import hashlib, json, os, sys, zipfile

manifest, fwdir, zippath = sys.argv[1], sys.argv[2], sys.argv[3]
m = json.load(open(manifest))
up = m["upstream"]
ver = up["tag"].lstrip("v").replace(".", "_")   # v1.20.0 -> 1_20_0
date = up["asset_date"]

# Our per-component filename -> the suffix upstream uses inside the installer bundle.
SUFFIX = {
    "bootloader.bin": ".bootloader.bin",
    "partition-table.bin": ".partition-table.bin",
    "ota-data.bin": ".ota-data.bin",
    "app.bin": ".bin",   # the application image is just "<prefix>.bin"
}

def sha256(data):
    return hashlib.sha256(data).hexdigest()

zf = zipfile.ZipFile(zippath)
names = set(zf.namelist())
fails = 0
total = 0

for board, spec in m["boards"].items():
    prefix = f"esp32_marauder_installer_v{ver}_{date}_{board}"
    print(f"\nboard '{board}'  (upstream prefix {prefix})")
    for f in spec["files"]:
        total += 1
        base = os.path.basename(f["path"])
        suffix = SUFFIX.get(base)
        if suffix is None:
            print(f"  ?  {base}: no upstream-name mapping — skipped")
            fails += 1
            continue
        entry = prefix + suffix
        local = os.path.join(fwdir, f["path"])
        # Local file present and matching the manifest?
        if not os.path.isfile(local):
            print(f"  ✗  {base}: bundled file missing ({local})")
            fails += 1
            continue
        local_sha = sha256(open(local, "rb").read())
        if local_sha != f["sha256"]:
            print(f"  ✗  {base}: bundled file does not match manifest sha256")
            fails += 1
            continue
        # Upstream entry present and byte-identical?
        if entry not in names:
            print(f"  ✗  {base}: upstream entry not found in bundle ({entry})")
            fails += 1
            continue
        up_sha = sha256(zf.read(entry))
        if up_sha == local_sha:
            print(f"  ✓  {base}  ==  {entry}")
        else:
            print(f"  ✗  {base}: differs from upstream\n       bundled  {local_sha}\n       upstream {up_sha}")
            fails += 1

print()
if fails:
    print(f"RESULT: {fails} of {total} file(s) FAILED upstream verification.")
    sys.exit(1)
print(f"RESULT: all {total} bundled firmware file(s) are byte-identical to upstream {up['tag']}.")
PY