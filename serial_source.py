"""Serial sources for the Marauder Console bridge.

The bridge never talks to a serial port directly; it talks to a *source* that exposes three async
operations — open, write a line, and yield incoming lines — plus close. Two implementations share that
interface:

* ``RealSerialSource`` wraps ``pyserial-asyncio-fast`` and owns ``/dev/ttyUSB0`` (or whatever port) only while
  it is open, so the user's flashing script can grab the port the moment the console disconnects.
* ``MockSerialSource`` fakes an ESP32 running Marauder v1.20.0. It answers ``help``/``info`` with canned
  text and, for streaming commands (``scanall``, ``sniff*``, ``wardrive`` …), emits a trickle of
  plausible-looking lines until ``stopscan`` arrives. It needs no hardware, so the whole bridge — command
  round-trips, streaming, and on-demand release — can be tested on any machine.

Nothing here parses attack output or targets anything; the mock only produces generic placeholder lines so
the UI can be exercised offline.
"""

from __future__ import annotations

import asyncio
import random
from collections.abc import AsyncIterator

DEFAULT_PORT = "/dev/ttyUSB0"
DEFAULT_BAUD = 115200

# Marauder prints this once per streaming scan is stopped; the bridge watches for the idea of it, but the
# UI drives stop/running state explicitly rather than scraping output.
STOP_COMMAND = "stopscan"


class SerialError(RuntimeError):
    """Raised when a port can't be opened or has gone away."""


class SerialSource:
    """Interface both the real and mock sources implement."""

    port: str
    baud: int

    async def open(self) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    async def close(self) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    async def write_line(self, line: str) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def lines(self) -> AsyncIterator[str]:  # pragma: no cover - interface
        raise NotImplementedError

    @property
    def is_open(self) -> bool:  # pragma: no cover - interface
        raise NotImplementedError


class RealSerialSource(SerialSource):
    """A real ESP32 over USB serial via pyserial-asyncio-fast (the maintained fork of pyserial-asyncio)."""

    def __init__(self, port: str = DEFAULT_PORT, baud: int = DEFAULT_BAUD) -> None:
        self.port = port
        self.baud = baud
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None

    @property
    def is_open(self) -> bool:
        return self._writer is not None

    async def open(self) -> None:
        if self.is_open:
            return
        try:
            import serial_asyncio_fast  # imported lazily so the mock works without the dependency
        except ImportError as exc:  # pragma: no cover - environment dependent
            raise SerialError(
                "pyserial-asyncio-fast isn't installed; run install.sh or pip install pyserial-asyncio-fast"
            ) from exc
        try:
            self._reader, self._writer = await serial_asyncio_fast.open_serial_connection(
                url=self.port, baudrate=self.baud
            )
        except Exception as exc:  # pyserial raises its own SerialException subtypes
            raise SerialError(f"Couldn't open {self.port}: {exc}") from exc

    async def close(self) -> None:
        writer, self._writer, self._reader = self._writer, None, None
        if writer is not None:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:  # noqa: BLE001 - closing a vanished port is fine
                pass

    async def write_line(self, line: str) -> None:
        if self._writer is None:
            raise SerialError("Port is closed")
        if "\r" in line or "\n" in line:
            # Last line of defence: one call must never turn into several commands on the board.
            raise SerialError("Command must be a single line")
        self._writer.write((line + "\r\n").encode())
        await self._writer.drain()

    async def lines(self) -> AsyncIterator[str]:
        if self._reader is None:
            raise SerialError("Port is closed")
        while self._reader is not None:
            try:
                raw = await self._reader.readline()
            except Exception as exc:  # noqa: BLE001 - device unplugged mid-read
                raise SerialError(f"Lost {self.port}: {exc}") from exc
            if not raw:  # EOF — device went away
                break
            yield raw.decode(errors="replace").rstrip("\r\n")


class MockSerialSource(SerialSource):
    """A fake Marauder board for offline development and tests.

    Writes are answered on an internal queue that ``lines()`` drains. Streaming commands keep a background
    task alive that emits a line every so often until ``stopscan`` (or close) stops it.
    """

    def __init__(
        self, port: str = "mock://marauder", baud: int = DEFAULT_BAUD, *, interval: float = 0.4
    ) -> None:
        self.port = port
        self.baud = baud
        self._interval = interval
        self._queue: asyncio.Queue[str] | None = None
        self._stream_task: asyncio.Task[None] | None = None
        self._open = False

    @property
    def is_open(self) -> bool:
        return self._open

    async def open(self) -> None:
        self._queue = asyncio.Queue()
        self._open = True
        self._emit(
            "[MOCK] Marauder console connected to a simulated board.",
            "[MOCK] This is fake output for offline development. Connect a real ESP32 for live results.",
        )

    async def close(self) -> None:
        self._open = False
        await self._stop_stream()
        self._queue = None

    def _emit(self, *lines: str) -> None:
        if self._queue is not None:
            for line in lines:
                self._queue.put_nowait(line)

    async def _stop_stream(self) -> None:
        task, self._stream_task = self._stream_task, None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def write_line(self, line: str) -> None:
        if not self._open:
            raise SerialError("Mock port is closed")
        command = line.strip()
        self._emit(f"> {command}")
        await self._respond(command)

    async def _respond(self, command: str) -> None:
        verb = command.split()[0].lower() if command else ""
        if verb == STOP_COMMAND:
            await self._stop_stream()
            self._emit("Stopping scan...", "> ")
            return
        if verb in _STATIC_RESPONSES:
            self._emit(*_STATIC_RESPONSES[verb])
            return
        if verb in _STREAMING_VERBS or command.startswith(("scan", "sniff", "wardrive")):
            await self._start_stream(command)
            return
        # Unknown command: Marauder echoes the help hint.
        self._emit(f"Unknown command: {command}", "Type 'help' for a list of commands.")

    async def _start_stream(self, command: str) -> None:
        await self._stop_stream()
        self._emit(f"Starting {command} ...", "Send 'stopscan' to stop.")
        self._stream_task = asyncio.create_task(self._stream(command))

    async def _stream(self, command: str) -> None:
        n = 0
        try:
            while True:
                await asyncio.sleep(self._interval)
                n += 1
                self._emit(*_fake_stream_lines(command, n))
        except asyncio.CancelledError:
            raise

    async def lines(self) -> AsyncIterator[str]:
        while self._open and self._queue is not None:
            try:
                # asyncio.timeout rather than wait_for, which on 3.11 can drop a cancel (and the line it got).
                async with asyncio.timeout(0.5):
                    line = await self._queue.get()
            except TimeoutError:
                continue
            yield line


# Canned, non-streaming replies. Deliberately generic — enough for the UI to show structure, nothing real.
_STATIC_RESPONSES: dict[str, list[str]] = {
    "help": [
        "Commands: help, info, scanall, sniffbeacon, sniffprobe, list, select, ssid, save, load,",
        "wardrive, sniffraw, sniffpmkid, sniffdeauth, sniffbt, blespam, pingscan, arpscan, portscan,",
        "join, brightness, stopscan, ... (see the reference panel for the full annotated set)",
    ],
    "info": [
        "ESP32 Marauder",
        "Firmware Version: v1.20.0 (MOCK)",
        "SD Card: Not present (mock)",
        "Free RAM: 120000 bytes (mock)",
    ],
    "list": [
        "0: SSID PlaceholderNet-A  [documentation placeholder]",
        "1: SSID PlaceholderNet-B  [documentation placeholder]",
        "2: SSID PlaceholderNet-C  [documentation placeholder]",
    ],
    "brightness": ["Brightness set (mock)."],
    "select": ["Selection updated (mock)."],
    "ssid": ["SSID list updated (mock)."],
    "save": ["Saved to SD (mock)."],
    "load": ["Loaded from SD (mock)."],
    "join": ["Joining network (mock)... got placeholder IP 192.0.2.50"],
    "channel": ["Current channel: 1 (mock)."],
    "clearlist": ["List cleared (mock)."],
    "settings": [
        "Settings (mock):",
        "  ForcePMKID: false",
        "  SavePCAP: true",
        "  (placeholder values — connect a real board for actual settings)",
    ],
    "reboot": ["Rebooting (mock)... reconnect when it comes back."],
    "update": ["Update not available in mock mode."],
    "ls": [
        "/ (mock SD):",
        "  SCANS/",
        "  wardrive_0.log",
        "  pmkid_0.pcap",
    ],
    "randapmac": ["AP MAC set to 00:00:5e:00:53:a1 (mock)."],
    "randstamac": ["Station MAC set to 00:00:5e:00:53:b2 (mock)."],
    "cloneapmac": ["AP MAC cloned from list (mock)."],
    "clonestamac": ["Station MAC cloned from list (mock)."],
    "gps": ["GPS (mock): no module attached; fields unavailable."],
    "gpspoi": ["GPS POI saved (mock)."],
    "gpstracker": ["GPS tracker command acknowledged (mock)."],
    "geofence": ["Geofences (mock): none set."],
    "recon": ["Recon mission (mock): idle."],
}

_STREAMING_VERBS = {
    "attack",
    "scanall",
    "sniffbeacon",
    "sniffprobe",
    "sniffmultissid",
    "sniffpinescan",
    "sniffraw",
    "sniffpmkid",
    "sniffsae",
    "sniffpwn",
    "sniffdeauth",
    "spoofat",
    "wardrive",
    "wardrivepoi",
    "sniffbt",
    "blespam",
    "findmy",
    "remoteid",
    "sniffskim",
    "pingscan",
    "arpscan",
    "portscan",
    "csimotion",
    "foxhunt",
    "packetcount",
    "mactrack",
    "evilportal",
    "karma",
    "gpsdata",
    "nmea",
}


def _fake_stream_lines(command: str, n: int) -> list[str]:
    """Lines emitted for one stream tick — usually one.

    When the command is a BLE scan with the custom firmware's ``-raw`` switch (``sniffbt … -raw`` or
    ``recon ble -raw``), the plain sighting line is paired with a synthetic ``RAWADV`` line carrying a
    full (fake) advertisement payload, so the Find My radar's raw-advert decoding can be exercised
    offline. Stock firmware never emits ``RAWADV``.
    """
    primary = _fake_stream_line(command, n)
    args = command.split()
    verb = args[0].lower() if args else ""
    if verb in {"sniffbt", "recon"} and "-raw" in args:
        # The plain line's format differs by mode, so pull the MAC and RSSI out by token rather than
        # assuming a fixed layout.
        tokens = primary.replace(",", " ").split()
        mac = next((t for t in tokens if t.count(":") == 5), None)
        rssi = next((t for t in tokens if t.startswith("-") and t[1:].isdigit()), None)
        if mac and rssi:
            return [primary, f"RAWADV {mac} {rssi} {_fake_adv_hex(n)}"]
    return [primary]


def _ad(ad_type: str, data_hex: str) -> str:
    """One GAP AD structure as hex: length (type + data) | type | data."""
    return f"{(len(data_hex) // 2 + 1):02x}{ad_type}{data_hex}"


def _fake_adv_hex(n: int) -> str:
    """A synthetic BLE advertisement payload as hex. Deterministic and entirely fabricated — no real
    captured advertisement data, so nothing device-identifying ever lands in the repo or tests.

    Cycles through representative device types so the Find My radar's decoding (status byte, battery,
    separated vs owner-nearby, vendor and service classification) is exercised offline."""
    flags = _ad("01", "06")  # Flags = LE General Discoverable + BR/EDR not supported
    kind = n % 6
    if kind == 0:
        # Apple Find My "offline finding", SEPARATED (carries a partial key). Vary the status byte so
        # battery level (top 2 bits) and the "maintained" bit (0x04) move across ticks.
        battery = n % 4  # 0 full … 3 critical
        maintained = 0x04 if (n // 4) % 2 else 0x00
        status = (battery << 6) | maintained
        key = bytes((n * 7 + i) & 0xFF for i in range(24)).hex()  # 24 bytes → value len 0x19 (separated)
        apple = f"12{(len(key) // 2 + 1):02x}{status:02x}{key}"  # type 0x12 | len | status | key
        return flags + _ad("ff", "4c00" + apple)
    if kind == 1:
        # Apple Find My, OWNER NEARBY (short payload: just a status byte, no key).
        apple = f"1202{(n % 4) << 6:02x}00"  # type 0x12 | len 0x02 | status | 1 byte
        return flags + _ad("ff", "4c00" + apple)
    if kind == 2:
        # Apple proximity pairing (AirPods / Beats): type 0x07.
        apple = "071901" + bytes((n + i) & 0xFF for i in range(24)).hex()[:48]
        return flags + _ad("ff", "4c00" + apple)
    if kind == 3:
        # Microsoft (0x0006) manufacturer data (e.g. Swift Pair), named device.
        name = f"Surface-{n:02d}".encode().hex()
        ms = "0600" + bytes((n * 3 + i) & 0xFF for i in range(6)).hex()
        return flags + _ad("ff", ms) + _ad("09", name)
    if kind == 4:
        # Apple iBeacon: manufacturer subtype 0x02, len 0x15 = UUID(16) + major(2) + minor(2) + TX(1).
        uuid = bytes((n * 5 + i) & 0xFF for i in range(16)).hex()
        apple = "0215" + uuid + f"{n % 65536:04x}" + f"{(n * 7) % 65536:04x}" + "c5"
        return flags + _ad("ff", "4c00" + apple)
    # A Tile tracker: 16-bit service UUID 0xFEED, named.
    name = f"Tile-{n:02d}".encode().hex()
    return flags + _ad("03", "edfe") + _ad("09", name)


def _fake_stream_line(command: str, n: int) -> str:
    """One line of generic simulated scan output. All addresses are documentation placeholders."""
    mac = f"00:00:5e:00:53:{(n % 256):02x}"  # RFC 7042 documentation MAC range
    rssi = -40 - random.randint(0, 50)
    verb = command.split()[0].lower()
    if verb.startswith("sniffbt"):
        # Real firmware prints a bare "<rssi> <mac>" for BLE sniffs like `sniffbt -t airtag` — match it
        # so the Find My radar sees representative lines in mock mode.
        return f"{rssi} {mac}"
    if verb == "recon":
        # General BLE recon ("recon ble"): a labelled sighting the Find My radar can parse for distance.
        return f"[{n:03d}] {mac}  RSSI {rssi}  name=ReconBLE-{n}"
    if verb in {"blespam", "findmy", "remoteid", "sniffskim", "spoofat"}:
        return f"[{n:03d}] BLE device {mac}  RSSI {rssi}  name=Placeholder-{n}"
    if verb in {"pingscan", "arpscan"}:
        return f"[{n:03d}] host 192.0.2.{n % 254 + 1} is up (mock)"
    if verb == "portscan":
        return f"[{n:03d}] 192.0.2.10:{1000 + n} open (mock)"
    if verb == "packetcount":
        return f"[{n:03d}] ch {n % 13 + 1}: {random.randint(0, 200)} pkts (mock)"
    if verb == "mactrack":
        return f"[{n:03d}] target {mac}  RSSI {rssi}  (mock)"
    if verb == "karma":
        return f"[{n:03d}] probe for Placeholder-SSID from {mac} (mock)"
    if verb == "evilportal":
        return f"[{n:03d}] client {mac} -> GET / (mock portal)"
    if verb == "gpsdata":
        return f"[{n:03d}] fix=none sats=0 lat=0.000000 lon=0.000000 (no module, mock)"
    if verb == "nmea":
        return "$GPGGA,000000.00,,,,,0,00,99.99,,,,,,*00 (mock)"
    if verb.startswith("wardrive"):
        return f"[{n:03d}] AP {mac}  ch {n % 13 + 1}  RSSI {rssi}  GPS 0.0,0.0 (no fix, mock)"
    return f"[{n:03d}] AP/packet {mac}  ch {n % 13 + 1}  RSSI {rssi}  (mock)"
