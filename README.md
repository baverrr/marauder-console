# Marauder Console

[![CI](https://github.com/baverrr/marauder-console/actions/workflows/ci.yml/badge.svg)](https://github.com/baverrr/marauder-console/actions/workflows/ci.yml)
[![CodeQL](https://github.com/baverrr/marauder-console/actions/workflows/codeql.yml/badge.svg)](https://github.com/baverrr/marauder-console/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

A local, self-hosted web UI (and Linux desktop app) for an **ESP32 running
[ESP32 Marauder](https://github.com/justcallmekoko/ESP32Marauder)** firmware: here a **Cheap Yellow Display**
(ESP32‑2432S028, 2.4 GHz Wi‑Fi + BLE, resistive touchscreen) wired to a Linux box over USB serial. It is an
annotated **reference** of every Marauder command and a **live control panel** that runs them on the board.

> [!TIP]
> **No board needed to start.** The command reference works with nothing plugged in, and
> `marauder-console --mock` runs the whole app, live console included, against a simulated board.

<p align="center">
  <img src="docs/images/reference.jpg" alt="Reference view: left category nav, a grid of tool cards each with syntax, summary and how-to, and passive/streaming badges" width="800">
</p>

Marauder has no built-in web server; its only interfaces are the device's touchscreen and a serial command
line. This project puts a modern UI in front of that serial CLI, running on your own machine. The only thing
that ever leaves it is the optional Claude assistant's chat, sent to Anthropic when you use that tab.

> [!IMPORTANT]
> **Authorised use only.** Marauder is a security-testing tool. Use it only on networks and devices you own
> or have explicit written permission to test, and stay within the law in your jurisdiction. The commands
> that **transmit** (deauth, beacon/probe, AP spoofing, BLE spam) are gated in the UI behind a per-session
> authorisation acknowledgement, and a permanent banner is shown at the top. This project is independent and
> is not affiliated with the Marauder project. Provided as is ([Terms](TERMS.md)).

## Contents

- [Quick start](#quick-start)
- [Features](#features)
- [Using it](#using-it): [the window](#the-window), [the command line](#the-command-line)
- [Setting up in detail](#setting-up-in-detail): [requirements](#requirements), [installer options](#installer-options),
  [serial port access](#serial-port-access), [configuration](#configuration), [network exposure](#network-exposure)
- [Hardware & accessories](#hardware--accessories), [bundled firmware](#bundled-firmware)
- [Desktop app](#desktop-app)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works), [project layout](#project-layout), [development](#development),
  [known limitations](#known-limitations)
- [Credits](#credits), [license & legal](#license--legal), [notes](#notes)

## Quick start

### 1. Install

Linux with **Python 3.11+** and **Node.js 18+** (for building the frontend). User-local, no root:

```bash
git clone https://github.com/baverrr/marauder-console.git
cd marauder-console
./install.sh            # add --service to keep the bridge running as a systemd user service
```

It creates a Python venv, installs the bridge's dependencies, builds the React frontend into `frontend/dist`,
and installs a `marauder-console` launcher in `~/.local/bin`. [Installer options](#installer-options).

### 2. Set up the board

Plug the ESP32 in (default `/dev/ttyUSB0`, 115200 baud). If opening the port fails, add yourself to the
`dialout` group, then log out and back in:

```bash
sudo usermod -aG dialout "$USER"
```

Board not running Marauder yet? Flash the bundled firmware (CYD only):
`bash scripts/flash-firmware.sh --port /dev/ttyUSB0`. [Details](#bundled-firmware).

### 3. Run

```bash
marauder-console          # or: marauder-console --mock   (no hardware)
```

This starts the bridge (if it isn't already up) and opens <http://127.0.0.1:8200>. Browse the tool map right
away; to use the control panel, click **Connect**.

## Features

**Reference and control**

- **Full annotated tool map:** Wi‑Fi recon, Wi‑Fi capture, Wi‑Fi active (transmit), Bluetooth/BLE, network
  probes and device/system commands, each with a summary, how-to and exact syntax. It tracks the device's
  own serial command set (firmware v1.20.0), including admin (channel, settings, reboot, firmware update),
  MAC randomise/clone, and the GPS tools (`gpsdata`, `nmea`, `gpspoi`, `gpstracker`, `geofence`).
- **One source of truth:** [`tools.ts`](frontend/src/tools.ts) drives *both* the reference docs and the Run
  controls, so they can never drift apart.
- **Live serial console:** streamed over a WebSocket, colour-coded, with autoscroll, a free-form command box
  and a **Stop** button wired to `stopscan`.
- **Safe streaming:** scans and sniffs (`scanall`, `sniff*`, `wardrive`, …) run until stopped; the UI tracks
  which command is running and shows Stop. It also surfaces "board busy", because the device's touchscreen
  and serial share state.
- **On-demand port ownership:** the bridge opens `/dev/ttyUSB0` only while you're *connected* and **releases
  it on Disconnect**, so your flashing script (or the board's own screen) can use the port the rest of the
  time. The port is single-consumer.

**PC-side analysis** (the **Analysis** tab, works with the board unplugged)

- **Session history:** every connect→disconnect span is saved locally as a transcript (commands + output)
  you can reopen and read offline.
- **Capture library + PCAP viewer:** browse `.pcap`/CSV/log files copied from the SD card, and get a
  read-only packet summary (frames, span, SSIDs and BSSIDs seen) from a dependency-free parser. Inspection
  only: no injection, nothing transmitted.
- **Wardrive map:** plots the located access points from a Wigle wardrive CSV on an offline, self-contained
  point map (coloured by signal strength, with per-point details). No map tiles are fetched, so your route
  is never sent anywhere; rows without a GPS fix are skipped.

**Claude assistant: advise and draft only** (the **Assistant** tab)

- Chat with Claude about commands, output and captures. It reads live status and your capture files
  (read-only) and *proposes* commands into a staging area; it never runs them. You review each one (with a
  **transmits** flag on anything that emits RF) and run it yourself through the normal authorisation. The
  assistant has no tool that can execute or transmit.
- Your Anthropic API key is stored in the OS keychain (set it in the tab), never in the repo or a log.

**Safety and hardware**

- **Authorisation gating:** transmitting (`active`) tools are disabled until you acknowledge, once per
  session, that you're authorised to test the target.
- **Hardware "Requires" badges:** tools that need an **SD card** (PCAP captures, `save`/`load`, wardrive
  logs) or a **GPS** module (`wardrive`, `wardrivepoi`, `foxhunt`, `gpsdata`/`nmea` location) are flagged,
  with a built-in **Hardware & setup** page.
- **Mock mode:** a simulated board (`--mock`) lets you run and develop the whole app, streaming included,
  with no hardware.
- **Desktop app and bundled firmware:** a native Tauri window with the bridge bundled, and the matching
  Marauder firmware with a verifying flasher. [Desktop app](#desktop-app), [firmware](#bundled-firmware).

<p align="center">
  <img src="docs/images/control.jpg" alt="Control view: a tool card with an editable command field and Run button, and the live serial console streaming scan output at the bottom" width="800">
</p>

<p align="center">
  <img src="docs/images/assistant.jpg" alt="Assistant view: the Claude panel with an API-key status bar, a chat pane, and a staging area of proposed commands — scanall with a Send button and 'attack -t deauth' flagged as transmitting with an Authorise button. Claude drafts commands; the human runs them." width="800">
</p>

## Using it

### The window

| Where | What it does |
|---|---|
| **Reference** tab | The tool map by category; each card shows syntax, summary and how-to. With the board connected, cards gain a **Run** control. |
| Top bar | Serial port (changeable per session before connecting), **Connect** / **Disconnect**, the authorised-use banner. |
| Console | Live output; type a raw command and press Enter; **Stop** sends `stopscan`. |
| **Analysis** tab | Session history, capture library + PCAP viewer, wardrive map. |
| **Assistant** tab | API key, chat, and the staging area of proposed commands (each run by you). |
| Tray menu (desktop app) | Connect board, Disconnect, Stop scan, Open bridge log, Show window, Quit. |

### The command line

```bash
marauder-console                     # start the bridge if needed, open http://127.0.0.1:8200
marauder-console --mock              # same, against a simulated board
./venv/bin/python bridge.py serve --serial-port /dev/ttyACM0 --port 8200   # run the bridge directly
bash scripts/flash-firmware.sh --port /dev/ttyUSB0 --dry-run              # check the board, write nothing
```

The launcher passes its arguments to `bridge.py serve` when it starts the bridge, so any
[bridge flag](#configuration) works with it.

## Setting up in detail

### Requirements

- Linux with **Python 3.11+** (CI tests 3.11–3.13) and **Node.js 18+** for building the frontend.
- An ESP32 running Marauder on a serial device (default `/dev/ttyUSB0`, 115200 baud), only for live control.
  Your user needs access to the port, usually via the `dialout` group.
- `curl` (the launcher uses it to check whether the bridge is up) and `xdg-open` to open the browser.

### Installer options

Run `./install.sh` from the checkout, wherever it lives; run it again after moving the checkout or pulling
new code.

| Option | What it adds |
|---|---|
| *(none)* | Python venv (`./venv`), bridge dependencies, `frontend/dist` build, `~/.local/bin/marauder-console` launcher. |
| `--service` | A systemd **user** service, `marauder-console.service`, that keeps the bridge running on `127.0.0.1:8200` (enabled and started). |
| `--skip-frontend` | Skips the frontend build, e.g. when a prebuilt `frontend/dist` is already there. Without npm the build is skipped anyway, with a note. |
| `--desktop` | Also builds and installs the [desktop app](#desktop-app) via `scripts/install-desktop.sh` (needs the Tauri toolchain). |

The checkout's path can't contain `"`, `$`, `` ` ``, `%` or `\` (it goes into the launcher and the unit file).

### Serial port access

If opening `/dev/ttyUSB0` fails, add yourself to the `dialout` group (then log out and back in):

```bash
sudo usermod -aG dialout "$USER"
```

The installer warns if the port exists and you're not in the group.

### Configuration

The bridge takes flags (see `bridge.py serve --help`):

| Flag | Default | Meaning |
|---|---|---|
| `--host` | `127.0.0.1` | Bind address for the UI (localhost by default). |
| `--port` | `8200` | HTTP/WebSocket port for the UI. |
| `--serial-port` | `/dev/ttyUSB0` | Default ESP32 serial device. |
| `--baud` | `115200` | Serial baud rate. |
| `--mock` | off | Simulate a board; no hardware needed. |
| `--data-dir` | `~/.local/share/marauder-console` | Where session transcripts are stored. |
| `--captures-dir` | `<data-dir>/captures` | Folder of capture/log files the Analysis tab browses. |

The serial port can also be changed per session in the top bar before connecting.

<details>
<summary>Environment variables</summary>

| Variable | Effect |
|---|---|
| `MARAUDER_MOCK=1` | Same as `--mock`. |
| `MARAUDER_CONSOLE_DATA_DIR` | Data directory, if `--data-dir` isn't given (else `$XDG_DATA_HOME/marauder-console`). |
| `MARAUDER_CONSOLE_CAPTURES_DIR` | Captures directory, if `--captures-dir` isn't given. |
| `ANTHROPIC_API_KEY` | Assistant key; checked before the OS keychain. |
| `MARAUDER_CONSOLE_CLAUDE_MODEL` | Model the assistant uses (default `claude-sonnet-5-5`). |
| `MARAUDER_CONSOLE_SERIAL_PORT` | Default port for the flasher and for the bridge the desktop app spawns. |
| `MARAUDER_CONSOLE_MOCK=1` | The desktop app spawns its bridge in mock mode. |
| `MARAUDER_BRIDGE_URL` | Desktop app: attach to this bridge instead of spawning one. |

</details>

### Network exposure

Nothing to open in a firewall: by default the bridge listens only on `127.0.0.1`. The bridge has **no
authentication**, so binding `--host` to anything other than `127.0.0.1`, `localhost` or `::1` lets anyone
who can reach it drive the board; it logs a warning when you do. The WebSocket also refuses connections
from other web origins.

## Hardware & accessories

The board is an ESP32‑WROOM (2.4 GHz only) with a built-in microSD slot and touchscreen. Two cheap add-ons
unlock most of the "Requires" tools:

| Add-on | Unlocks | Notes |
|---|---|---|
| **microSD card** | `.pcap` captures (`sniffraw`, `sniffpmkid`, `sniffsae`, `sniffpwn`), `save`/`load`, Wigle `wardrive` logs | 32 GB is ideal: 32 GB and under format as **FAT32** natively; 64 GB+ default to exFAT, which Marauder won't read. The slot is already on the CYD. |
| **UART GPS module** | Location for `wardrive`, `wardrivepoi`, `foxhunt` | e.g. u‑blox NEO‑6M / NEO‑M8N / BN‑220, wired to the exposed GPIO header. Without a fix, location fields stay empty. |
| LiPo battery + TP4056 | Portability for field use | Some CYD revisions have no onboard charger: check yours before wiring. |

**Not supported by Marauder** (don't chase these): 5 GHz Wi‑Fi (the radio is 2.4 GHz only), and sub‑GHz /
CC1101 / NRF24 (Flipper-Zero territory). BLE tools use the ESP32's built-in radio, no add-on needed.

The in-app **Hardware & setup** page covers all of this:

<p align="center">
  <img src="docs/images/hardware.jpg" alt="Hardware & setup page: cards for microSD card, UART GPS module, LiPo battery and external antenna, plus a 'not supported' list" width="800">
</p>

### Bundled firmware

The matching firmware is **bundled** (ESP32 Marauder `v1.20.0` for the Cheap Yellow Display,
ESP32‑2432S028), redistributed unmodified under its MIT license, so the board and the console ship together.
Disconnect in the console (or stop the service) first, then:

```bash
bash scripts/flash-firmware.sh --port /dev/ttyUSB0
```

The flasher verifies each file's `sha256`, won't run while the serial port is busy, does a read-only check
and asks for confirmation before writing. `--dry-run` checks the board without writing, `--yes` skips the
prompt, and `esptool` is installed into the venv on demand. `bash scripts/verify-firmware-upstream.sh`
re-checks over the network that the files are byte-identical to the upstream release. See
[`firmware/`](firmware/) (binaries, `manifest.json`, upstream license, other boards, updating) and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Desktop app

A native **desktop build**: a [Tauri](https://tauri.app/) window around this same UI, with the Python bridge
run as a sidecar (no browser, and no separate install for the bundle) and a tray menu. The web app keeps
working unchanged; the desktop build is additive.

Install it for your user (builds the release binary, adds a launcher and themed icon, and on KDE Plasma pins
it to the taskbar). It runs the bridge from this repo's `./venv`, so keep the repo in place:

```bash
bash scripts/setup-tauri-toolchain.sh     # once: Rust, webkit2gtk-4.1, PyInstaller (needs sudo for apt)
npm --prefix frontend install             # the Tauri CLI
bash scripts/install-desktop.sh           # or: ./install.sh --desktop
```

To build a distributable bundle instead (AppImage + `.deb`, with the Python bridge frozen in as a sidecar, so
no `./venv` is needed on the target machine):

```bash
bash scripts/build-bundle.sh
```

Pushing a `v*` tag runs [`release.yml`](.github/workflows/release.yml), which builds the bundle in CI and
attaches the `.deb`, the AppImage (best-effort) and a firmware + flasher zip to the GitHub release, so the
console and the matching ESP32 Marauder firmware ship together. The artifacts are built against
webkit2gtk-4.1, so they need a recent distro (Ubuntu 24.04+ or equivalent).

- Roadmap and phases: [`docs/DESKTOP_PLAN.md`](docs/DESKTOP_PLAN.md)
- Run modes and layout: [`docs/desktop-dev.md`](docs/desktop-dev.md)

## Troubleshooting

- **Can't open `/dev/ttyUSB0`:** join the `dialout` group (above), and make sure nothing else holds the port:
  it's single-consumer, so disconnect before flashing or using another serial tool.
- **Board busy:** the touchscreen and serial share state; finish or stop what's running on the device's
  screen, or press **Stop**.
- **SD card not seen:** 64 GB+ cards are exFAT by default; use 32 GB or smaller, FAT32.
- **`marauder-console: command not found`:** `~/.local/bin` isn't on your `PATH`; run
  `~/.local/bin/marauder-console`.
- **"Not Found" at `127.0.0.1:8200`:** the frontend wasn't built (npm was missing); install Node.js and re-run
  `./install.sh`.
- **Desktop app shows an old UI after an update:** re-run `bash scripts/install-desktop.sh`, which rebuilds
  the frontend and re-embeds it.

## How it works

All the radio work happens on the ESP32; the UI can't run any Marauder function on its own. So the two
layers are deliberately split:

- The **reference** is pure content (it renders from a single data file,
  [`frontend/src/tools.ts`](frontend/src/tools.ts)), so you can browse and learn the whole command set
  offline, before the board is ever plugged in.
- The **control panel** talks to a small Python **bridge** that owns the serial port and relays commands and
  output. Connect the board, and the same tool cards gain a **Run** control.

<p align="center">
  <img src="docs/architecture.svg" alt="Architecture: one React UI (browser tab or Tauri desktop window) talks to the loopback Python bridge over HTTP and WebSocket; the bridge owns the USB serial link to the ESP32, keeps session history and read-only capture analysis, and runs the assistant tool loop. The Claude assistant is the only outbound call (advise and draft only, key in the OS keychain); bundled firmware flashes the board via esptool. Reference and saved data work with no board." width="860">
</p>

```
Browser SPA ──HTTP (commands) + WebSocket (live serial)──▶ Python bridge ──pyserial──▶ ESP32 Marauder
```

<details>
<summary>Design details</summary>

| Concern | Approach |
|---|---|
| Serial ownership | The Python bridge is the single owner of the port. The browser never touches it. The port is opened on **Connect** and closed on **Disconnect**, keeping `/dev/ttyUSB0` free otherwise. |
| Live output | The bridge reads serial lines and fans them out to every connected browser over a WebSocket, with a short replay buffer (300 lines) for late joiners. |
| Commands | Sent over plain HTTP `POST /api/command` (`POST /api/stop` sends `stopscan`); the bridge also tracks running/stopped state for streaming commands. |
| Reference offline | The tool map is static data compiled into the frontend, so the docs render with the bridge disconnected (or no board at all). |
| Analysis | Sessions are saved under `<data-dir>/sessions/` (NDJSON transcript + JSON metadata). Captures are only read from the captures folder; a requested name is matched against the listing, never used to build a path. |
| Assistant | An Anthropic SDK tool-use loop with read-only tools plus one `propose_command` tool that only enqueues. No tool sends, runs, stops or transmits. |
| Mock board | `serial_source.MockSerialSource` fakes Marauder's `help`/`info` and streams generic placeholder lines for scan/sniff commands until `stopscan`. |

</details>

## Project layout

<details>
<summary>Files and folders</summary>

```
marauder-console/
├── bridge.py                 # FastAPI bridge: HTTP + WebSocket, owns the serial port
├── serial_source.py          # Real (pyserial-asyncio) and mock serial sources
├── session_store.py          # Session history (connect→disconnect transcripts)
├── capture_store.py          # Capture library (lists and summarises copied SD files)
├── pcap_reader.py            # Dependency-free pcap + radiotap + 802.11 parser
├── wigle_reader.py           # Wigle wardrive CSV → located points
├── assistant.py              # Proposal staging store (enqueue only) + transmit flagging
├── assistant_runner.py       # Claude tool-use loop and keychain key store
├── test_*.py, tests/fixtures/  # Tests (mock source, scrubbed fixtures)
├── requirements.txt, requirements-flash.txt, pyproject.toml
├── install.sh                # User-local installer (venv + frontend build + launcher)
├── packaging/                # Launcher, systemd --user service and .desktop templates
├── scripts/                  # Desktop install/bundle/sidecar, Tauri toolchain, firmware flash/verify
├── firmware/                 # Bundled ESP32 Marauder v1.20.0 for the CYD + manifest
├── src-tauri/                # Tauri (Rust) desktop shell
├── frontend/
│   └── src/
│       ├── tools.ts          # THE tool map — drives reference + control
│       ├── App.tsx
│       ├── lib/              # bridge client (HTTP+WS), command builder, sessions, captures, assistant
│       └── components/       # TopBar, CategoryNav, ToolCard, SerialConsole, HardwarePanel,
│                             # HistoryView, CapturesView, WardriveMapView, AssistantView, ui/
├── .github/workflows/        # CI, CodeQL, release bundle
└── docs/
    ├── architecture.svg, DESKTOP_PLAN.md, desktop-dev.md
    └── images/               # UI screenshots
```

</details>

## Development

Run the bridge and the Vite dev server separately (the dev server proxies `/api` and `/ws` to the bridge):

```bash
# terminal 1 — bridge (mock needs no hardware)
./venv/bin/python bridge.py serve --mock

# terminal 2 — frontend with hot reload
cd frontend && npm run dev
```

Run the tests (all against the mock serial source, no hardware), and the checks CI runs:

```bash
./venv/bin/python -m pytest
ruff check .                              # lint (pip install ruff)
cd frontend && npm run build              # typecheck + build
```

For the desktop shell in development (`npm --prefix frontend run tauri dev`), see
[`docs/desktop-dev.md`](docs/desktop-dev.md).

## Known limitations

- 2.4 GHz Wi‑Fi and BLE only; no 5 GHz or sub‑GHz (a limit of the board and Marauder).
- The serial port is single-consumer: while connected, nothing else (flasher, other tools) can use it.
- The bridge has no authentication; keep it on localhost.
- Bundled firmware is for the single-USB CYD (`cyd_2432S028`) only; other boards need their own images
  ([`firmware/`](firmware/)).
- Linux only. Release bundles need webkit2gtk-4.1 (Ubuntu 24.04+), and the AppImage build is best-effort.

## Credits

- **[ESP32 Marauder](https://github.com/justcallmekoko/ESP32Marauder) firmware** by
  [justcallmekoko](https://github.com/justcallmekoko): the upstream project this console is a client for.
  All of the Wi-Fi and Bluetooth functionality lives in that firmware, running on the ESP32; Marauder Console
  only sends it commands and shows its output.

Marauder Console is an independent interface and is not affiliated with, endorsed by, or supported by the
ESP32 Marauder project. "ESP32 Marauder" and related names belong to their respective owners.

## License & legal

- **License:** MIT, see [LICENSE](LICENSE). You may use, modify and redistribute the code under those terms.
- **Terms and Conditions:** [TERMS.md](TERMS.md): how you may operate the app, the **authorised-use** and
  legal-compliance requirements for a transmitting security tool, no-warranty and liability terms.
- **Privacy Policy:** [PRIVACY.md](PRIVACY.md): the app runs entirely on your own computer, collects nothing,
  and sends nothing to the author. Session transcripts are kept in `~/.local/share/marauder-console`. The optional assistant sends your chat (and the read-only context it
  looks up) to Anthropic with your own API key.
- **Third-party notices:** [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): the bundled ESP32 Marauder
  firmware (MIT) and the `esptool` flashing tool (GPL-2.0, installed on demand, not redistributed).

## Notes

- All example output, addresses and identifiers in the mock and the docs are **documentation placeholders**
  (RFC 5737 IPs like `192.0.2.x`, RFC 7042 MACs like `00:00:5e:00:53:xx`).
- Provided **as is**, for authorised security testing and education. You are responsible for how you use it;
  see the [Terms and Conditions](TERMS.md).
