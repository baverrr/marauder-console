"""Tests for the Marauder Console bridge, run entirely against the mock serial source — no hardware.

They cover the command round-trip, running-state tracking for streaming commands, stop, the websocket
stream (status frame, echoed command, live lines), and that disconnect releases the source.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterator

import pytest
from fastapi.testclient import TestClient

from bridge import SerialManager, create_app
from serial_source import MockSerialSource, SerialError, SerialSource
from session_store import SessionStore


@pytest.fixture
def client(tmp_path) -> Iterator[TestClient]:
    # Isolate each test's session files in a temp data dir instead of the user's real app-data location.
    app = create_app(mock=True, data_dir=tmp_path)
    with TestClient(app) as c:
        yield c


class _ScriptedSource(SerialSource):
    """A source that yields a line then either raises or ends, to drive the pump's failure/EOF paths."""

    def __init__(self, *, raise_after: bool) -> None:
        self.port = "scripted://x"
        self.baud = 115200
        self._open = True
        self._raise_after = raise_after

    @property
    def is_open(self) -> bool:
        return self._open

    async def open(self) -> None:
        self._open = True

    async def close(self) -> None:
        self._open = False

    async def write_line(self, line: str) -> None:
        pass

    async def lines(self) -> AsyncIterator[str]:
        yield "[scripted] one line"
        if self._raise_after:
            raise SerialError("simulated read error")
        # else: return → clean EOF (board closed)


def test_status_starts_disconnected(client: TestClient) -> None:
    body = client.get("/api/status").json()
    assert body["connected"] is False
    assert body["mock"] is True
    assert body["running"] is False


def test_connect_then_disconnect(client: TestClient) -> None:
    assert client.post("/api/connect").json()["ok"] is True
    assert client.get("/api/status").json()["connected"] is True
    assert client.post("/api/disconnect").json()["ok"] is True
    assert client.get("/api/status").json()["connected"] is False


def test_cors_allows_desktop_shell_origin(client: TestClient) -> None:
    # The Tauri desktop shell's webview calls the bridge cross-origin, so it must get CORS headers back;
    # an unrelated web origin must not.
    allowed = client.get("/api/status", headers={"Origin": "tauri://localhost"})
    assert allowed.headers.get("access-control-allow-origin") == "tauri://localhost"
    loopback = client.get("/api/status", headers={"Origin": "http://localhost:5173"})
    assert loopback.headers.get("access-control-allow-origin") == "http://localhost:5173"
    blocked = client.get("/api/status", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in blocked.headers


def test_command_requires_connection(client: TestClient) -> None:
    resp = client.post("/api/command", json={"command": "info"})
    assert resp.status_code == 409  # not connected


def test_command_with_newline_is_rejected(client: TestClient) -> None:
    # "\n" inside a command would reach the board as a second command line.
    client.post("/api/connect")
    resp = client.post("/api/command", json={"command": "info\nattack -t deauth"})
    assert resp.status_code == 400
    assert client.get("/api/status").json()["running"] is False


@pytest.mark.parametrize("path", ["/api/connect", "/api/disconnect", "/api/stop", "/api/cameras/scan"])
def test_state_changing_post_rejects_a_foreign_origin(client: TestClient, path: str) -> None:
    # A body-less POST needs no CORS preflight, so the bridge must check Origin itself (drive-by CSRF).
    resp = client.post(path, headers={"Origin": "https://evil.example"})
    assert resp.status_code == 403
    assert client.get("/api/status").json()["connected"] is False


def test_foreign_origin_cannot_send_a_command(client: TestClient) -> None:
    client.post("/api/connect")
    resp = client.post("/api/command", json={"command": "scanall"}, headers={"Origin": "null"})
    assert resp.status_code == 403
    assert client.get("/api/status").json()["running"] is False


def test_allowed_or_missing_origin_can_post(client: TestClient) -> None:
    assert client.post("/api/connect", headers={"Origin": "tauri://localhost"}).status_code == 200
    assert client.post("/api/disconnect", headers={"Origin": "http://127.0.0.1:8200"}).status_code == 200
    assert client.post("/api/connect").status_code == 200  # no Origin: a native client such as curl
    # Reads stay open to any origin (CORS still keeps a foreign page from seeing the response).
    assert client.get("/api/status", headers={"Origin": "https://evil.example"}).status_code == 200


def test_cors_preflight_still_works(client: TestClient) -> None:
    resp = client.options(
        "/api/command",
        headers={"Origin": "tauri://localhost", "Access-Control-Request-Method": "POST"},
    )
    assert resp.status_code == 200


def test_streaming_sets_and_clears_running(client: TestClient) -> None:
    client.post("/api/connect")
    client.post("/api/command", json={"command": "scanall"})
    assert client.get("/api/status").json()["running"] is True
    client.post("/api/stop")
    assert client.get("/api/status").json()["running"] is False


def test_attack_command_streams(client: TestClient) -> None:
    # Regression: "attack -t deauth/beacon/probe" must count as a streaming command so the UI shows Stop
    # and the mock streams instead of replying "Unknown command".
    client.post("/api/connect")
    client.post("/api/command", json={"command": "attack -t deauth"})
    assert client.get("/api/status").json()["running"] is True
    client.post("/api/stop")
    assert client.get("/api/status").json()["running"] is False


@pytest.mark.parametrize(
    "command", ["packetcount", "evilportal -c start", "mactrack", "gpsdata", "nmea", "recon ble"]
)
def test_new_streaming_commands_set_and_clear_running(client: TestClient, command: str) -> None:
    # Phase 2 added these to the Marauder command set; the bridge must treat them as streaming so the UI
    # shows Stop and the mock streams canned lines instead of replying "Unknown command". "recon ble" is
    # the Find My radar's general-BLE scan mode.
    client.post("/api/connect")
    client.post("/api/command", json={"command": command})
    assert client.get("/api/status").json()["running"] is True
    client.post("/api/stop")
    assert client.get("/api/status").json()["running"] is False


def test_recon_status_is_not_streaming(client: TestClient) -> None:
    # "recon ble"/"recon wifi" stream, but "recon status" is a one-shot query and "recon stop" ends a
    # scan — neither should flip the running flag on (the coarse first-word prefix can't tell them apart).
    client.post("/api/connect")
    client.post("/api/command", json={"command": "recon status"})
    assert client.get("/api/status").json()["running"] is False


@pytest.mark.parametrize("command", ["channel", "settings", "ls /", "recon status"])
def test_new_static_commands_respond(client: TestClient, command: str) -> None:
    # New non-streaming commands get canned mock replies rather than "Unknown command", so offline dev and
    # tests see plausible output.
    client.post("/api/connect")
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()  # initial status
        ws.send_json({"type": "command", "command": command})
        saw_unknown = False
        saw_reply = False
        for _ in range(20):
            msg = ws.receive_json()
            if msg["type"] != "line":
                continue
            text = msg["data"]
            if text.strip() == f"> {command}":
                continue
            if "Unknown command" in text:
                saw_unknown = True
                break
            saw_reply = True
            break
        assert saw_reply and not saw_unknown


def test_websocket_streams_status_and_lines(client: TestClient) -> None:
    client.post("/api/connect")
    with client.websocket_connect("/ws") as ws:
        first = ws.receive_json()
        assert first["type"] == "status"
        # The mock emits a couple of banner lines on open; drain until we see one.
        saw_line = False
        for _ in range(10):
            msg = ws.receive_json()
            if msg["type"] == "line":
                saw_line = True
                break
        assert saw_line


def test_websocket_command_is_echoed(client: TestClient) -> None:
    client.post("/api/connect")
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()  # initial status
        ws.send_json({"type": "command", "command": "info"})
        echoed = False
        info = False
        for _ in range(20):
            msg = ws.receive_json()
            if msg["type"] == "line" and msg["data"].strip() == "> info":
                echoed = True
            if msg["type"] == "line" and "Marauder" in msg["data"]:
                info = True
            if echoed and info:
                break
        assert echoed and info


def test_sessions_empty_before_any_connect(client: TestClient) -> None:
    assert client.get("/api/sessions").json()["sessions"] == []


def test_session_recorded_across_connect_and_disconnect(client: TestClient) -> None:
    # A connect→commands→disconnect span is persisted: metadata is listed and the transcript holds the
    # commands that were sent. (Received lines are recorded too, but arrive via the async pump, so the
    # deterministic assertion here is on the commands.)
    client.post("/api/connect")
    client.post("/api/command", json={"command": "scanall"})
    client.post("/api/stop")
    client.post("/api/disconnect")

    sessions = client.get("/api/sessions").json()["sessions"]
    assert len(sessions) == 1
    meta = sessions[0]
    assert meta["ended"] is not None  # finished on disconnect
    assert meta["commands"] >= 2  # scanall + stopscan

    detail = client.get(f"/api/sessions/{meta['id']}").json()
    commands = [e["d"] for e in detail["events"] if e["k"] == "command"]
    assert "scanall" in commands
    assert "stopscan" in commands


def test_session_unknown_id_is_404(client: TestClient) -> None:
    # Also covers the path-traversal guard: a non-conforming id never resolves to a file.
    assert client.get("/api/sessions/20200101T000000_0").status_code == 404
    assert client.get("/api/sessions/..%2f..%2fetc%2fpasswd").status_code == 404


@pytest.mark.asyncio
async def test_mock_source_streams_until_stop() -> None:
    src = MockSerialSource(interval=0.01)
    await src.open()
    received: list[str] = []

    async def collect() -> None:
        async for line in src.lines():
            received.append(line)

    task = asyncio.create_task(collect())
    await src.write_line("scanall")
    await asyncio.sleep(0.1)
    await src.write_line("stopscan")
    await asyncio.sleep(0.05)
    await src.close()
    await asyncio.sleep(0.01)
    task.cancel()
    assert any("scanall" in line for line in received)
    assert any("mock" in line.lower() for line in received)


def test_sniffbt_raw_emits_decodable_rawadv_lines() -> None:
    # The custom firmware's `-raw` switch adds a "RAWADV <MAC> <rssi> <hex>" line next to the plain
    # sniff line; the mock mirrors that so the Find My radar's decoder can be exercised offline.
    from serial_source import _fake_adv_hex, _fake_stream_lines

    # Without -raw: a single plain "<rssi> <mac>" line, no raw dump.
    plain = _fake_stream_lines("sniffbt -t airtag", 2)
    assert len(plain) == 1
    assert not plain[0].startswith("RAWADV")

    # With -raw: the plain line plus a well-formed RAWADV line for the same device.
    pair = _fake_stream_lines("sniffbt -t airtag -raw", 2)
    assert len(pair) == 2
    raw = pair[1]
    assert raw.startswith("RAWADV ")
    _, mac, rssi, hexpayload = raw.split()
    # RFC 7042 documentation MAC range — never a real device — and the same device as the plain line.
    assert mac.lower().startswith("00:00:5e:00:53:")
    assert mac in pair[0]
    assert int(rssi) < 0
    assert len(hexpayload) > 0 and len(hexpayload) % 2 == 0
    bytes.fromhex(hexpayload)  # valid hex

    # Deterministic and fabricated: the mock cycles through representative device types (n % 5) so the
    # decoder's classification is exercised — Find My separated/owner-nearby, proximity pairing, and
    # named vendor devices.
    apple = _fake_adv_hex(0)
    assert "ff4c0012" in apple  # Manufacturer Specific Data, Apple company id, Find My subtype
    assert "ff4c0007" in _fake_adv_hex(2)  # Apple proximity pairing (AirPods / Beats)
    named = _fake_adv_hex(3)
    assert named.startswith("020106")  # Flags AD structure
    assert "09" in named  # Complete Local Name AD type


def test_ws_rejects_a_disallowed_origin(client: TestClient) -> None:
    # CORS doesn't cover WS upgrades, so /ws must reject a foreign Origin (a malicious web page) itself.
    import contextlib

    from starlette.websockets import WebSocketDisconnect

    with contextlib.suppress(WebSocketDisconnect):  # server closes with 1008 before/at accept
        with client.websocket_connect("/ws", headers={"Origin": "https://evil.example"}) as ws:
            ws.receive_json()
            raise AssertionError("connection with a disallowed Origin should have been rejected")


def test_ws_allows_an_allowed_origin(client: TestClient) -> None:
    with client.websocket_connect("/ws", headers={"Origin": "tauri://localhost"}) as ws:
        assert ws.receive_json()["type"] == "status"


def test_parse_public_hosts() -> None:
    from bridge import _parse_public_hosts

    assert _parse_public_hosts("") == []
    assert _parse_public_hosts("   ") == []
    assert _parse_public_hosts("solo.example") == ["solo.example"]
    # comma-separated, whitespace-tolerant, empties dropped
    assert _parse_public_hosts(" a.example , b.example ,") == ["a.example", "b.example"]


def test_public_host_allows_proxied_host_and_origin(tmp_path, monkeypatch) -> None:
    # MARAUDER_PUBLIC_HOST (e.g. a reverse-proxy name like marauder.home.arpa) must be accepted as both a
    # Host header and a browser Origin — for plain requests, CORS, and the WS upgrade — while other hosts
    # and origins stay blocked. We patch the resolved allow-lists (what the env var feeds) directly.
    monkeypatch.setattr("bridge._ALLOWED_HOSTS", ["127.0.0.1", "localhost", "testserver", "console.example"])
    monkeypatch.setattr(
        "bridge._ALLOWED_ORIGINS",
        ("tauri://localhost", "https://console.example", "http://console.example"),
    )
    app = create_app(mock=True, data_dir=tmp_path)
    with TestClient(app) as c:
        # Host header accepted (TrustedHostMiddleware would 400 an unlisted host)
        assert c.get("/api/status", headers={"Host": "console.example"}).status_code == 200
        assert c.get("/api/status", headers={"Host": "evil.example"}).status_code == 400
        # CORS echoes the proxied origin, and only that one
        ok = c.get("/api/status", headers={"Origin": "https://console.example"})
        assert ok.headers.get("access-control-allow-origin") == "https://console.example"
        bad = c.get("/api/status", headers={"Origin": "https://evil.example"})
        assert "access-control-allow-origin" not in bad.headers
        # WS upgrade accepts the proxied origin
        with c.websocket_connect("/ws", headers={"Origin": "https://console.example"}) as ws:
            assert ws.receive_json()["type"] == "status"


def test_trustedhost_rejects_a_foreign_host(client: TestClient) -> None:
    # DNS-rebinding defense: a request whose Host isn't a loopback name is rejected.
    assert client.get("/api/status", headers={"Host": "evil.example"}).status_code == 400


@pytest.mark.asyncio
async def test_pump_tears_down_on_stream_error(tmp_path, monkeypatch) -> None:
    # A read error in the pump must disconnect (release the port, finalize the session), not hang.
    mgr = SerialManager(mock=False, port="x", baud=115200, store=SessionStore(tmp_path))
    monkeypatch.setattr(mgr, "_make_source", lambda p, b: _ScriptedSource(raise_after=True))
    await mgr.connect(None, None)
    assert mgr.connected is True
    for _ in range(50):
        await asyncio.sleep(0.02)
        if not mgr.connected:
            break
    assert mgr.connected is False  # pump error → teardown
    sessions = SessionStore(tmp_path).list_sessions()
    assert sessions and sessions[0]["ended"] is not None  # session finalized


@pytest.mark.asyncio
async def test_pump_tears_down_on_clean_eof(tmp_path, monkeypatch) -> None:
    # The board closing the connection cleanly (lines() ends) must also disconnect, not silently stay "up".
    mgr = SerialManager(mock=False, port="x", baud=115200, store=SessionStore(tmp_path))
    monkeypatch.setattr(mgr, "_make_source", lambda p, b: _ScriptedSource(raise_after=False))
    await mgr.connect(None, None)
    for _ in range(50):
        await asyncio.sleep(0.02)
        if not mgr.connected:
            break
    assert mgr.connected is False


def test_read_session_handles_corrupt_meta(tmp_path) -> None:
    store = SessionStore(tmp_path)
    sdir = tmp_path / "sessions"
    sdir.mkdir(parents=True)
    (sdir / "20200101T000000_1.json").write_text("{ this is not json", encoding="utf-8")
    assert store.read_session("20200101T000000_1") is None  # corrupt meta → None, not a 500


@pytest.mark.asyncio
async def test_manager_disconnect_releases_source() -> None:
    mgr = SerialManager(mock=True, port="mock://x", baud=115200)
    await mgr.connect(None, None)
    assert mgr.connected is True
    await mgr.disconnect()
    assert mgr.connected is False
    with pytest.raises(SerialError):
        await mgr.send_command("info")


class _FakeWs:
    """Stands in for a websocket: records what it was sent, or never finishes sending (a stalled client)."""

    def __init__(self, *, stalled: bool = False) -> None:
        self.stalled = stalled
        self.sent: list[str] = []
        self.closed = False

    async def send_text(self, payload: str) -> None:
        if self.stalled:
            await asyncio.Event().wait()  # never returns
        self.sent.append(payload)

    async def close(self, code: int = 1000) -> None:
        self.closed = True


async def test_stalled_websocket_client_is_dropped_without_blocking_others(monkeypatch) -> None:
    import bridge

    monkeypatch.setattr(bridge, "WS_SEND_TIMEOUT", 0.05)
    mgr = SerialManager(mock=True, port="mock://x", baud=115200)
    fast, slow = _FakeWs(), _FakeWs(stalled=True)
    mgr._clients.update({fast, slow})  # type: ignore[arg-type]

    await asyncio.wait_for(mgr._broadcast({"type": "line", "data": "hello"}), timeout=2)

    assert len(fast.sent) == 1
    assert slow not in mgr._clients and fast in mgr._clients
    await asyncio.sleep(0)  # let the background close run
    assert slow.closed is True


async def test_stale_failure_does_not_close_a_new_connection() -> None:
    # Unplug → quick Disconnect + Connect while the old failure is still broadcasting: the old teardown
    # must leave the new connection alone.
    mgr = SerialManager(mock=True, port="mock://x", baud=115200)
    await mgr.connect(None, None)
    old = mgr.source
    await mgr.disconnect()
    await mgr.connect(None, None)
    await mgr._fail("the board closed the connection", old)
    assert mgr.connected is True
    await mgr._fail("lost the serial stream", mgr.source)
    assert mgr.connected is False


@pytest.mark.parametrize(
    "port", ["socket://192.0.2.1:7000", "rfc2217://192.0.2.1:7000", "loop://", "/dev/../tmp/x", "tty", "COM"]
)
def test_real_source_rejects_non_serial_port_names(port: str) -> None:
    from bridge import InvalidPortError

    mgr = SerialManager(mock=False, port="/dev/ttyUSB0", baud=115200)
    with pytest.raises(InvalidPortError):
        mgr._make_source(port, None)


@pytest.mark.parametrize(
    "port", ["/dev/ttyUSB0", "/dev/ttyACM1", "/dev/serial/by-id/usb-Silicon_Labs-if00", "COM3"]
)
def test_real_source_accepts_serial_port_names(port: str) -> None:
    from serial_source import RealSerialSource

    mgr = SerialManager(mock=False, port="/dev/ttyUSB0", baud=115200)
    assert isinstance(mgr._make_source(port, None), RealSerialSource)


@pytest.mark.skipif(not hasattr(__import__("os"), "openpty"), reason="needs a POSIX pseudo-terminal")
async def test_real_source_round_trip_over_a_pty() -> None:
    # Exercises pyserial-asyncio-fast end to end against a pseudo-terminal standing in for the board.
    import os
    import select
    import time
    import tty

    from serial_source import RealSerialSource

    def read_until(fd: int, end: bytes, timeout: float) -> bytes:
        # select() with a deadline, never a bare blocking read: a lost write must fail the test, not hang it.
        deadline = time.monotonic() + timeout
        buf = b""
        while not buf.endswith(end):
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError(f"no {end!r} from the serial side; got {buf!r}")
            if select.select([fd], [], [], left)[0]:
                buf += os.read(fd, 64)
        return buf

    board, port_fd = os.openpty()
    tty.setraw(board)
    src = RealSerialSource(port=os.ttyname(port_fd), baud=115200)
    try:
        await asyncio.wait_for(src.open(), timeout=5)
        await asyncio.wait_for(src.write_line("info"), timeout=5)
        got = await asyncio.to_thread(read_until, board, b"\r\n", 5)
        assert got == b"info\r\n"
        os.write(board, b"Firmware version: test\r\n")
        line = await asyncio.wait_for(anext(src.lines()), timeout=5)
        assert "Firmware version: test" in line
    finally:
        await asyncio.wait_for(src.close(), timeout=5)
        os.close(board)
        os.close(port_fd)
