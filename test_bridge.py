"""Tests for the Marauder Console bridge, run entirely against the mock serial source — no hardware.

They cover the command round-trip, running-state tracking for streaming commands, stop, the websocket
stream (status frame, echoed command, live lines), and that disconnect releases the source.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from bridge import SerialManager, create_app
from serial_source import MockSerialSource, SerialError


@pytest.fixture
def client(tmp_path) -> Iterator[TestClient]:
    # Isolate each test's session files in a temp data dir instead of the user's real app-data location.
    app = create_app(mock=True, data_dir=tmp_path)
    with TestClient(app) as c:
        yield c


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


@pytest.mark.asyncio
async def test_manager_disconnect_releases_source() -> None:
    mgr = SerialManager(mock=True, port="mock://x", baud=115200)
    await mgr.connect(None, None)
    assert mgr.connected is True
    await mgr.disconnect()
    assert mgr.connected is False
    with pytest.raises(SerialError):
        await mgr.send_command("info")
