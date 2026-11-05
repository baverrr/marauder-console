# Desktop app — development & run modes

Marauder Console is growing a **native desktop build** (a Tauri window around the existing React UI, with
the FastAPI bridge running as a bundled sidecar). The full roadmap is in
[`DESKTOP_PLAN.md`](DESKTOP_PLAN.md). This file is the practical reference for how the pieces fit and how
to run them during development.

The web app keeps working exactly as before — the desktop build is additive.

## Planned repo layout

```
marauder-console/
├── bridge.py, serial_source.py      # Python bridge (unchanged) — the sole serial-port owner
├── frontend/                        # React/Vite UI (unchanged) — reused by the desktop window
├── src-tauri/                       # Tauri (Rust) shell            [added in Phase 1]
│   ├── tauri.conf.json              #   points at frontend/dist, declares the sidecar
│   ├── src/                         #   spawn/supervise sidecar, native menus/tray, key store
│   └── binaries/                    #   PyInstaller-built bridge sidecar (git-ignored)
├── packaging/                       # existing web/systemd installers (unchanged)
└── docs/
    ├── DESKTOP_PLAN.md
    └── desktop-dev.md               # this file
```

## Three run modes

| Mode | How | When |
|---|---|---|
| **1. Web-only** (today) | `marauder-console` (or `bridge.py serve [--mock]`) → browser at `127.0.0.1:8200` | Unchanged. Browse the reference, or control a board from any browser. |
| **2. Sidecar-dev** | Run the bridge yourself (`./venv/bin/python bridge.py serve --mock`), then `cargo tauri dev` for a hot-reloading native window pointed at the running bridge | Day-to-day desktop development. The Tauri shell attaches to an already-running bridge instead of spawning its own. |
| **3. Packaged** | `cargo tauri build` → AppImage/`.deb`. The app spawns the **bundled** bridge sidecar on `127.0.0.1` (random free port), health-checks it, and stops it on quit | What ships to users. No separate install, no browser. |

In sidecar-dev, if no bridge is already listening the shell falls back to spawning one, so `cargo tauri
dev` alone still works once Phase 1 lands.

## Invariants (keep true in every phase)

- The **bridge is the only owner of the serial port** — opened on Connect, released on Disconnect. The
  UI, the Tauri shell, and (later) the Claude assistant never touch the port directly.
- `frontend/src/tools.ts` stays the **single source of truth** for both the reference docs and the Run
  controls.
- **Mock mode works with no hardware** in every run mode, so the whole app stays testable offline.
- Transmit/`active` tools stay gated behind the per-session authorization acknowledgement.

## Running it today (Phase 1)

Prerequisites once per machine: `bash scripts/setup-tauri-toolchain.sh` (Rust + webkit2gtk-4.1 + PyInstaller),
then `npm --prefix frontend install` (pulls the Tauri CLI).

```bash
# Sidecar-dev: hot-reloading native window, bridge from ./venv (mock = no hardware)
./venv/bin/python bridge.py serve --mock --port 8200   # terminal 1 (optional; the shell can spawn it too)
npm --prefix frontend run tauri dev                     # terminal 2

# Or a production-like run against the built frontend (no dev server, no CLI needed):
npm --prefix frontend run build
MARAUDER_CONSOLE_MOCK=1 cargo run --manifest-path src-tauri/Cargo.toml
```

How the shell finds the bridge, in order: `MARAUDER_BRIDGE_URL` → a bundled `marauder-bridge` sidecar next
to the app binary → `./venv` from the source tree (dev) → `http://127.0.0.1:8200`. Env knobs when the shell
spawns it: `MARAUDER_CONSOLE_MOCK=1`, `MARAUDER_CONSOLE_SERIAL_PORT=/dev/ttyUSBx`. The resolved URL is
injected into the web UI as `window.__MARAUDER_BRIDGE_URL__` before the page loads. `MARAUDER_BRIDGE_URL` must be
a loopback address (`http://127.0.0.1:<port>` or `http://localhost:<port>`), because the window's content
security policy only allows connections there; any other value is ignored with a warning on stderr. To use
the app against a bridge on another machine, open its web UI in a browser instead (see *Behind a reverse
proxy* in the README).

Packaging the sidecar (not needed for dev): `bash scripts/build-sidecar.sh` builds
`src-tauri/binaries/marauder-bridge-<triple>`; then add `"externalBin": ["binaries/marauder-bridge"]` to
the `bundle` object in `tauri.conf.json` so `tauri build` ships it.

## Install as a desktop app (current machine)

Until the Phase 5 AppImage/`.deb` bundle lands, `scripts/install-desktop.sh` installs the app for the
current user: it builds the release binary, installs a launcher and a themed icon (named
`marauder-console` under `hicolor`, so it follows the active icon theme), and on KDE Plasma pins it to the
task manager. User-local, no sudo, re-runnable.

```bash
bash scripts/install-desktop.sh
```

The launcher runs the bridge from this repo's `./venv`, so keep the repo in place (re-run the script after
moving it). The matching board firmware is **Phase 6** — see [`DESKTOP_PLAN.md`](DESKTOP_PLAN.md) — which
will bundle the ESP32 Marauder firmware + flashing so the console and firmware ship together.

## Status

- **Phase 0:** groundwork — layout, run-mode docs, reserved ignores, README pointer.
- **Phase 1 (this change):** Tauri v2 shell in `src-tauri/` that resolves/spawns the bridge, health-checks
  it, injects the bridge URL, and adds a tray menu (Connect/Disconnect/Stop/Open log/Show/Quit);
  bridge gains CORS for the webview origin; frontend targets the injected URL; PyInstaller sidecar script.
- **Phase 2:** expanded the `tools.ts` command set to track the device's full serial CLI — admin
  (channel/settings/reboot/update), MAC randomise/clone, evil portal, karma, SAE/CSA/rickroll beacon
  variants, packet count, MAC track, and the GPS tools; corrected `spoofat` (a BLE device spoof, not a
  Wi-Fi AP spoof); and extended the mock so the new streaming/static commands round-trip offline.
- **Phase 3 (in progress, delivered in slices):** PC-side analysis under a new **Analysis** tab.
  - *Slice 1 (this change):* session history — the bridge records each connect→disconnect span to
    `<data-dir>/sessions/` (NDJSON transcript + JSON metadata) via `session_store.py`, served by
    `GET /api/sessions` and `/api/sessions/{id}`; the UI browses them offline. Data dir resolves from
    `MARAUDER_CONSOLE_DATA_DIR`, else the XDG data home.
  - *Slice 2:* capture library + PCAP viewer — `capture_store.py` lists `.pcap`/CSV/log files in a
    captures dir (`MARAUDER_CONSOLE_CAPTURES_DIR`, else `<data-dir>/captures`), and `pcap_reader.py` is a
    dependency-free classic-pcap + radiotap + 802.11 parser that summarises a capture (frames, span,
    SSIDs/BSSIDs). Served by `GET /api/captures` and `/api/captures/{name}/summary`; a requested name is
    matched against the listing, never used to build the opened path. Scrubbed fixtures live in
    `tests/fixtures/` (documentation MACs only).
  - *Slice 3:* wardrive map — `wigle_reader.py` parses a Wigle wardrive CSV into located points (rows
    with no GPS fix dropped), served by `GET /api/captures/{name}/wardrive`; `WardriveMapView` plots them
    as a dependency-free, fully-offline SVG point map (no external tiles, so the route is never sent off
    the machine). This completes the Phase 3 analysis tools.
- **Phase 4 (in progress, delivered in slices):** the Claude assistant — advise/draft only, under an
  **Assistant** tab.
  - *Slice 1 (this change):* the proposal staging area. `assistant.py` holds a `ProposalStore` (enqueue
    only — there is no path from it to the serial port) and `command_transmits()` to flag RF-emitting
    commands; endpoints `GET/POST/DELETE /api/assistant/proposals`. `AssistantView` lists proposed
    commands; running one is a separate, explicit step through the normal Run control, and transmitting
    commands still need the per-session authorisation. Tests pin the invariant: proposing never executes.
  - *Slice 2:* the chat loop. `assistant_runner.py` runs an Anthropic SDK tool-use loop with a **scoped**
    toolset — read-only tools (`get_status`, `tail_console`, `list_tools`, `list_captures`,
    `summarize_pcap`, `wardrive_points`) plus the one draft tool `propose_command` that enqueues into the
    slice-1 store. There is no tool that sends/runs/stops/transmits, so the model cannot touch the serial
    port. `POST /api/assistant/chat` runs it; the API key lives in the OS keychain via `keyring`
    (`GET/POST/DELETE /api/assistant/key`, which never return the value). The command catalogue for
    `list_tools` is passed in from the UI (`tools.ts`), so the backend doesn't duplicate it. The runtime
    is the Anthropic SDK tool-runner rather than the Agent SDK — lighter to bundle in the sidecar and
    gives tighter control over the tool surface. Tests pin the no-execute invariant with a fake client.
- **Phase 5 (in progress):** packaging. `scripts/build-sidecar.sh` freezes the bridge (with the new
  `anthropic`/`keyring` deps) into a one-file sidecar; `scripts/build-bundle.sh` builds the AppImage +
  `.deb` via `tauri build --config src-tauri/tauri.bundle.conf.json` (the overlay carries `externalBin`
  so a plain `cargo build`/`tauri dev` still works without a prebuilt sidecar). `.github/workflows/release.yml`
  does this on a `v*` tag and attaches the AppImage, `.deb` and a firmware+flasher zip to the release.
  `./install.sh --desktop` wires the same desktop install for the current user. The README now carries a
  Claude-panel screenshot and a refreshed `docs/architecture.svg` (desktop shell, Analysis tabs, the
  assistant→Anthropic path, and firmware flashing), which completes Phase 5.
