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
import os
from collections import deque
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from assistant import ProposalStore
from capture_store import CaptureStore, resolve_captures_dir
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
PORT = 8200  # the console's HTTP/WS port; separate from the TV remote's 8198/8199
FRONTEND_DIST = Path(__file__).resolve().parent / "frontend" / "dist"
# Commands that keep streaming until stopscan; the bridge marks itself "running" while one is active.
STREAMING_PREFIXES = ("scan", "sniff", "wardrive", "blespam", "findmy", "remoteid", "pingscan",
                      "arpscan", "portscan", "csimotion", "foxhunt", "spoofat", "attack",
                      "packetcount", "mactrack", "evilportal", "karma", "gpsdata", "nmea")


class CommandBody(BaseModel):
    command: str


class ConnectBody(BaseModel):
    port: str | None = None
    baud: int | None = None


class ProposeBody(BaseModel):
    command: str
    rationale: str = ""


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
        self._reader_task: asyncio.Task[None] | None = None
        self._history: deque[str] = deque(maxlen=300)  # replayed to late-joining websockets
        self._lock = asyncio.Lock()
        self._store = store  # records each connect→disconnect span to disk for later review
        self._recorder: SessionRecorder | None = None

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
                self._recorder = self._store.start(port=source.port, mock=self._mock)
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
        if self.source is None or not self.source.is_open:
            raise SerialError("Not connected to a board")
        await self.source.write_line(command)
        if self._recorder is not None:
            self._recorder.log("command", command)
        verb = command.split()[0].lower()
        if verb == "stopscan":
            self.running = False
        elif verb.startswith(STREAMING_PREFIXES):
            self.running = True
        await self.broadcast_status()

    async def _pump(self) -> None:
        """Read lines from the source forever and push them to every websocket."""
        assert self.source is not None
        try:
            async for line in self.source.lines():
                self._note_firmware(line)
                self._history.append(line)
                if self._recorder is not None:
                    self._recorder.log("line", line)
                await self._broadcast({"type": "line", "data": line})
        except SerialError as exc:
            await self._broadcast({"type": "line", "data": f"[bridge] {exc}"})
            await self._teardown()
            await self.broadcast_status()

    def _note_firmware(self, line: str) -> None:
        low = line.lower()
        if "firmware" in low and "version" in low:
            self.firmware = line.split(":", 1)[-1].strip() or line.strip()

    async def add_client(self, ws: WebSocket) -> None:
        self._clients.add(ws)
        await ws.send_text(json.dumps({"type": "status", "data": self.status()}))
        for line in self._history:
            await ws.send_text(json.dumps({"type": "line", "data": line}))

    def remove_client(self, ws: WebSocket) -> None:
        self._clients.discard(ws)

    async def broadcast_status(self) -> None:
        await self._broadcast({"type": "status", "data": self.status()})

    async def _broadcast(self, message: dict) -> None:
        payload = json.dumps(message)
        dead: list[WebSocket] = []
        for ws in list(self._clients):
            try:
                await ws.send_text(payload)
            except Exception:  # noqa: BLE001 - client went away
                dead.append(ws)
        for ws in dead:
            self._clients.discard(ws)


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
        allow_origins=[
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ],
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/status")
    async def get_status() -> dict:
        return manager.status()

    @app.post("/api/connect")
    async def connect(body: ConnectBody | None = None) -> JSONResponse:
        body = body or ConnectBody()
        try:
            await manager.connect(body.port, body.baud)
        except SerialError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=502)
        return JSONResponse({"ok": True, "status": manager.status()})

    @app.post("/api/disconnect")
    async def disconnect() -> dict:
        await manager.disconnect()
        return {"ok": True, "status": manager.status()}

    @app.post("/api/command")
    async def command(body: CommandBody) -> JSONResponse:
        try:
            await manager.send_command(body.command)
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
        data = captures.summarize(name)
        if data is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        return JSONResponse(data)

    @app.get("/api/captures/{name}/wardrive")
    async def capture_wardrive(name: str) -> JSONResponse:
        # Parse a Wigle CSV into located points for the map. Read-only, offline; no tiles are fetched.
        data = captures.wardrive(name)
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
        return JSONResponse({"ok": True, "proposal": proposals.propose(body.command, body.rationale)})

    @app.delete("/api/assistant/proposals/{proposal_id}")
    async def dismiss_proposal(proposal_id: int) -> dict:
        return {"ok": proposals.dismiss(proposal_id)}

    @app.delete("/api/assistant/proposals")
    async def clear_proposals() -> dict:
        proposals.clear()
        return {"ok": True}

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        await ws.accept()
        await manager.add_client(ws)
        try:
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

    data_dir = Path(args.data_dir) if args.data_dir else None
    captures_dir = Path(args.captures_dir) if args.captures_dir else None
    app = create_app(
        mock=mock, port=args.serial_port, baud=args.baud, data_dir=data_dir, captures_dir=captures_dir
    )
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
