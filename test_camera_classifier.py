"""Unit tests for camera_classifier — pure, no network, no hardware."""

from __future__ import annotations

import camera_classifier as cc


def test_vendor_for_mac_known_and_tolerant():
    assert cc.vendor_for_mac("44:19:B6:11:22:33") == "Hikvision"
    assert cc.vendor_for_mac("4419b6112233") == "Hikvision"  # any spelling
    assert cc.vendor_for_mac("00:00:5e:00:53:17") is None  # documentation OUI, not in the table
    assert cc.vendor_for_mac(None) is None
    assert cc.vendor_for_mac("zz") is None


def test_onvif_alone_is_high_confidence_camera():
    verdict = cc.classify(onvif=True)
    assert verdict["is_camera"] is True
    assert verdict["confidence"] == "high"
    assert any("ONVIF" in r for r in verdict["reasons"])


def test_mdns_onvif_is_high():
    verdict = cc.classify(mdns_services=["_onvif._tcp"])
    assert verdict["is_camera"] is True
    assert verdict["confidence"] == "high"


def test_rtsp_port_alone_is_medium_camera():
    verdict = cc.classify(open_ports=[554, 80])
    assert verdict["is_camera"] is True
    assert verdict["confidence"] == "medium"
    assert any("554" in r for r in verdict["reasons"])


def test_generic_ports_are_not_camera():
    verdict = cc.classify(open_ports=[80, 443])
    assert verdict["is_camera"] is False
    assert verdict["confidence"] is None


def test_camera_first_vendor_alone_is_camera():
    verdict = cc.classify(vendor="Hikvision")
    assert verdict["is_camera"] is True
    assert verdict["confidence"] == "medium"


def test_mixed_vendor_is_weak_alone_but_tips_with_a_port():
    weak = cc.classify(vendor="Amazon")
    assert weak["is_camera"] is False
    assert weak["confidence"] == "low"
    strong = cc.classify(vendor="Amazon", open_ports=[554])
    assert strong["is_camera"] is True
    assert strong["confidence"] == "high"


def test_name_says_camera():
    verdict = cc.classify(name="Reolink Doorbell")
    assert verdict["is_camera"] is True
    assert any("camera" in r.lower() for r in verdict["reasons"])


def test_nothing_is_not_a_camera():
    verdict = cc.classify()
    assert verdict["is_camera"] is False
    assert verdict["confidence"] is None
    assert verdict["reasons"] == []
    assert verdict["vendor"] is None
