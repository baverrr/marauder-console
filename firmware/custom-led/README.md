# Custom firmware: green board LED, optional purple/green (CYD)

A small, opt-in patch that holds the RGB LED on the back of the CYD (`MARAUDER_CYD_MICRO`, 2432S028)
**solid green** while the board is idle, or, with one constant flipped, **alternates purple and green**
once a second. During a scan the LED still shows the stock **blue (sniffing)** and **red (attacking)**.

> [!IMPORTANT]
> This is a **modified** build, independent of the bundled upstream binaries in
> [`../cyd_2432S028/`](../cyd_2432S028) (which stay byte-for-byte unmodified and are verified by
> [`scripts/verify-firmware-upstream.sh`](../../scripts/verify-firmware-upstream.sh)). It touches a
> different file from the [raw-advert](../custom-rawadv/) and [screensaver](../custom-screensaver/)
> patches, so all three apply cleanly together; CI checks this on every pull request and push to `main`.
> Don't commit built binaries over the bundled ones.

## What the patch does

[`led-v1.20.0.patch`](led-v1.20.0.patch) — against upstream **v1.20.0** (commit `511bb369`), touching
only `flipperLED.cpp`, the driver the CYD build uses for its LED. The LED is common-anode, so a pin driven
LOW lights it. On the CYD 2432S028 red is GPIO 4, green GPIO 16 and blue GPIO 17:

- **PWM instead of on/off** — every LED write goes through one `marauderSetRGB(r, g, b)` helper using
  `analogWrite`, so colours can be mixed. (On core 2.x a pin attached to PWM ignores `digitalWrite`, so the
  stock boot flash and scan colours are moved onto the same helper.) The helper remembers each channel's
  level and skips writes that change nothing, because on core 2.x every `analogWrite` call reconfigures
  the PWM timer.
- **Scan colours kept** — `sniffLED()`, `attackLED()` and `offLED()` record whether a scan is running.
  The custom colour shows only while idle, so the LED is blue for the whole of a sniff and red for the
  whole of an attack, and goes back to the idle colour as soon as the scan stops.
- **`flipperLED::main()`** — stock does nothing here; the patch checks the LED once per `LED_ALTERNATE_MS`
  tick (default `1000`): solid green when idle, or purple and green in turn when `LED_ALTERNATE` is `true`.
- **`EnableLED` setting is respected** — with the LED turned off in Marauder's Settings, it stays dark.
  The setting is checked each tick, so turning it off or on takes effect within a second.

<details>
<summary>Other boards that build this driver</summary>

`flipperLED.cpp` is used by every board that defines `HAS_FLIPPER_LED`, so the patch changes all of them,
not just the CYD. The pins come from upstream `configs.h`:

| Board define | Red | Green | Blue |
|---|---|---|---|
| `MARAUDER_CYD_MICRO`, `MARAUDER_CYD_2USB`, `MARAUDER_CYD_GUITION` | 4 | 16 | 17 |
| `MARAUDER_CYD_3_5_INCH` | 22 | 16 | 17 |
| `MARAUDER_FLIPPER`, `MARAUDER_MULTIBOARD_S3` | 6 | 5 | 4 |

Stock drives all of them active-low, and so does the patch. It has only been built and checked on
`MARAUDER_CYD_MICRO`.
</details>

### Purple needs a working red channel

Purple is **full red with dimmed blue** (`PURPLE_B = 64`): the blue die on this LED is far brighter than
the red, so full blue swamps the red. On some CYD boards the red channel is dead (a bad LED or joint).
The boot flash shows it: stock firmware lights blue, green, then red for half a second each, and if red
never appears, purple just shows as blue. That's why the default is solid green (`LED_ALTERNATE = false`).

### Tuning

Before building, at the top of `flipperLED.cpp`:

| Constant | Default | Effect |
|---|---|---|
| `LED_ALTERNATE` | `false` | `true` alternates purple and green; `false` holds solid green. |
| `LED_ALTERNATE_MS` | `1000` | Switch speed, and how often the `EnableLED` setting is checked. |
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
