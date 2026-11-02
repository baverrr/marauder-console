# Bundled firmware

The prebuilt **ESP32 Marauder** firmware for the **Cheap Yellow Display (ESP32‑2432S028)**, so the board
and the console that drives it ship together. The binaries are redistributed **unmodified** under the
upstream **MIT** license — see [`UPSTREAM-LICENSE.txt`](UPSTREAM-LICENSE.txt). Marauder Console is an
independent interface and is not affiliated with the ESP32 Marauder project.

- Upstream: https://github.com/justcallmekoko/ESP32Marauder — release **v1.20.0**
- [`manifest.json`](manifest.json) records the upstream tag, commit, and the `sha256` + flash offset of
  every file. This is the matching firmware for the command set in
  [`frontend/src/tools.ts`](../frontend/src/tools.ts) (also v1.20.0).

Provenance is verifiable: every bundled file is **byte-for-byte identical** to the matching per-board
entry in the upstream release's `marauder-installer-assets.zip`. Re-check it any time over the network
with [`scripts/verify-firmware-upstream.sh`](../scripts/verify-firmware-upstream.sh) — it downloads the
upstream release named in the manifest and compares `sha256`s.

## Layout (`cyd_2432S028/`) — standard ESP32 four-file flash

| offset   | file                  | purpose          |
|----------|-----------------------|------------------|
| `0x1000` | `bootloader.bin`      | bootloader       |
| `0x8000` | `partition-table.bin` | partition table  |
| `0xe000` | `ota-data.bin`        | boot_app0        |
| `0x10000`| `app.bin`             | Marauder app     |

## Flashing

From the repo root, with the board plugged in and **nothing else using the serial port** (disconnect in
Marauder Console / stop the service first):

```bash
bash scripts/flash-firmware.sh --port /dev/ttyUSB0
```

The script verifies each file's `sha256` against `manifest.json`, refuses to run if the port is busy
(detected with `fuser`, falling back to `lsof`), does a read-only chip check, asks for confirmation, then
writes with the vendor's embedded flash params. Add `--dry-run` to check connectivity without writing, or
`--yes` to skip the prompt. `esptool` is installed into the project venv on demand.

> This board target is **cyd_2432S028** (single-USB CYD). The `_2usb` variant and other boards have their
> own images in the upstream release; drop the four files into a new `firmware/<board>/` and add it to
> `manifest.json` to flash those.

## Updating to a new upstream release

1. Download that release's `marauder-installer-assets.zip`.
2. Extract the board's four `...<board>.{bootloader,partition-table,ota-data,}.bin` files into
   `firmware/<board>/` as `bootloader.bin` / `partition-table.bin` / `ota-data.bin` / `app.bin`.
3. Regenerate `manifest.json` (tag, commit, and fresh `sha256`s), and keep `tools.ts` in step so the
   reference matches the firmware.
4. Run `bash scripts/verify-firmware-upstream.sh` to confirm the new files are byte-identical to that
   upstream release before committing.
