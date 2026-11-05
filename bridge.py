"""Marauder Console bridge: the single owner of the ESP32's serial port.

The browser never opens the serial port itself (it can't, and the port is single-consumer). Instead this
FastAPI app owns the port and exposes it over the LAN:

  GET  /api/status            {connected, port, baud, firmware, running, mock}
  POST /api/connect           {port?, baud?}        open the port on demand
  POST /api/disconnect        release the port so a flashing script can use it
  POST /api/command           {command}             send one command line to the board
  POST /api/stop              shorthand for sending "stopscan"
  WS   /ws                    live serial stream: {type: "line"|"status", ...}

It also serves the built React frontend from ``frontend/dist`` when that exists, so one process is the whole
app. Pass ``--mock`` (or set ``MARAUDER_MOCK=1``) to run against a simulated board with no hardware.

The port is opened only while connected and closed on disconnect, on the last websocket... no: the port
stays open across websocket reconnects and is released only by an explicit /api/disconnect (or shutdown),
which matches the UI's Connect/Disconnect buttons and keeps /dev/ttyUSB0 free the rest of the time.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import os
import re
import threading
from collections import deque
from collections.abc import Awaitable, Callable
from pathlib import Path

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.trustedhost import TrustedHostMiddleware

from assistant import ProposalStore, has_control_chars
from assistant_runner import ChatContext, KeyStore, build_client, run_chat
from capture_store import CaptureStore, resolve_captures_dir
from lan_discovery import discover_cameras
from serial_source import (
    DEFAULT_BAUD,
    DEFAULT_PORT,
    MockSerialSource,
    RealSerialSource,
    SerialError,
    SerialSource,
)
from session_store import SessionRecorder, SessionStore, resolve_data_dir

HOST = "127.0.0.1"
# Seconds a websocket client gets to accept one message before it's dropped (see SerialManager._broadcast).
WS_SEND_TIMEOUT = 5.0
PORT = 8200  # the console's HTTP/WS port; separate from the TV remote's 8198/8199
FRONTEND_DIST = Path(__file__).resolve().parent / "frontend" / "dist"
# Commands that keep streaming until stopscan; the bridge marks itself "running" while one is active.
STREAMING_PREFIXES = ("scan", "sniff", "wardrive", "blespam", "findmy", "remoteid", "pingscan",
                      "arpscan", "portscan", "csimotion", "foxhunt", "spoofat", "attack",
                      "packetcount", "mactrack", "evilportal", "karma", "gpsdata", "nmea")


def _parse_public_hosts(raw: str) -> list[str]:
    """Hostnames from MARAUDER_PUBLIC_HOST (comma-separated, whitespace-tolerant); empty when unset."""
    return [host.strip() for host in raw.split(",") if host.strip()]


# Optional extra hostname(s) this bridge is served under — e.g. behind a reverse proxy at
# https://marauder.home.arpa. Opt-in via MARAUDER_PUBLIC_HOST (comma-separated for several); the default
# is empty, so the bridge stays loopback-only. Set it only for a host you control: each is added to both
# the accepted Host headers and the allowed browser origins below.
_PUBLIC_HOSTS = _parse_public_hosts(os.environ.get("MARAUDER_PUBLIC_HOST", ""))

# Origins the webview/dev server legitimately call from. Shared by the HTTP CORS policy and the WebSocket
# origin check (CORS does not apply to WebSocket upgrades, so /ws has to check Origin itself). A configured
# public host is allowed over both https and http (a reverse proxy usually terminates TLS in front).
_ALLOWED_ORIGINS = (
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    *(f"https://{host}" for host in _PUBLIC_HOSTS),
    *(f"http://{host}" for host in _PUBLIC_HOSTS),
)
_ALLOWED_ORIGIN_RE = re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$")
# Host header values accepted (defends against DNS-rebinding, where a browser reaches the loopback port
# via an attacker domain that resolves to 127.0.0.1). Port is stripped before matching by Starlette. Any
# MARAUDER_PUBLIC_HOST entries are appended so the bridge can be reached under its proxied name too.
_ALLOWED_HOSTS = ["127.0.0.1", "localhost", "testserver", *_PUBLIC_HOSTS]


# Local serial devices only: /dev/ttyUSB0, /dev/ttyACM0, /dev/cu.usbserial-…, /dev/serial/by-id/…, COM3.
_SERIAL_PORT_RE = re.compile(r"^(/dev/[A-Za-z0-9._:+-][A-Za-z0-9._:+/-]*|COM[0-9]{1,3})$")

_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def _origin_allowed(origin: str | None) -> bool:
    """True if a browser Origin is one of ours. A missing Origin (native client / test) is allowed —
    a malicious *web page* always sends an Origin on a WebSocket, so this blocks the drive-by vector."""
    if not origin:
        return True
    return origin in _ALLOWED_ORIGINS or bool(_ALLOWED_ORIGIN_RE.match(origin))


class InvalidPortError(SerialError):
    """A port name the bridge refuses to open (not a local serial device)."""


class InvalidCommandError(SerialError):
    """A command the bridge refuses to send (e.g. it contains a newline that would split it in two)."""


class CommandBody(BaseModel):
    command: str


class ConnectBody(BaseModel):
    port: str | None = None
    baud: int | None = None


class ProposeBody(BaseModel):
    command: str
    rationale: str = ""


class ChatBody(BaseModel):
    # The full conversation so far (roles user/assistant), plus the command catalogue from the UI so the
    # assistant's list_tools tool can see tools.ts without the backend duplicating it.
    messages: list[dict]
    tools: list[dict] = []


class KeyBody(BaseModel):
    key: str


class CameraScanBody(BaseModel):
    # Seconds to listen for ONVIF/mDNS responses (clamped server-side). None uses the default.
    timeout: float | None = None


class SerialManager:
    """Owns at most one serial source and fans its output out to every connected websocket."""

    def __init__(self, *, mock: bool, port: str, baud: int, store: SessionStore | None = None) -> None:
        self._mock = mock
        self._default_port = port
        self._default_baud = baud
        self.source: SerialSource | None = None
        self.firmware: str | None = None
        self.running = False  # a streaming command is active
        self._clients: set[WebSocket] = set()
        self._close_tasks: set[asyncio.Task] = set()  # keeps background closes of dropped clients alive
        self._reader_task: asyncio.Task[None] | None = None
        self._history: deque[str] = deque(maxlen=300)  # replayed to late-joining websockets
        self._hist_lock = threading.Lock()  # guards _history (read from a worker thread by the assistant)
        self._lock = asyncio.Lock()
        self._store = store  # records each connect→disconnect span to disk for later review
        self._recorder: SessionRecorder | None = None
        self._fail_task: asyncio.Task[None] | None = None  # kept so a scheduled teardown isn't GC'd

    @property
    def connected(self) -> bool:
        return self.source is not None and self.source.is_open

    def status(self) -> dict:
        return {
            "connected": self.connected,
            "mock": self._mock,
            "port": self.source.port if self.source else self._default_port,
            "baud": self.source.baud if self.source else self._default_baud,
            "firmware": self.firmware,
            "running": self.running,
        }

    def _make_source(self, port: str | None, baud: int | None) -> SerialSource:
        p = port or self._default_port
        b = baud or self._default_baud
        if self._mock:
            return MockSerialSource(baud=b)
        if not _SERIAL_PORT_RE.match(p) or ".." in p:
            # pyserial also opens URLs (socket://, rfc2217://, loop://), which would let any API caller make
            # the bridge open outbound network connections. Only real serial device names are accepted.
            raise InvalidPortError("Not a serial port name (expected e.g. /dev/ttyUSB0 or COM3)")
        return RealSerialSource(port=p, baud=b)

    async def connect(self, port: str | None, baud: int | None) -> None:
        async with self._lock:
            if self.connected:
                return
            source = self._make_source(port, baud)
            await source.open()
            self.source = source
            self.running = False
            self._history.clear()
            if self._store is not None:
                try:
                    self._recorder = self._store.start(port=source.port, mock=self._mock)
                except OSError as exc:  # recording is best-effort; never block connecting on it
                    logging.getLogger("marauder.bridge").warning("session recording off: %s", exc)
                    self._recorder = None
            self._reader_task = asyncio.create_task(self._pump())
            await self.broadcast_status()

    async def disconnect(self) -> None:
        async with self._lock:
            await self._teardown()
            await self.broadcast_status()

    async def _teardown(self) -> None:
        task, self._reader_task = self._reader_task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        if self.source is not None:
            await self.source.close()
        if self._recorder is not None:
            self._recorder.finish()
            self._recorder = None
        self.source = None
        self.running = False
        self.firmware = None

    async def send_command(self, command: str) -> None:
        command = command.strip()
        if not command:
            return
        if has_control_chars(command):
            raise InvalidCommandError("Command must be a single line with no control characters")
        if self.source is None or not self.source.is_open:
            raise SerialError("Not connected to a board")
        await self.source.write_line(command)
        if self._recorder is not None:
            self._recorder.log("command", command)
        cmd = command.lower().strip()
        verb = cmd.split()[0] if cmd else ""
        # `recon` needs its subcommand: "recon ble"/"recon wifi" stream, "recon stop" ends them, and
        # "recon status" is a one-shot query that leaves the running state untouched — so it can't go in
        # the first-word STREAMING_PREFIXES tuple.
        if verb == "stopscan" or cmd.startswith("recon stop"):
            self.running = False
        elif verb.startswith(STREAMING_PREFIXES) or cmd.startswith(("recon ble", "recon wifi")):
            self.running = True
        await self.broadcast_status()

    async def _pump(self) -> None:
        """Read lines from the source and push them to every websocket until the stream ends or errors."""
        assert self.source is not None
        try:
            async for line in self.source.lines():
                self._note_firmware(line)
                with self._hist_lock:
                    self._history.append(line)
                if self._recorder is not None:
                    self._recorder.log("line", line)
                await self._broadcast({"type": "line", "data": line})
        except asyncio.CancelledError:
            raise  # an explicit disconnect cancelled us — let it propagate, do not teardown here
        except SerialError as exc:
            self._schedule_fail(str(exc))
            return
        except Exception as exc:  # noqa: BLE001 - e.g. a session-log write failing must not kill the bridge
            logging.getLogger("marauder.bridge").warning("serial pump error: %s", exc)
            self._schedule_fail("lost the serial stream")
            return
        # The stream ended without error (clean EOF: the board closed / was unplugged cleanly).
        self._schedule_fail("the board closed the connection")

    def _schedule_fail(self, message: str) -> None:
        """Broadcast an error line and tear down under the lock, off the pump task (so it is not the task
        cancelling itself, and teardown is serialized with connect/disconnect)."""
        self._fail_task = asyncio.create_task(self._fail(message, self.source))

    async def _fail(self, message: str, failed: SerialSource | None) -> None:
        await self._broadcast({"type": "line", "data": f"[bridge] {message}"})
        async with self._lock:
            # While the line above was broadcasting, the user may have disconnected and reconnected. Only
            # tear down the connection that actually failed, never a fresh one that replaced it.
            if failed is not None and self.source is failed:
                await self._teardown()
        await self.broadcast_status()

    def _note_firmware(self, line: str) -> None:
        low = line.lower()
        if "firmware" in low and "version" in low:
            self.firmware = line.split(":", 1)[-1].strip() or line.strip()

    def recent_lines(self, n: int = 50) -> list[str]:
        """The last ``n`` console lines (read-only; the assistant's tail_console tool reads this from a
        worker thread, so the snapshot is taken under the history lock)."""
        with self._hist_lock:
            history = list(self._history)
        return history[-n:] if n > 0 else []

    async def add_client(self, ws: WebSocket) -> None:
        self._clients.add(ws)
        # Snapshot history first (atomically, under the lock) so replaying it with awaits cannot race the
        # pump appending mid-iteration.
        with self._hist_lock:
            history = list(self._history)
        await ws.send_text(json.dumps({"type": "status", "data": self.status()}))
        for line in history:
            await ws.send_text(json.dumps({"type": "line", "data": line}))

    def remove_client(self, ws: WebSocket) -> None:
        self._clients.discard(ws)

    async def broadcast_status(self) -> None:
        await self._broadcast({"type": "status", "data": self.status()})

    async def _broadcast(self, message: dict) -> None:
        # Send to every client at once, each with a deadline. The pump awaits this, so one client that has
        # stopped reading (a sleeping laptop, a stalled proxy hop) must not freeze the serial stream for
        # everyone: it gets dropped after WS_SEND_TIMEOUT instead.
        payload = json.dumps(message)
        clients = list(self._clients)
        if not clients:
            return
        results = await asyncio.gather(*(self._send(ws, payload) for ws in clients))
        for ws, ok in zip(clients, results, strict=True):
            if not ok:
                self._clients.discard(ws)
                task = asyncio.create_task(self._close_quietly(ws))
                self._close_tasks.add(task)
                task.add_done_callback(self._close_tasks.discard)

    @staticmethod
    async def _send(ws: WebSocket, payload: str) -> bool:
        try:
            # asyncio.timeout, not wait_for: on Python 3.11 wait_for can swallow a cancel that lands as the
            # send completes, which left a disconnect waiting forever on a pump that never stopped.
            async with asyncio.timeout(WS_SEND_TIMEOUT):
                await ws.send_text(payload)
        except Exception:  # noqa: BLE001 - client went away or is too slow
            return False
        return True

    @staticmethod
    async def _close_quietly(ws: WebSocket) -> None:
        # The client's own /ws handler then sees the disconnect and exits.
        with contextlib.suppress(Exception):
            async with asyncio.timeout(WS_SEND_TIMEOUT):
                await ws.close(code=1011)


def create_app(
    *,
    mock: bool = False,
    port: str = DEFAULT_PORT,
    baud: int = DEFAULT_BAUD,
    data_dir: Path | None = None,
    captures_dir: Path | None = None,
) -> FastAPI:
    base_dir = data_dir or resolve_data_dir()
    store = SessionStore(base_dir)
    captures = CaptureStore(captures_dir or resolve_captures_dir(base_dir))
    proposals = ProposalStore()
    keystore = KeyStore()
    manager = SerialManager(mock=mock, port=port, baud=baud, store=store)

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        await manager.disconnect()  # release the serial port on shutdown

    app = FastAPI(title="Marauder Console bridge", lifespan=lifespan)
    app.state.manager = manager

    # The web UI is same-origin in the browser build, but the Tauri desktop shell loads it from its own
    # webview origin (tauri://localhost, or https://tauri.localhost on Windows) and calls this bridge
    # cross-origin. Allow those origins plus any loopback dev server. The bridge binds to 127.0.0.1, so
    # this does not widen network exposure.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(_ALLOWED_ORIGINS),
        allow_origin_regex=_ALLOWED_ORIGIN_RE.pattern,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    # Reject requests whose Host header isn't a loopback name — blocks DNS-rebinding, where a browser
    # reaches this loopback port through an attacker-controlled domain pointed at 127.0.0.1.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=_ALLOWED_HOSTS)

    # CORS only stops a foreign page from *reading* a response; a body-less POST is a "simple request" with
    # no preflight, so without this any web page could connect, stop or disconnect the board, or start a
    # camera scan. Apply the same Origin rule as /ws to every state-changing request. A missing Origin is a
    # native client (curl, tests); browsers always send one on cross-origin POST/PUT/PATCH/DELETE.
    @app.middleware("http")
    async def reject_foreign_origins(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if request.method not in _SAFE_METHODS and not _origin_allowed(request.headers.get("origin")):
            return JSONResponse({"ok": False, "error": "origin not allowed"}, status_code=403)
        return await call_next(request)

    @app.get("/api/status")
    async def get_status() -> dict:
        return manager.status()

    @app.post("/api/connect")
    async def connect(body: ConnectBody | None = None) -> JSONResponse:
        body = body or ConnectBody()
        try:
            await manager.connect(body.port, body.baud)
        except InvalidPortError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)
        except SerialError as exc:
            logging.getLogger("marauder.bridge").info("connect failed: %s", exc)
            return JSONResponse(
                {"ok": False, "error": "Could not open the serial port. Check the cable, port and access."},
                status_code=502,
            )
        return JSONResponse({"ok": True, "status": manager.status()})

    @app.post("/api/disconnect")
    async def disconnect() -> dict:
        await manager.disconnect()
        return {"ok": True, "status": manager.status()}

    @app.post("/api/command")
    async def command(body: CommandBody) -> JSONResponse:
        try:
            await manager.send_command(body.command)
        except InvalidCommandError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)
        except SerialError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=409)
        return JSONResponse({"ok": True, "status": manager.status()})

    @app.post("/api/stop")
    async def stop() -> JSONResponse:
        try:
            await manager.send_command("stopscan")
        except SerialError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=409)
        return JSONResponse({"ok": True, "status": manager.status()})

    @app.get("/api/sessions")
    async def list_sessions() -> dict:
        # Read-only; works with the board unplugged. Transcripts are read from disk, not the device.
        return {"sessions": store.list_sessions()}

    @app.get("/api/sessions/{session_id}")
    async def get_session(session_id: str) -> JSONResponse:
        data = store.read_session(session_id)
        if data is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        return JSONResponse(data)

    @app.get("/api/captures")
    async def list_captures() -> dict:
        # Read-only PC-side library; lists files copied into the captures dir. No device needed.
        return {"captures": captures.list_captures()}

    @app.get("/api/captures/{name}/summary")
    async def capture_summary(name: str) -> JSONResponse:
        # Parsing a large pcap takes seconds; run it off the event loop so the live stream keeps flowing.
        data = await asyncio.to_thread(captures.summarize, name)
        if data is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        return JSONResponse(data)

    @app.get("/api/captures/{name}/wardrive")
    async def capture_wardrive(name: str) -> JSONResponse:
        # Parse a Wigle CSV into located points for the map. Read-only, offline; no tiles are fetched.
        data = await asyncio.to_thread(captures.wardrive, name)
        if data is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        return JSONResponse(data)

    # ---- Assistant staging area ----------------------------------------------------------------
    # Proposing a command only enqueues it here for human review; there is no path from these routes to
    # the serial port. Running a staged command is a separate, explicit step through /api/command (and,
    # for transmitting commands, the per-session authorisation in the UI).
    @app.get("/api/assistant/proposals")
    async def get_proposals() -> dict:
        return {"proposals": proposals.list()}

    @app.post("/api/assistant/proposals")
    async def add_proposal(body: ProposeBody) -> JSONResponse:
        if not body.command.strip():
            return JSONResponse({"ok": False, "error": "empty command"}, status_code=400)
        try:
            proposal = proposals.propose(body.command, body.rationale)
        except ValueError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)
        return JSONResponse({"ok": True, "proposal": proposal})

    @app.delete("/api/assistant/proposals/{proposal_id}")
    async def dismiss_proposal(proposal_id: int) -> dict:
        return {"ok": proposals.dismiss(proposal_id)}

    @app.delete("/api/assistant/proposals")
    async def clear_proposals() -> dict:
        proposals.clear()
        return {"ok": True}

    # ---- Assistant API key (OS keychain; the value is set by the user and never returned) -------
    @app.get("/api/assistant/key")
    async def key_status() -> dict:
        # Keychain lookups are synchronous D-Bus calls that can block on an unlock prompt: keep them off
        # the event loop that pumps the serial port and the websockets.
        return {"has_key": await asyncio.to_thread(keystore.has)}

    @app.post("/api/assistant/key")
    async def set_key(body: KeyBody) -> JSONResponse:
        if not body.key.strip():
            return JSONResponse({"ok": False, "error": "empty key"}, status_code=400)
        await asyncio.to_thread(keystore.set, body.key)
        return JSONResponse({"ok": True, "has_key": await asyncio.to_thread(keystore.has)})

    @app.delete("/api/assistant/key")
    async def clear_key() -> dict:
        await asyncio.to_thread(keystore.clear)
        return {"ok": True, "has_key": await asyncio.to_thread(keystore.has)}

    # ---- Assistant chat (advise/draft tool loop) ------------------------------------------------
    @app.post("/api/assistant/chat")
    async def assistant_chat(body: ChatBody) -> JSONResponse:
        api_key = await asyncio.to_thread(keystore.get)
        if not api_key:
            return JSONResponse(
                {"ok": False, "error": "No Anthropic API key set. Add one in the assistant settings."},
                status_code=428,  # precondition required
            )
        ctx = ChatContext(
            manager=manager, captures=captures, proposals=proposals, tools_catalogue=body.tools
        )
        try:
            client = build_client(api_key)
            result = await asyncio.to_thread(run_chat, client, body.messages, ctx)
        except Exception as exc:  # noqa: BLE001 - surface a generic failure, not the raw exception
            logging.getLogger("marauder.assistant").warning("assistant chat failed: %s", exc)
            return JSONResponse({"ok": False, "error": "assistant request failed"}, status_code=502)
        return JSONResponse({"ok": True, **result})

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        # CORS does not apply to WebSocket upgrades, so check the Origin ourselves: a malicious web page
        # could otherwise open this socket and drive the board. A missing Origin (native client) is fine.
        if not _origin_allowed(ws.headers.get("origin")):
            await ws.close(code=1008)  # policy violation
            return
        await ws.accept()
        try:
            await manager.add_client(ws)
            while True:
                # The UI mostly talks over HTTP, but allow a command over the socket too.
                raw = await ws.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if msg.get("type") == "command":
                    with contextlib.suppress(SerialError):
                        await manager.send_command(str(msg.get("command", "")))
        except WebSocketDisconnect:
            pass
        finally:
            manager.remove_client(ws)

    # ---- Camera discovery (LAN) -----------------------------------------------------------------
    # Actively probes the local network (ONVIF WS-Discovery multicast, optional mDNS, and a short connect
    # to known camera ports) to find IP cameras. Explicit and user-triggered only — never auto-run, and
    # not reachable by the assistant. Needs no serial port, so it works with the board unplugged.
    @app.post("/api/cameras/scan")
    async def scan_cameras(body: CameraScanBody | None = None) -> JSONResponse:
        body = body or CameraScanBody()
        try:
            cameras = await discover_cameras(timeout=body.timeout)
        except Exception as exc:  # noqa: BLE001 - surface a generic failure, not the raw exception
            logging.getLogger("marauder.bridge").warning("camera scan failed: %s", exc)
            return JSONResponse({"ok": False, "error": "camera scan failed"}, status_code=502)
        return JSONResponse({"ok": True, "cameras": cameras})

    if FRONTEND_DIST.is_dir():
        app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")

    return app


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Marauder Console bridge")
    parser.add_argument("command", nargs="?", default="serve", choices=["serve"])
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", type=int, default=PORT, help="HTTP/WS port for the console UI")
    parser.add_argument("--serial-port", default=DEFAULT_PORT, help="default ESP32 serial device")
    parser.add_argument("--baud", type=int, default=DEFAULT_BAUD)
    parser.add_argument("--mock", action="store_true", help="simulate a board; no hardware needed")
    parser.add_argument("--data-dir", default=None, help="where to store session transcripts")
    parser.add_argument("--captures-dir", default=None, help="folder of capture/log files to browse")
    args = parser.parse_args(argv)

    mock = args.mock or os.environ.get("MARAUDER_MOCK") == "1"
    import uvicorn

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        logging.getLogger("marauder.bridge").warning(
            "Binding to %s exposes an UNAUTHENTICATED command API beyond this machine. The bridge has no "
            "auth; anyone who can reach %s:%s can drive the board. Use 127.0.0.1 unless you understand "
            "this.",
            args.host,
            args.host,
            args.port,
        )

    data_dir = Path(args.data_dir) if args.data_dir else None
    captures_dir = Path(args.captures_dir) if args.captures_dir else None
    app = create_app(
        mock=mock, port=args.serial_port, baud=args.baud, data_dir=data_dir, captures_dir=captures_dir
    )
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
