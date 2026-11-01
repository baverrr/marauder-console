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

## Status

- **Phase 0 (this change):** groundwork — layout decision, run-mode docs, reserved build-artifact
  ignores, README pointer. No behavior change.
- Phase 1 onward: see [`DESKTOP_PLAN.md`](DESKTOP_PLAN.md).
