"""Camera fingerprinting — pure, dependency-free (like pcap_reader / wigle_reader); no network here.

Given the signals a LAN scan collects for one host (whether it answered ONVIF WS-Discovery, which mDNS
services it advertises, which ports are open, its MAC vendor and any advertised name), decide whether it's
a camera and how sure we are. The strong, deterministic signals are ONVIF and the mDNS camera services;
open camera ports are a good secondary signal; the MAC OUI only labels the vendor and nudges confidence —
so the verdict never hinges on the OUI table's coverage.
"""

from __future__ import annotations

# Ports distinctive to IP cameras / NVRs (not generic 80/443). Value is the label used in the reason text.
CAMERA_PORTS: dict[int, str] = {
    554: "RTSP",
    8554: "RTSP (alt)",
    1935: "RTMP",
    37777: "Dahua",
    34567: "Dahua/XMeye",
    8000: "Hikvision SDK",
}

# Camera-first vendors: a MAC from one of these is a strong signal on its own.
_CAMERA_FIRST_VENDORS = frozenset(
    {"Hikvision", "Dahua", "Axis", "Reolink", "Amcrest", "Lorex", "Foscam", "Annke", "Ubiquiti", "Wyze",
     "Arlo"}
)
# Vendors that make cameras among plenty of other gear: a weak hint, not a verdict on its own.
_CAMERA_MAYBE_VENDORS = frozenset({"Amazon", "Google", "TP-Link", "Netgear"})

# MAC OUI ("AA:BB:CC", upper) -> vendor. A best-effort *seed* to verify/extend against the IEEE OUI
# registry (https://standards-oui.ieee.org); coverage is deliberately partial because the camera verdict
# leans on ONVIF / mDNS / ports, not this table.
_OUI_VENDORS: dict[str, str] = {
    "44:19:B6": "Hikvision",
    "4C:BD:8F": "Hikvision",
    "C0:56:E3": "Hikvision",
    "3C:EF:8C": "Dahua",
    "90:02:A9": "Dahua",
    "00:40:8C": "Axis",
    "AC:CC:8E": "Axis",
    "EC:71:DB": "Reolink",
    "9C:8E:CD": "Amcrest",
    "FC:EC:DA": "Ubiquiti",
    "74:AC:B9": "Ubiquiti",
    "2C:AA:8E": "Wyze",
}

# Name words that plainly mean "camera".
_CAMERA_NAME_WORDS = ("camera", "ipcam", "cctv", "doorbell", "nvr")


def vendor_for_mac(mac: str | None) -> str | None:
    """Vendor name for a MAC address's OUI, or None. Tolerant of any common MAC spelling."""
    if not mac:
        return None
    digits = [c for c in mac.upper() if c in "0123456789ABCDEF"]
    if len(digits) < 6:
        return None
    oui = ":".join(("".join(digits[0:2]), "".join(digits[2:4]), "".join(digits[4:6])))
    return _OUI_VENDORS.get(oui)


def classify(
    *,
    onvif: bool = False,
    mdns_services: list[str] | None = None,
    open_ports: list[int] | None = None,
    vendor: str | None = None,
    name: str | None = None,
) -> dict:
    """Score a host's camera-ness from its signals.

    Returns ``{is_camera, confidence, vendor, reasons}`` where ``confidence`` is ``"high"|"medium"|"low"``
    or ``None``. A single strong signal (ONVIF, mDNS ONVIF/RTSP, a camera port, or a camera-first MAC
    vendor) is enough to call it a camera; several together raise the confidence.
    """
    mdns_services = mdns_services or []
    open_ports = open_ports or []
    reasons: list[str] = []
    score = 0

    if onvif:
        score += 3
        reasons.append("answered ONVIF WS-Discovery")

    svc = " ".join(mdns_services).lower()
    if "_onvif._tcp" in svc:
        score += 3
        reasons.append("mDNS _onvif._tcp")
    if "_rtsp._tcp" in svc:
        score += 2
        reasons.append("mDNS _rtsp._tcp")

    cam_ports = sorted(p for p in open_ports if p in CAMERA_PORTS)
    if cam_ports:
        score += 2
        reasons.append("open camera port(s): " + ", ".join(f"{p} ({CAMERA_PORTS[p]})" for p in cam_ports))

    if vendor in _CAMERA_FIRST_VENDORS:
        score += 2
        reasons.append(f"MAC vendor {vendor} (camera maker)")
    elif vendor in _CAMERA_MAYBE_VENDORS:
        score += 1
        reasons.append(f"MAC vendor {vendor} (makes cameras among other devices)")
    elif vendor:
        reasons.append(f"MAC vendor {vendor}")

    if name and any(word in name.lower() for word in _CAMERA_NAME_WORDS):
        score += 2
        reasons.append(f"name {name!r} says camera")

    confidence = "high" if score >= 3 else "medium" if score == 2 else "low" if score >= 1 else None
    return {
        "is_camera": score >= 2,
        "confidence": confidence,
        "vendor": vendor,
        "reasons": reasons,
    }
