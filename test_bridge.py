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
def client() -> Iterator[TestClient]:
    app = create_app(mock=True)
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
