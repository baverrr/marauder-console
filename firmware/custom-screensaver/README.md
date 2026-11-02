# Custom firmware: idle logo screensaver (CYD)

A small, opt-in patch that adds a **tap-to-wake screensaver** to the ESP32 Marauder on the CYD
(`MARAUDER_CYD_MICRO`, 2432S028): after a period of inactivity it shows the Marauder logo centered on a
black screen, and the next screen tap restores the normal UI.

> [!IMPORTANT]
> This is a **modified** build, independent of the bundled upstream binaries in
> [`../cyd_2432S028/`](../cyd_2432S028) (which stay byte-for-byte unmodified and are verified by
> [`scripts/verify-firmware-upstream.sh`](../../scripts/verify-firmware-upstream.sh)). It's also separate
> from the [raw-advert patch](../custom-rawadv/) — different files, so the two apply cleanly together if
> you want both. Don't commit built binaries over the bundled ones.

## What the patch does

[`screensaver-v1.20.0.patch`](screensaver-v1.20.0.patch) — against upstream **v1.20.0** (commit
`511bb369`), touching only `Display.cpp`, `Display.h` and `esp32_marauder.ino`:

- **`Display::drawScreensaver()`** — renders just the Marauder logo (`JCMK_LOGO_BITMAP`, reused from the
  boot splash) centered on a black screen. No new image asset.
- **Activity tracking** — sets `Display::last_touch_ms = millis()` in the CYD `XPT2046` touch read (it was
  only tracked on the Core2/FT6336 path before), so idle time can be measured.
- **`marauderScreensaverStep()`** in the main `loop()` — after **30 seconds** with no touch, **and only
  when a scan is not running** (so it never covers live on-screen scan output), it draws the logo. The
  next tap wakes it, restores the current screen via `changeMenu(current_menu)`, and is **consumed** so it
  doesn't also trigger a menu button. While the saver is up, normal menu drawing/input is skipped.

It's gated to `HAS_SCREEN && HAS_CYD_TOUCH`, so it compiles to a no-op on boards without CYD touch, and is
otherwise non-intrusive: the board behaves exactly as stock until it's been idle, and any tap brings it
straight back.

### Tuning

The timeout is a single constant, `SCREENSAVER_TIMEOUT_MS` (default `30000`), in the patched
`marauderScreensaverStep()`; change it before building for a different idle delay.

## Building and flashing

Identical to the [raw-advert patch's build](../custom-rawadv/README.md#building-it) — get an upstream
**v1.20.0** checkout, apply this patch (and the raw-advert one too, if you want both), select
`MARAUDER_CYD_MICRO`, build, and flash the app image at `0x10000`. Going back to stock is a reflash of the
bundled image via [`scripts/flash-firmware.sh`](../../scripts/flash-firmware.sh).

```bash
git clone https://github.com/justcallmekoko/ESP32Marauder && cd ESP32Marauder
git checkout v1.20.0
git apply /path/to/marauder-console/firmware/custom-screensaver/screensaver-v1.20.0.patch
# (optional) git apply /path/to/marauder-console/firmware/custom-rawadv/rawadv-v1.20.0.patch
```

> [!WARNING]
> Flashing overwrites the firmware and is the one step that can leave the board non-booting until
> re-flashed. Free the serial port first (stop the `marauder-console` service / quit the desktop app) and
> confirm the board target (`cyd_2432S028` / `MARAUDER_CYD_MICRO`).
