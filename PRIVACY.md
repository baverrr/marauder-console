# Privacy Policy

**Marauder Console** · Effective 1 November 2026

Marauder Console ("the app") is a program that runs entirely on your own computer. It serves a
local web UI and relays commands to an ESP32 running Marauder firmware over a USB serial port. It
has no accounts, no online servers, no analytics and no advertising. The author never receives any
information about you or your use of the app.

## What the app collects

Nothing is collected or sent to the author or anyone else. There is no telemetry, crash reporting
or update check.

## What stays on your computer

The app itself writes no configuration or data files to your home folder. Two things are worth
knowing:

| Where | What's in it |
|---|---|
| The bridge's logs (standard output, or your user journal if you run it as a systemd service) | The lines the ESP32 sends back. During a scan these include identifiers of **nearby networks and devices** (for example access-point names and MAC addresses) that the board observes. |
| Your browser | Nothing is stored. The per-session "authorised" acknowledgement for transmitting tools lives only in the page's memory and is gone when you close or reload the tab. |

Files that the board itself writes (packet captures, wardrive logs, saved lists) are stored on the
**ESP32's own SD card**, not on your computer, unless you copy them off deliberately.

## What goes over your network, and to whom

By default the bridge listens only on `127.0.0.1` (localhost): the browser, the bridge and the board all
talk on the same machine, with the board reached over USB serial. Almost nothing leaves your computer —
the one exception is the **Camera scan**, which reaches onto your local network only when you run it
(see below).

- **Browser to bridge:** commands over local HTTP and a local WebSocket that streams the serial
  output. On localhost this traffic never touches the network.
- **Bridge to board:** over the USB serial cable, not the network.
- **Camera scan (only when you run it):** the **Camera scan** under Analysis is the one feature that
  deliberately sends traffic onto your local network — a multicast ONVIF/mDNS discovery and brief
  connections to known camera ports — to find IP cameras. It runs only when you press **Scan my
  network**, the probes stay on your LAN, and it sends nothing to any outside service.
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
