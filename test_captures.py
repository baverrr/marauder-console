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


def test_capture_endpoints(tmp_path) -> None:
    app = create_app(mock=True, data_dir=tmp_path, captures_dir=FIXTURES)
    with TestClient(app) as c:
        caps = c.get("/api/captures").json()["captures"]
        assert any(x["name"] == "sample-wifi.pcap" and x["kind"] == "pcap" for x in caps)

        summary = c.get("/api/captures/sample-wifi.pcap/summary").json()
        assert summary["kind"] == "pcap" and "PlaceholderNet-B" in summary["ssids"]

        assert c.get("/api/captures/nope.pcap/summary").status_code == 404
