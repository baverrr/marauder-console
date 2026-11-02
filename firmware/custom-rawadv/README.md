# Custom firmware: raw BLE advertisement capture

Stock ESP32 Marauder parses BLE advertisements and prints only the fields it cares about — for
`sniffbt -t airtag` that's a bare `<rssi> <mac>` line, and the raw advertisement bytes are thrown away.
This is a **small, opt-in patch** to the upstream firmware that *also* dumps the full advertisement
payload as hex, so the console can decode the AD structures itself (local name, Apple `0x004C` Find My
manufacturer data, service UUIDs, flags …).

> [!IMPORTANT]
> This is a **modified** build. The binaries bundled in [`../cyd_2432S028/`](../cyd_2432S028) are the
> upstream release, redistributed **byte-for-byte unmodified**, and
> [`scripts/verify-firmware-upstream.sh`](../../scripts/verify-firmware-upstream.sh) proves it. Nothing
> here touches those files or that guarantee — a firmware you build from this patch is your own and is
> **not** covered by the upstream provenance claim. Don't commit built binaries over the bundled ones.

## What the patch does

[`rawadv-v1.20.0.patch`](rawadv-v1.20.0.patch) — 25 added lines across three files, against upstream
**v1.20.0** (commit `511bb369`, the tag recorded in [`../manifest.json`](../manifest.json)):

- `WiFiScan.h` — adds one opt-in flag, `bool bt_raw_dump = false;`.
- `CommandLine.cpp` — `sniffbt` and `recon ble` now recognise a `-raw` switch and set that flag (off
  unless passed).
- `WiFiScan.cpp` — in each BLE scan branch, right after the device's normal sighting line, when
  `bt_raw_dump` is set it prints one extra line:

  ```
  RAWADV <MAC> <rssi> <hexpayload>
  ```

  e.g. `RAWADV 00:00:5E:00:53:17 -63 1eff4c0012...`. The `RAWADV ` prefix is deliberately distinct so it
  never collides with the plain sighting lines the console already parses — existing behaviour is
  unchanged whether or not you pass `-raw`. The dump is wired into every BLE sniff branch that reports
  devices: **AirTag/Find My** (`BT_SCAN_AIRTAG`), **iBeacon** and the catch-all **BT_SCAN_ALL**,
  **Flipper**, **Flock**, and **Meta/Ray-Ban** (`BT_SCAN_RAYBAN`). `recon ble` runs `BT_SCAN_ALL`, so it
  shares the same path.

  These are all in the NimBLE-1 scan callback — the one the CYD (`MARAUDER_CYD_MICRO`, NimBLE 1.3.8) and
  similar boards compile; the separate NimBLE-2 callback is left as stock, matching the rest of this patch.

The console-side decoder for this line lives in
[`frontend/src/lib/rawadv.ts`](../../frontend/src/lib/rawadv.ts).

### New command forms

Append `-raw` to any of the BLE sniff modes (or `recon ble`) to also get the `RAWADV` lines; `stopscan`
to stop. Without `-raw` the firmware behaves exactly as stock.

| Mode | Command | Scan mode |
|---|---|---|
| Find My / AirTag | `sniffbt -t airtag -raw` | `BT_SCAN_AIRTAG` |
| iBeacon | `sniffbt -t ibeacon -raw` | `BT_SCAN_IBEACON` |
| Flipper Zero | `sniffbt -t flipper -raw` | `BT_SCAN_FLIPPER` |
| Flock Safety | `sniffbt -t flock -raw` | `BT_SCAN_FLOCK` |
| Meta / Ray-Ban | `sniffbt -t meta -raw` | `BT_SCAN_RAYBAN` |
| All BLE (no filter) | `sniffbt -raw` | `BT_SCAN_ALL` |
| BLE recon | `recon ble -raw` | `BT_SCAN_ALL` |

The `RAWADV <MAC> <rssi> <hexpayload>` line format is identical across every mode, so the console's
`rawadv.ts` parser decodes them all unchanged.

## Building it

The device firmware is an **Arduino** build (the `platformio.ini` in the source tree is only for native
unit tests, not the board image). The upstream build guide is authoritative for the exact core and
library versions — follow it, then apply this patch before compiling:
<https://github.com/justcallmekoko/ESP32Marauder/wiki/Compiling-with-Arduino-IDE>

1. **Get the matching source** and apply the patch:

   ```bash
   git clone https://github.com/justcallmekoko/ESP32Marauder
   cd ESP32Marauder
   git checkout v1.20.0
   git apply /path/to/marauder-console/firmware/custom-rawadv/rawadv-v1.20.0.patch
   ```

   (`git apply --check <patch>` first if you want to confirm it applies cleanly — it does, against that
   tag.)

2. **Select this board.** In `esp32_marauder/configs.h`, uncomment the single-USB CYD target to match the
   bundled image (`cyd_2432S028`):

   ```c
   #define MARAUDER_CYD_MICRO   // 2432S028, single USB
   ```

3. **Install the toolchain and libraries** per the upstream wiki — the ESP32 Arduino core plus Marauder's
   vendored libraries (notably **CustomNimBLE-Arduino**, `TFT_eSPI`, `LinkedList`, …). On this machine the
   Arduino toolchain is not installed and package installs are gated, so this step runs on your side; the
   wiki lists exact versions, which matter.

4. **Compile and export the binary.** In the Arduino IDE, *Sketch → Export Compiled Binary*, or with
   `arduino-cli` (FQBN per the wiki), build `esp32_marauder/esp32_marauder.ino`. You want the resulting
   **application** image, `esp32_marauder.ino.bin`.

A pure code change like this keeps the same partition layout, so you only need to reflash the **app**
image; the bundled `bootloader.bin` / `partition-table.bin` / `ota-data.bin` already on the board stay
valid.

## Flashing the custom app image

With the board plugged in and **nothing else holding the serial port** (disconnect in Marauder Console /
stop the `marauder-console` service first — the bridge is the sole serial owner):

```bash
marauder-console/venv/bin/python -m esptool \
  --chip esp32 --port /dev/ttyUSB0 --baud 921600 \
  --before default_reset --after hard_reset \
  write_flash --flash_mode keep --flash_freq keep --flash_size keep \
  0x10000 /path/to/ESP32Marauder/esp32_marauder/build/*/esp32_marauder.ino.bin
```

`0x10000` is the app offset from [`../manifest.json`](../manifest.json). `esptool` is the same one
`scripts/flash-firmware.sh` installs into the project venv on demand (`requirements-flash.txt`).

### Going back to stock

Reflash the bundled, verified upstream image at any time:

```bash
bash scripts/flash-firmware.sh --port /dev/ttyUSB0
```

That restores the byte-for-byte upstream firmware and the normal (non-`RAWADV`) output.

> [!WARNING]
> Flashing overwrites the firmware on the board and is the one step here that can leave it
> non-booting until re-flashed. Double-check the board target (`cyd_2432S028` / `MARAUDER_CYD_MICRO`) and
> that the port is free before writing.
