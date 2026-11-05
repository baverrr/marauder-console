"""Tests for the PC-side capture library and the pcap summariser, run against committed fixtures.

The fixtures (``tests/fixtures/``) use only RFC 7042 documentation MACs (00:00:5e:00:53:xx) and placeholder
SSIDs, so nothing real is checked in. The pcap is a tiny radiotap + 802.11 capture of two beacons and a
probe request.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from bridge import create_app
from capture_store import CaptureStore
from pcap_reader import summarize_pcap
from wigle_reader import parse_wigle

FIXTURES = Path(__file__).parent / "tests" / "fixtures"


def test_pcap_summary_extracts_ssids_and_bssids() -> None:
    s = summarize_pcap(FIXTURES / "sample-wifi.pcap")
    assert s["kind"] == "pcap"
    assert s["link_type_name"] == "ieee802.11-radiotap"
    assert s["frames"] == 3
    assert "PlaceholderNet-A" in s["ssids"] and "PlaceholderNet-B" in s["ssids"]
    assert "00:00:5e:00:53:01" in s["bssids"]
    assert s["truncated"] is False


def test_pcap_rejects_non_pcap(tmp_path) -> None:
    bad = tmp_path / "x.pcap"
    bad.write_bytes(b"not a pcap at all")
    with pytest.raises(ValueError):
        summarize_pcap(bad)


def test_capture_store_lists_and_summarises() -> None:
    store = CaptureStore(FIXTURES)
    names = {c["name"] for c in store.list_captures()}
    assert {"sample-wifi.pcap", "sample-wardrive.csv"} <= names

    pcap = store.summarize("sample-wifi.pcap")
    assert pcap is not None and pcap["kind"] == "pcap" and "PlaceholderNet-A" in pcap["ssids"]

    csv = store.summarize("sample-wardrive.csv")
    assert csv is not None and csv["kind"] == "text"
    assert any("WigleWifi" in line for line in csv["preview"])

    # Unknown name and a traversal attempt both resolve to nothing (match is against the listing).
    assert store.summarize("nope.pcap") is None
    assert store.summarize("../bridge.py") is None


def test_wigle_parses_located_points_and_skips_no_fix() -> None:
    data = parse_wigle(FIXTURES / "sample-wardrive-geo.csv")
    assert data["kind"] == "wardrive"
    assert data["count"] == 3  # the 0,0 "no fix" row is dropped
    ssids = {p["ssid"] for p in data["points"]}
    assert {"PlaceholderNet-A", "PlaceholderNet-B", "PlaceholderNet-C"} == ssids
    assert "PlaceholderNet-NoFix" not in ssids
    b = data["bounds"]
    assert b["min_lat"] == 0.001 and b["max_lat"] == 0.0012

    # The slice-2 fixture is all no-fix rows, so it yields no plottable points and no bounds.
    empty = parse_wigle(FIXTURES / "sample-wardrive.csv")
    assert empty["count"] == 0 and empty["bounds"] is None


_WIGLE_HEADER = (
    "WigleWifi-1.4,appRelease=1,model=x,release=1,device=x,display=x,board=x,brand=x\n"
    "MAC,SSID,AuthMode,FirstSeen,Channel,RSSI,CurrentLatitude,CurrentLongitude,AltitudeMeters,"
    "AccuracyMeters,Type\n"
)


def _wigle_row(ssid: str, rssi: str, lat: str, lon: str) -> str:
    return f"00:00:5e:00:53:01,{ssid},[WPA2],2026-01-01 00:00:00,6,{rssi},{lat},{lon},0,5,WIFI\n"


def test_wigle_drops_non_finite_and_out_of_range_rows(tmp_path) -> None:
    path = tmp_path / "w.csv"
    path.write_text(
        _WIGLE_HEADER
        + _wigle_row("Good", "nan", "0.001", "0.002")
        + _wigle_row("NanLat", "-50", "nan", "0.002")
        + _wigle_row("InfLon", "-50", "0.001", "inf")
        + _wigle_row("OutOfRange", "-50", "999", "0.002")
    )
    data = parse_wigle(path)
    assert [p["ssid"] for p in data["points"]] == ["Good"]
    assert data["points"][0]["rssi"] is None  # a non-finite RSSI becomes "unknown", not NaN

    # The endpoint must return JSON (NaN isn't valid JSON, so it used to fail with a 500).
    app = create_app(mock=True, data_dir=tmp_path / "data", captures_dir=tmp_path)
    with TestClient(app) as c:
        resp = c.get("/api/captures/w.csv/wardrive")
        assert resp.status_code == 200 and resp.json()["count"] == 1


def test_capture_endpoints(tmp_path) -> None:
    app = create_app(mock=True, data_dir=tmp_path, captures_dir=FIXTURES)
    with TestClient(app) as c:
        caps = c.get("/api/captures").json()["captures"]
        assert any(x["name"] == "sample-wifi.pcap" and x["kind"] == "pcap" for x in caps)

        summary = c.get("/api/captures/sample-wifi.pcap/summary").json()
        assert summary["kind"] == "pcap" and "PlaceholderNet-B" in summary["ssids"]
        assert c.get("/api/captures/nope.pcap/summary").status_code == 404

        wardrive = c.get("/api/captures/sample-wardrive-geo.csv/wardrive").json()
        assert wardrive["kind"] == "wardrive" and wardrive["count"] == 3
        # A pcap is not a wardrive CSV.
        assert c.get("/api/captures/sample-wifi.pcap/wardrive").status_code == 404
