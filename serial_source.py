"""Serial sources for the Marauder Console bridge.

The bridge never talks to a serial port directly; it talks to a *source* that exposes three async
operations — open, write a line, and yield incoming lines — plus close. Two implementations share that
interface:

* ``RealSerialSource`` wraps ``pyserial-asyncio`` and owns ``/dev/ttyUSB0`` (or whatever port) only while
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
    """A real ESP32 over USB serial via pyserial-asyncio."""

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
            import serial_asyncio  # imported lazily so the mock works without the dependency
        except ImportError as exc:  # pragma: no cover - environment dependent
            raise SerialError(
                "pyserial-asyncio isn't installed; run install.sh or pip install pyserial-asyncio"
            ) from exc
        try:
            self._reader, self._writer = await serial_asyncio.open_serial_connection(
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
                self._emit(_fake_stream_line(command, n))
        except asyncio.CancelledError:
            raise

    async def lines(self) -> AsyncIterator[str]:
        while self._open and self._queue is not None:
            try:
                line = await asyncio.wait_for(self._queue.get(), timeout=0.5)
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
}


def _fake_stream_line(command: str, n: int) -> str:
    """One line of generic simulated scan output. All addresses are documentation placeholders."""
    mac = f"00:00:5e:00:53:{(n % 256):02x}"  # RFC 7042 documentation MAC range
    rssi = -40 - random.randint(0, 50)
    verb = command.split()[0].lower()
    if verb.startswith("sniffbt") or verb in {"blespam", "findmy", "remoteid", "sniffskim"}:
        return f"[{n:03d}] BLE device {mac}  RSSI {rssi}  name=Placeholder-{n}"
    if verb in {"pingscan", "arpscan"}:
        return f"[{n:03d}] host 192.0.2.{n % 254 + 1} is up (mock)"
    if verb == "portscan":
        return f"[{n:03d}] 192.0.2.10:{1000 + n} open (mock)"
    if verb.startswith("wardrive"):
        return f"[{n:03d}] AP {mac}  ch {n % 13 + 1}  RSSI {rssi}  GPS 0.0,0.0 (no fix, mock)"
    return f"[{n:03d}] AP/packet {mac}  ch {n % 13 + 1}  RSSI {rssi}  (mock)"
