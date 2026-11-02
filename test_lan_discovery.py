"""Tests for LAN camera discovery and the /api/cameras/scan route.

The network seams (`_ws_discovery`, `_mdns_browse`, `_probe_ports`) are monkeypatched, so nothing here
opens a real socket — mirroring how the rest of the suite runs against the mock serial source.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

import bridge
import lan_discovery
from bridge import create_app


async def test_discover_merges_onvif_mdns_and_ports(monkeypatch):
    monkeypatch.setattr(
        lan_discovery, "_ws_discovery",
        lambda _t: [{"ip": "192.0.2.10", "onvif": True, "scopes": "", "name": "Front Door"}],
    )
    monkeypatch.setattr(
        lan_discovery, "_mdns_browse",
        lambda _t: [{"ip": "192.0.2.20", "onvif": False, "mdns_services": ["_rtsp._tcp"], "name": None}],
    )

    async def fake_probe(ip, _ports, _timeout):
        return [554] if ip in ("192.0.2.10", "192.0.2.20") else []

    monkeypatch.setattr(lan_discovery, "_probe_ports", fake_probe)

    records = await lan_discovery.discover_cameras(timeout=1)
    assert [r["ip"] for r in records] == ["192.0.2.10", "192.0.2.20"]
    assert all(r["is_camera"] for r in records)
    onvif_rec = next(r for r in records if r["ip"] == "192.0.2.10")
    assert onvif_rec["confidence"] == "high"
    assert onvif_rec["name"] == "Front Door"
    assert 554 in onvif_rec["ports"]


async def test_discover_empty(monkeypatch):
    monkeypatch.setattr(lan_discovery, "_ws_discovery", lambda _t: [])
    monkeypatch.setattr(lan_discovery, "_mdns_browse", lambda _t: [])

    async def no_ports(_ip, _ports, _timeout):
        return []

    monkeypatch.setattr(lan_discovery, "_probe_ports", no_ports)
    assert await lan_discovery.discover_cameras(timeout=1) == []


def test_camera_scan_endpoint(monkeypatch, tmp_path):
    async def fake_discover(timeout=None):
        return [
            {
                "ip": "192.0.2.10", "name": "Cam", "vendor": "Hikvision", "ports": [554],
                "onvif": True, "mdns_services": [], "is_camera": True, "confidence": "high",
                "reasons": ["answered ONVIF WS-Discovery"],
            }
        ]

    monkeypatch.setattr(bridge, "discover_cameras", fake_discover)
    with TestClient(create_app(mock=True, data_dir=tmp_path)) as client:
        resp = client.post("/api/cameras/scan", json={"timeout": 1})
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert data["cameras"][0]["ip"] == "192.0.2.10"
        assert data["cameras"][0]["confidence"] == "high"


def test_camera_scan_endpoint_handles_failure(monkeypatch, tmp_path):
    async def boom(timeout=None):
        raise RuntimeError("socket blew up")

    monkeypatch.setattr(bridge, "discover_cameras", boom)
    with TestClient(create_app(mock=True, data_dir=tmp_path)) as client:
        resp = client.post("/api/cameras/scan")
        assert resp.status_code == 502
        assert resp.json()["ok"] is False
