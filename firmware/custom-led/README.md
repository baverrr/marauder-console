# Custom firmware: green board LED, optional purple/green (CYD)

A small, opt-in patch that holds the RGB LED on the back of the CYD (`MARAUDER_CYD_MICRO`, 2432S028)
**solid green**, or, with one constant flipped, **alternates purple and green** once a second.

> [!IMPORTANT]
> This is a **modified** build, independent of the bundled upstream binaries in
> [`../cyd_2432S028/`](../cyd_2432S028) (which stay byte-for-byte unmodified and are verified by
> [`scripts/verify-firmware-upstream.sh`](../../scripts/verify-firmware-upstream.sh)). It touches a
> different file from the [raw-advert](../custom-rawadv/) and [screensaver](../custom-screensaver/)
> patches, so all three apply cleanly together. Don't commit built binaries over the bundled ones.

## What the patch does

[`led-v1.20.0.patch`](led-v1.20.0.patch) — against upstream **v1.20.0** (commit `511bb369`), touching
only `flipperLED.cpp`, the driver the CYD build uses for its LED (red on GPIO 4, green on GPIO 16, blue on
GPIO 17, common-anode so a pin driven LOW lights it):

- **PWM instead of on/off** — every LED write goes through one `marauderSetRGB(r, g, b)` helper using
  `analogWrite`, so colours can be mixed. (On core 2.x a pin attached to PWM ignores `digitalWrite`, so the
  stock boot flash and scan colours are moved onto the same helper.)
- **`flipperLED::main()`** — stock does nothing here; the patch sets the LED once per `LED_ALTERNATE_MS`
  tick (default `1000`): solid green, or purple and green in turn when `LED_ALTERNATE` is `true`.
- **`EnableLED` setting is respected** — with the LED turned off in Marauder's Settings, it stays dark.
  The setting is checked each tick, so turning it off takes effect within a second.

**Trade-off:** stock firmware shows **blue while sniffing** and **red while attacking**. Those colours
still come on when a scan starts, but the patch's colour takes over again at the next tick (within a
second), so the LED no longer works as a scan indicator.

### Purple needs a working red channel

Purple is **full red with dimmed blue** (`PURPLE_B = 64`): the blue die on this LED is far brighter than
the red, so full blue swamps the red. On some CYD boards the red channel is dead (a bad LED or joint).
The boot flash shows it: stock firmware lights blue, green, then red for half a second each, and if red
never appears, purple just shows as blue. That's why the default is solid green (`LED_ALTERNATE = false`).

### Tuning

Before building, in `flipperLED::main()`:

| Constant | Default | Effect |
|---|---|---|
| `LED_ALTERNATE` | `false` | `true` alternates purple and green; `false` holds solid green. |
| `LED_ALTERNATE_MS` | `1000` | Switch speed, and how quickly a scan colour is overwritten. |
| `PURPLE_B` | `64` | Blue in the purple (0–255): raise for bluer, lower for pinker. `PURPLE_R` stays at 255. |

## Building and flashing

Identical to the [raw-advert patch's build](../custom-rawadv/README.md#building-it) — get an upstream
**v1.20.0** checkout, apply this patch (plus the others if you want them), select `MARAUDER_CYD_MICRO`,
build, and flash the app image at `0x10000`. Going back to stock is a reflash of the bundled image via
[`scripts/flash-firmware.sh`](../../scripts/flash-firmware.sh).

```bash
git clone https://github.com/justcallmekoko/ESP32Marauder && cd ESP32Marauder
git checkout v1.20.0
git apply /path/to/marauder-console/firmware/custom-led/led-v1.20.0.patch
# (optional) git apply /path/to/marauder-console/firmware/custom-screensaver/screensaver-v1.20.0.patch
# (optional) git apply /path/to/marauder-console/firmware/custom-rawadv/rawadv-v1.20.0.patch
```

> [!WARNING]
> Flashing overwrites the firmware and is the one step that can leave the board non-booting until
> re-flashed. Free the serial port first (stop the `marauder-console` service / quit the desktop app) and
> confirm the board target (`cyd_2432S028` / `MARAUDER_CYD_MICRO`).
