# Marauder Console → Desktop app + Claude assistant + expanded tools

Execution plan for turning the current **Marauder Console** (browser SPA + FastAPI serial bridge) into a
**PC-sided desktop application** with a **Claude-enabled planning interface** and an **expanded toolset**.

This is an evolution of the existing repo, not a rewrite. The `tools.ts` single-source-of-truth model,
the serial bridge, mock mode, and authorization gating all stay — we wrap, extend, and add to them.

---

## 1. Decisions (locked)

| Area | Choice |
|---|---|
| **Desktop shell** | **Tauri** (Rust) window around the existing React UI; the FastAPI bridge ships as a **Python sidecar** (PyInstaller one-file binary Tauri spawns and supervises). |
| **Claude scope** | **Advise + draft, human runs.** Claude explains commands, plans an engagement, interprets console/scan output, and drafts exact command sequences. It **never executes** a command — especially never a transmit/active one. Execution stays a human click through the existing control panel + auth ack. |
| **Claude backend** | **Claude Agent SDK**, configured so Marauder command tools are *draft/stage* tools (they enqueue a proposed command), while only read-only tools (status, console tail, pcap summary, wardrive points, SD listing) actually run. |
| **Expanded tools** | (a) **More device commands** — cover the rest of the Marauder serial command set, `tools.ts` stays the single source of truth; (b) **PC-side analysis** — PCAP viewer, wardrive map, capture/log library off the SD card, session history. |
| **Dev workflow** | **PR per phase.** One feature branch per phase off `main`, opened as a PR early (draft), CI + CodeQL green before merge, `ccd_pr` for status and Auto-fix. |

---

## 2. Target architecture

```
┌─────────────────────────── Tauri window (Rust) ───────────────────────────┐
│  React UI (existing)                                                       │
│   ├─ Reference view          ├─ Control panel         ├─ Claude panel (new)│
│   ├─ PCAP viewer (new)       ├─ Wardrive map (new)     └─ Capture library  │
│                                                                            │
│  Rust side: spawn/supervise sidecar, native menus/tray, secure key store, │
│             file dialogs, deep-link to SD-pulled files                     │
└───────────────┬───────────────────────────────────────────┬──────────────┘
                │ HTTP + WebSocket (localhost, existing)      │ Tauri IPC (new)
                ▼                                             ▼
   ┌─────────────────────────────┐              ┌───────────────────────────┐
   │ FastAPI bridge (sidecar)    │              │ Claude Agent SDK runner    │
   │  owns serial port           │              │  read-only tools: status,  │
   │  + new: analysis endpoints  │◀─ read-only ─│  console tail, pcap summary│
   │  (pcap parse, SD pull, logs)│   tool calls │  draft tool: stage command │
   └──────────────┬──────────────┘              └───────────────────────────┘
                  │ pyserial-asyncio
                  ▼
            ESP32 Marauder (USB serial)
```

Key property preserved: **the bridge is the only owner of the serial port**, opened on Connect and
released on Disconnect. Claude reaches the device only through the bridge's read-only endpoints and the
draft queue — it has no direct serial access.

---

## 3. Phased delivery (one PR per phase)

### Phase 0 — Groundwork (branch `desktop/phase-0-groundwork`)
- Add this plan to `docs/`.
- Decide repo layout for the desktop shell: `src-tauri/` at repo root; keep `frontend/` and the Python
  bridge where they are.
- Introduce a `desktop` dev script and document the three run modes (web-only, sidecar-dev, packaged).
- No behavior change to the existing web app — it must keep working standalone.

### Phase 1 — Tauri shell + Python sidecar (branch `desktop/phase-1-tauri-shell`)
- Scaffold Tauri (`src-tauri/`), point it at the built `frontend/dist`.
- Package the bridge with **PyInstaller** into a one-file binary; register it as a Tauri **sidecar**.
- Tauri spawns the sidecar on launch (bound to `127.0.0.1`, random free port passed to the UI), health-checks
  it, and kills it on window close. Fall back to an already-running bridge in dev.
- Native menu + tray: Connect/Disconnect, open logs, quit. Port picker wired to existing bridge flags.
- **Acceptance:** `cargo tauri dev` launches a native window; mock mode works end-to-end with no browser.

### Phase 2 — Expanded device commands (branch `desktop/phase-2-commands`)
- Audit the current 52 tools against Marauder's full serial command set (use the device's own `help`
  output as the final word, as the repo already notes).
- Add the missing commands to `tools.ts` with the same discipline: high-level summary + how-to + exact
  syntax, `passive`/`active` class, `requires` hardware badges, streaming/stop metadata. **No targeting or
  evasion playbooks** — keep summaries at the "what it's for" level, matching the existing file's rule.
- Extend the mock serial source so new streaming commands have plausible canned output for offline dev/tests.
- **Acceptance:** new tools render in Reference + Control; mock round-trips covered by `test_bridge.py`.

### Phase 3 — PC-side analysis tools (branch `desktop/phase-3-analysis`)
- **Capture/log library:** bridge endpoint to list + pull files off the board's SD card over serial
  (`ls`/`save`/existing SD commands); Tauri saves them to a local app-data dir. UI: a browsable library.
- **PCAP viewer:** parse pulled `.pcap` (scapy or dpkt) into a packet summary table (frames, SSIDs seen,
  BSSIDs, timestamps) — read-only inspection, no injection. Served by a new bridge endpoint.
- **Wardrive map:** render Wigle-format wardrive CSV logs as points on an offline/tiled map
  (MapLibre GL + local tiles, or Leaflet). GPS fix required on-device, as today.
- **Session history:** persist console sessions (command + output transcripts) locally for later review.
- **Acceptance:** each analysis view works against sample files committed as fixtures (scrubbed of real
  BSSIDs/MACs — use the documentation MAC range `00:00:5e:00:53:xx`).

### Phase 4 — Claude assistant panel (branch `desktop/phase-4-claude`)
- New **Claude panel** in the UI (chat + a "proposed commands" staging area).
- Backend: a **Claude Agent SDK** runner (its own module/process the bridge or Tauri launches), with a
  tightly scoped toolset:
  - **Read-only tools** (auto-run): `get_status`, `tail_console(n)`, `list_tools()` (from `tools.ts`),
    `summarize_pcap(file)`, `list_captures()`, `wardrive_points(file)`.
  - **Draft tool** (does *not* execute): `propose_command(text, rationale)` → pushes into the staging
    area. The human reviews, and runs it with the existing Run button; active/transmit commands still hit
    the per-session auth ack.
- System prompt encodes the house rules: authorized-use only, advise/explain/plan/interpret, draft exact
  syntax, **never claim to have run anything**, flag when a proposed command transmits.
- API key stored via the OS keychain through Tauri (never written to the repo, never logged). Settings UI
  to paste/clear it.
- **Acceptance:** Claude can read live console output and propose a correct command that lands in staging;
  no code path lets it execute a command. A test asserts the command tool only enqueues.

### Phase 5 — Packaging, CI, docs (branch `desktop/phase-5-package`)
- Build artifacts: AppImage + `.deb` via `tauri build` (Linux first, matching the current target).
- CI: extend `.github/workflows` to build the sidecar + Tauri bundle on tags; keep existing lint
  (ruff), type (pyright), pytest, and CodeQL jobs green. Front-end typecheck/build in CI too.
- Update `README.md`: new desktop install path, Claude panel (with a screenshot), expanded tool
  categories, analysis views, and architecture diagram refresh (`docs/architecture.svg`).
- `install.sh` gains a desktop-build path alongside the existing web/service install.

### Phase 6 — Bundled firmware & complete packaged build (branch `desktop/phase-6-firmware`)
Rationale: the console and the board's firmware are almost always used together, so ship them together —
one download that can flash a known-good, matching firmware and then drive it, with everything it needs on
a clean machine, fully offline.

> **Status:** 6a (vendored firmware) and 6b (flashing helper) are **implemented** for the
> `cyd_2432S028` board — `firmware/` holds the v1.20.0 payload + `manifest.json` + upstream MIT license,
> and `scripts/flash-firmware.sh` flashes it with esptool. 6c (host prereqs) and 6d (one combined
> release + release CI) remain.

**6a. Vendor the upstream firmware, pinned and attributed.**
- A `firmware/` area holding the prebuilt ESP32 Marauder release `.bin` for this board's target (Cheap
  Yellow Display / ESP32-2432S028), the upstream **flashing scripts and docs**, and a `manifest.json`
  recording the exact upstream tag, commit, and the `sha256` of each `.bin`, plus a board-target table so
  other boards can pick the right image.
- Pull it in as a git submodule pinned to a release tag, or a vendored copy under that tag — never an
  unpinned `master`.
- **Licensing is a gate, not an afterthought:** confirm the upstream license permits redistribution;
  include upstream's `LICENSE`/`NOTICE` unmodified next to the binaries; redistribute the firmware
  unmodified; keep the existing "independent, unaffiliated" credit; and add a top-level
  `THIRD_PARTY_NOTICES` listing the firmware and every other bundled third-party asset. If the license
  disallows bundling the binary, fall back to a **fetch-at-install** step that downloads the pinned
  release (verifying the manifest `sha256`) instead of committing it. Large binaries may want Git LFS or
  a release-time fetch rather than living in the tree.

**6b. Flashing helper.** A guided "Flash firmware" action (script first, UI later) that runs `esptool`
against the chosen serial port with the bundled `.bin`. It must honour the serial-port ownership
invariant — the bridge disconnects / releases the port before flashing, and nothing flashes while a
session is connected. It reads the chip id first (dry-run/verify), is an explicit, confirmed action
(never automatic), and records the flashed version so the app can later flag a firmware/reference
mismatch.

**6c. Host prerequisites for a clean machine.**
- **USB-serial access:** ship a documented `udev` rule (and/or `dialout`-group guidance) so `/dev/ttyUSB0`
  is usable without root; the installer offers to set it up — the one step that needs `sudo`, run by the
  user, never silently.
- **Driver notes** for the common CYD USB-serial chips (CP210x / CH340).
- **Version alignment:** record the firmware version that `frontend/src/tools.ts`'s command map targets,
  so the bundled firmware and the in-app reference match; surface a mismatch (from `info`/`help`) in the UI.

**6d. One combined, offline release.**
- A single versioned release artifact: the Phase 5 AppImage/`.deb` (with the bundled Python sidecar) +
  the firmware payload (or fetch manifest) + the flashing helper + docs, so the installed app offers the
  matching firmware out of the box.
- `SHA256SUMS` for every artifact and, if a signing key is available, a detached signature.
- Works **offline** end to end (no external calls at runtime), matching the privacy stance; the optional
  offline map-tile set (Phase 3) can ride along for a fully-offline bundle.
- **Release CI** (on tag): build the desktop bundle, assemble the firmware payload, generate `SHA256SUMS`
  and `THIRD_PARTY_NOTICES`, and attach them to a GitHub Release; the existing ruff / pyright / pytest /
  CodeQL / frontend jobs stay green. No personal data in artifacts, release notes, or embedded paths
  (the launcher/installer derive paths at runtime, per Phase 5).

**Acceptance:** from a clean machine, one documented, reproducible path installs the app and flashes the
matching firmware onto the board using only what ships in the release, fully offline, with upstream
license + attribution intact and checksums verifiable.

---

## 4. Safety & authorization model (unchanged intent, extended)

- Transmit/`active` tools remain gated behind the per-session authorization acknowledgement and the
  permanent banner.
- Claude is **advisory**: it may draft any command but execute none; transmit commands it proposes are
  labelled as transmitting in the staging area.
- The bridge stays the sole serial owner; the Agent SDK runner gets only read-only + draft tools.
- PCAP/wardrive features are **read-only inspection** of captures you made — no injection, no replay.

---

## 5. Privacy & push hygiene (per your global rules)

Enforced on **every** push/PR in this project:
- Git identity is `baverrr <342259467+baverrr@users.noreply.github.com>` — checked before each commit.
- No personal data in commits, PRs, code, tests, docs, or screenshots: real name/email, the home LAN
  subnet, the ISP IPv6 prefix, or any real MAC/IP. Fixtures and screenshots use documentation ranges
  (`192.0.2.x`, `00:00:5e:00:53:xx`) and scrubbed captures.
- The Anthropic API key lives in the OS keychain only — never in a file, log, commit, or this repo.
- README updated in the same push as the feature it documents.
- Pre-push scan of outgoing commits' `%an %ae %cn %ce`, messages, and diff for the items above.

---

## 6. PR toolkit workflow (throughout)

For each phase: branch → open a **draft PR early** → bind it with `ccd_pr` (`get_status`, `bind_pr`) →
read CI, offer **Auto-fix** on failures → mark ready → merge when CI + CodeQL are green. No auto-merge
unless you ask. Base each new phase branch on the merged `main`.

---

## 7. Open questions / risks

- **Sidecar packaging:** PyInstaller + pyserial-asyncio + scapy can be finicky to bundle; Phase 1 proves
  the sidecar path before we lean on it.
- **Agent SDK runtime:** confirm how it's hosted (child process vs in-bridge) and how the API key is
  passed without touching disk — settled at the start of Phase 4.
- **Map tiles offline:** bundling tiles bloats the installer; may ship with a configurable tile URL and a
  small offline set for your area.
- **Full command list:** final scope of Phase 2 depends on your firmware version's `help` output.
