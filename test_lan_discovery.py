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


def test_is_lan_address() -> None:
    assert lan_discovery._is_lan_address("192.0.2.10")
    assert lan_discovery._is_lan_address("fe80::1%eth0")
    for ip in ("100.64.0.1", "127.0.0.1", "224.0.0.251", "0.0.0.0", "not-an-ip", "cafe.bad"):
        assert not lan_discovery._is_lan_address(ip), ip


async def test_discover_probes_only_lan_hosts_and_caps_them(monkeypatch):
    # A responder can name any address; only local-network ones get the TCP probe, and only MAX_HOSTS.
    monkeypatch.setattr(lan_discovery, "MAX_HOSTS", 2)
    monkeypatch.setattr(
        lan_discovery, "_ws_discovery",
        lambda _t: [{"ip": ip, "onvif": True, "scopes": "", "name": None}
                    for ip in ("100.64.0.1", "192.0.2.1", "192.0.2.2", "192.0.2.3")],
    )
    monkeypatch.setattr(lan_discovery, "_mdns_browse", lambda _t: [])
    probed: list[str] = []

    async def fake_probe(ip, _ports, _timeout):
        probed.append(ip)
        return []

    monkeypatch.setattr(lan_discovery, "_probe_ports", fake_probe)
    records = await lan_discovery.discover_cameras(timeout=1)
    assert sorted(probed) == ["192.0.2.1", "192.0.2.2"]
    assert sorted(r["ip"] for r in records) == ["192.0.2.1", "192.0.2.2"]


def test_ws_discovery_uses_the_sender_address_not_xaddrs(monkeypatch):
    reply = (
        b"<d:ProbeMatch><d:XAddrs>http://192.0.2.99/onvif/device_service</d:XAddrs>"
        b"<d:Scopes>onvif://www.onvif.org/name/Cam</d:Scopes></d:ProbeMatch>"
    )

    class FakeSocket:
        def __init__(self, *_a):
            self.replies = [(reply, ("192.0.2.10", 3702))]

        def setsockopt(self, *_a):
            pass

        def sendto(self, *_a):
            pass

        def settimeout(self, _t):
            pass

        def recvfrom(self, _n):
            if not self.replies:
                raise TimeoutError
            return self.replies.pop()

        def close(self):
            pass

    monkeypatch.setattr(lan_discovery.socket, "socket", FakeSocket)
    found = lan_discovery._ws_discovery(1.0)
    assert [h["ip"] for h in found] == ["192.0.2.10"]
    assert found[0]["name"] == "Cam"
