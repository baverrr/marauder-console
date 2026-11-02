# Custom firmware: optical lens finder (CYD)

A small, opt-in patch that turns the ESP32 Marauder on the CYD (`MARAUDER_CYD_MICRO`, 2432S028) into a
**hidden-camera lens finder**. It strobes the board's rear RGB LED; you look over the board and sweep the
room, and any camera lens pointed your way throws a bright, sharp glint straight back at you.

> [!IMPORTANT]
> This is a **modified** build, independent of the bundled upstream binaries in
> [`../cyd_2432S028/`](../cyd_2432S028) (which stay byte-for-byte unmodified and are verified by
> [`scripts/verify-firmware-upstream.sh`](../../scripts/verify-firmware-upstream.sh)). It applies cleanly
> on its own or together with the [raw-advert](../custom-rawadv/) and [screensaver](../custom-screensaver/)
> patches, in any order. Don't commit built binaries over the bundled ones.

## How it works

A camera lens sits in front of a sensor at its focal plane, so it acts as a **retro-reflector**: light
that goes in comes back out towards where it came from. If the light source sits right next to your eye,
the lens lights up as a small, bright point while ordinary surfaces stay dim. Commercial lens finders are
a ring of red LEDs around a viewing hole; this patch uses the CYD's own rear LED the same way.

The ESP32 drives the light; **your eye is the detector**. The CYD has no rear-facing light sensor (its
LDR is on the front, beside the screen, and far too slow and coarse), so it can't spot the glint itself.

Strobing helps tell a lens apart from other bright points: a lens glint blinks **in step with the LED**
and stays pinned to the same spot as you move your head, while a device's own indicator light doesn't
blink with it.

## Using it

- **Touchscreen:** Device → **Lens Finder**.
- **Serial / Marauder Console:** the **Lens Finder** card under Device, or type the command:

| Command | Does |
|---|---|
| `lensfind` | Red, strobing at 4 Hz |
| `lensfind -r 10` | Red, strobing at 10 Hz (1–20) |
| `lensfind -s` | Steady red |
| `lensfind -w` | White (all three LED channels) instead of red; combine with `-r` or `-s` |
| `lensfind stop` / `stopscan` | Stop |

Then:

1. Turn the room lights off (the darker, the better).
2. Hold the board screen-up, just below your eye, with the **LED on the back facing the room**.
3. Look over the top edge of the board and sweep slowly — smoke detectors, clocks, chargers, vents,
   picture frames, shelves.
4. A lens shows as a **tiny, sharp point** that blinks with the LED. Walk towards it; it should stay put.

The screen shows instructions, then **goes dark after 5 seconds** so it doesn't spoil your night vision.
**Tap anywhere** to stop (the tap is consumed, so it won't also press a menu button). Sending any other
command also stops it first.

> [!NOTE]
> **Expect limits.** The CYD's LED is a small status LED, so range is roughly a few metres in a dark
> room — closer is better. Red helps with night vision; white is a little brighter. Lenses behind tinted
> or IR-pass covers, and pinhole cameras at a steep angle, can be hard to see. A miss doesn't prove a room
> is clean; pair it with an RF sweep (e.g. Marauder's Wi-Fi/BLE scans) for anything that transmits.

## What the patch does

[`lensfinder-v1.20.0.patch`](lensfinder-v1.20.0.patch) — against upstream **v1.20.0** (commit
`511bb369`):

- **`LensFinder.h` / `LensFinder.cpp`** (new) — drives the RGB LED pins (`R_PIN`/`G_PIN`/`B_PIN`,
  active-low) directly, so it works even with the `EnableLED` setting off. Draws the instructions,
  switches the backlight off after 5 s, and handles tap-to-stop (waiting for release so the tap doesn't
  fall through to a menu button). Stopping restores the backlight and the current menu.
- **`CommandLine`** — the `lensfind` command and its help line; any other command ends the lens finder
  first. Refuses to start while a scan is running (scans use the same LED).
- **`MenuFunctions.cpp`** — a **Lens Finder** button in the Device menu.
- **`esp32_marauder.ino`** — the global `lens_finder` and a loop hook that skips menu drawing/input (and
  the idle screensaver, if that patch is applied) while it runs.

It's gated to boards with `HAS_FLIPPER_LED` (the CYD's RGB LED); elsewhere `lensfind` replies that it
needs an RGB status LED and the menu button isn't added.

## Building and flashing

Identical to the [raw-advert patch's build](../custom-rawadv/README.md#building-it) — get an upstream
**v1.20.0** checkout, apply this patch (plus the others if you want them), select `MARAUDER_CYD_MICRO`,
build, and flash the app image at `0x10000`. With all three patches the app is about 1.62 MB (82% of the
`min_spiffs` app slot). Going back to stock is a reflash of the bundled image via
[`scripts/flash-firmware.sh`](../../scripts/flash-firmware.sh).

```bash
git clone https://github.com/justcallmekoko/ESP32Marauder && cd ESP32Marauder
git checkout v1.20.0
git apply /path/to/marauder-console/firmware/custom-lensfinder/lensfinder-v1.20.0.patch
# (optional) git apply /path/to/marauder-console/firmware/custom-rawadv/rawadv-v1.20.0.patch
# (optional) git apply /path/to/marauder-console/firmware/custom-screensaver/screensaver-v1.20.0.patch
```

> [!WARNING]
> Flashing overwrites the firmware and is the one step that can leave the board non-booting until
> re-flashed. Free the serial port first (stop the `marauder-console` service / quit the desktop app) and
> confirm the board target (`cyd_2432S028` / `MARAUDER_CYD_MICRO`).
