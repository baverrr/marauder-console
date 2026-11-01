# Third-party notices

Marauder Console bundles the following third-party material. Each is used under its own license; this
project is an independent interface and is not affiliated with or endorsed by these projects.

## ESP32 Marauder firmware (bundled binaries)

- **Project:** ESP32 Marauder — https://github.com/justcallmekoko/ESP32Marauder
- **Author:** justcallmekoko
- **License:** MIT (Copyright (c) 2020 Just Call Me Koko)
- **What is bundled:** the prebuilt firmware for the Cheap Yellow Display (ESP32-2432S028), release
  `v1.20.0`, redistributed **unmodified**, under [`firmware/`](firmware/). The full license text ships
  alongside the binaries at [`firmware/UPSTREAM-LICENSE.txt`](firmware/UPSTREAM-LICENSE.txt), and
  [`firmware/manifest.json`](firmware/manifest.json) records the exact upstream tag, commit and the
  `sha256` of every file.

## esptool (flashing tool, not bundled)

- **Project:** esptool — https://github.com/espressif/esptool
- **License:** GPL-2.0-or-later
- **How it is used:** invoked as an external tool by `scripts/flash-firmware.sh` to write the firmware to
  the board. It is installed into the project virtualenv on demand (see `requirements-flash.txt`); its
  source is not redistributed here.
