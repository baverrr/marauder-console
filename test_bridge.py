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


@pytest.mark.parametrize("command", ["packetcount", "evilportal -c start", "mactrack", "gpsdata", "nmea"])
def test_new_streaming_commands_set_and_clear_running(client: TestClient, command: str) -> None:
    # Phase 2 added these to the Marauder command set; the bridge must treat them as streaming so the UI
    # shows Stop and the mock streams canned lines instead of replying "Unknown command".
    client.post("/api/connect")
    client.post("/api/command", json={"command": command})
    assert client.get("/api/status").json()["running"] is True
    client.post("/api/stop")
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
