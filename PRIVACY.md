# Privacy Policy

**Marauder Console** · Effective 1 November 2026

Marauder Console ("the app") is a program that runs entirely on your own computer. It serves a
local web UI and relays commands to an ESP32 running Marauder firmware over a USB serial port. It
has no accounts, no online servers, no analytics and no advertising. The author never receives any
information about you or your use of the app. The one exception to "nothing leaves your computer" is
the optional Claude assistant, which sends your chat to Anthropic when you use it (see below).

## What the app collects

Nothing is collected by or sent to the author. There is no telemetry, crash reporting or update
check.

## What stays on your computer

The app keeps its files in a data folder, `~/.local/share/marauder-console` by default (`$XDG_DATA_HOME`,
or `MARAUDER_CONSOLE_DATA_DIR` / `--data-dir` to move it). Nothing in it is sent anywhere.

| Where | What's in it |
|---|---|
| `sessions/` in the data folder | A transcript of every console session: each command sent and each line the board sent back, with start and end times and the serial port. These lines can include identifiers of **nearby networks and devices**. Delete the files to remove them. |
| `captures/` in the data folder (or `MARAUDER_CONSOLE_CAPTURES_DIR` / `--captures-dir`) | Only files you copy there yourself (PCAPs, wardrive CSVs, logs from the SD card). The app reads them to show summaries; it never changes or uploads them. |
| Your OS keychain (only if you use the assistant) | The Anthropic API key, if you enter one in the app, stored with `keyring` under `marauder-console`. It is never written to a file or a log, and never shown back in the UI. The `ANTHROPIC_API_KEY` environment variable is used instead if set. |
| The bridge's logs (standard output, or your user journal if you run it as a systemd service) | The lines the ESP32 sends back. During a scan these include identifiers of **nearby networks and devices** (for example access-point names and MAC addresses) that the board observes. |
| Your browser | Nothing is stored. The per-session "authorised" acknowledgement for transmitting tools lives only in the page's memory and is gone when you close or reload the tab. |

Files that the board itself writes (packet captures, wardrive logs, saved lists) are stored on the
**ESP32's own SD card**, not on your computer, unless you copy them off deliberately.

## The Claude assistant (optional)

The assistant is off until you give it an Anthropic API key. When you send it a message, the bridge sends
that message and the conversation so far to **Anthropic's API** (`api.anthropic.com`), together with what
the assistant asks to look at to answer you: the board's status, recent console output, the list of tools,
and summaries of files in your captures folder (packet summaries, up to 50 wardrive points). That can include
**nearby network names, MAC addresses and locations**. Anthropic handles it under its own terms and
[privacy policy](https://www.anthropic.com/legal/privacy); the author receives none of it. Don't use the
assistant if you don't want that data to leave your computer.

## Other connections

- `install.sh` downloads the app's Python and JavaScript dependencies from PyPI and npm.
- `scripts/flash-firmware.sh` installs `esptool` from PyPI into the app's venv the first time it needs it.
  The firmware itself is bundled, so flashing downloads nothing else.
- `scripts/verify-firmware-upstream.sh`, which you run by hand, downloads the upstream release from GitHub to
  compare checksums.

## What goes over your network, and to whom

By default the bridge listens only on `127.0.0.1` (localhost), so apart from the assistant nothing
leaves your computer: the browser, the bridge and the board all talk on the same machine, with the
board reached over USB serial.

- **Browser to bridge:** commands over local HTTP and a local WebSocket that streams the serial
  output. On localhost this traffic never touches the network.
- **Bridge to board:** over the USB serial cable, not the network.
- **If you expose the bridge yourself** (for example by binding it to a LAN address or putting it
  behind a reverse proxy), then it is reachable by other devices on that network. In that case use
  your own transport security and access control; the bridge speaks plain HTTP and has no built-in
  authentication. What you choose to expose, and how you protect it, is your responsibility.

The radio operations themselves (Wi-Fi and Bluetooth scanning and, for the active tools,
transmitting) happen on the ESP32, over the air. The app does not control or record what other
devices in range do with those signals.

## Children

The app doesn't collect personal information from anyone, including children.

## Downloading from GitHub

The source code is hosted on GitHub. Visiting or downloading from GitHub is covered by
[GitHub's Privacy Statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement),
not this policy.

## Changes

If the app's handling of data changes, this policy will be updated in the repository, with a new
effective date. Its history is visible in the repository's commits.

## Contact

Questions about this policy: open an issue on the project's GitHub repository.
