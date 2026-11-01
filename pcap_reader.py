"""Minimal, dependency-free reader for classic ``.pcap`` capture files (Phase 3 PC-side analysis).

The goal is a read-only *summary* of a capture the board wrote to its SD card — frame count, capture span,
link type, and (for 802.11 captures) the SSIDs and BSSIDs seen — not a full packet dissector. It parses
only what that summary needs and skips anything it does not understand, so a malformed or unexpected frame
is ignored rather than fatal. It never writes, injects or transmits; it only reads bytes off disk.

Supports the classic pcap format (both byte orders, microsecond and nanosecond stamps). For 802.11 it
understands bare 802.11 (DLT 105) and radiotap-prefixed 802.11 (DLT 127), pulling the SSID information
element out of beacon, probe-request and probe-response management frames.
"""

from __future__ import annotations

import struct
from pathlib import Path

# pcap link-layer header types we name; others are reported by number.
_LINKTYPES = {0: "null", 1: "ethernet", 105: "ieee802.11", 127: "ieee802.11-radiotap"}
_DOT11_LINKTYPES = {105, 127}

# Bounds so a huge or hostile file can't exhaust memory: stop after this many frames / distinct names.
_MAX_FRAMES = 500_000
_MAX_NAMES = 2_000


def _mac(raw: bytes) -> str:
    return ":".join(f"{b:02x}" for b in raw)


def _parse_tags(frame: bytes, off: int, ssids: set[str]) -> None:
    """Walk 802.11 tagged parameters from ``off``, collecting the SSID element (tag 0)."""
    while off + 2 <= len(frame):
        tag = frame[off]
        length = frame[off + 1]
        off += 2
        if off + length > len(frame):
            break
        if tag == 0 and length > 0:  # SSID element; length 0 is a hidden/wildcard SSID
            ssids.add(frame[off : off + length].decode("utf-8", "replace"))
        off += length


def _parse_dot11(frame: bytes, bssids: set[str], ssids: set[str]) -> None:
    """Best-effort parse of one 802.11 frame for its BSSID and (management frames) its SSID."""
    if len(frame) < 24:
        return
    fc = frame[0] | (frame[1] << 8)
    ftype = (fc >> 2) & 0x3
    subtype = (fc >> 4) & 0xF
    if ftype != 0:  # management frames only (type 0); data/control carry no SSID element
        return
    if len(bssids) < _MAX_NAMES:
        bssids.add(_mac(frame[16:22]))  # addr3 = BSSID for management frames
    # beacon (8) and probe response (5) have 12 bytes of fixed params before the tags; probe request (4)
    # has none.
    if subtype in (8, 5) and len(ssids) < _MAX_NAMES:
        _parse_tags(frame, 36, ssids)
    elif subtype == 4 and len(ssids) < _MAX_NAMES:
        _parse_tags(frame, 24, ssids)


def _dot11_from(link_type: int, payload: bytes) -> bytes:
    """Strip a radiotap header (DLT 127) to expose the 802.11 frame; DLT 105 is already bare."""
    if link_type == 127:
        if len(payload) < 4:
            return b""
        it_len = payload[2] | (payload[3] << 8)  # radiotap is always little-endian
        return payload[it_len:] if 0 < it_len <= len(payload) else b""
    return payload


def summarize_pcap(path: str | Path) -> dict:
    """Read ``path`` and return a summary dict. Raises ``ValueError`` if it is not a classic pcap."""
    with open(path, "rb") as fh:
        header = fh.read(24)
        if len(header) < 24:
            raise ValueError("file too short to be a pcap")
        magic = header[:4]
        if magic in (b"\xa1\xb2\xc3\xd4", b"\xa1\xb2\x3c\x4d"):
            endian = ">"
        elif magic in (b"\xd4\xc3\xb2\xa1", b"\x4d\x3c\xb2\xa1"):
            endian = "<"
        else:
            raise ValueError("not a pcap file (bad magic)")
        nanos = magic in (b"\xa1\xb2\x3c\x4d", b"\x4d\x3c\xb2\xa1")
        link_type = struct.unpack(endian + "I", header[20:24])[0]

        frames = 0
        total_bytes = 0
        first_ts: float | None = None
        last_ts: float | None = None
        bssids: set[str] = set()
        ssids: set[str] = set()
        truncated = False
        rec_fmt = endian + "IIII"

        while True:
            rec = fh.read(16)
            if len(rec) < 16:
                break
            ts_sec, ts_frac, incl_len, _orig_len = struct.unpack(rec_fmt, rec)
            data = fh.read(incl_len)
            if len(data) < incl_len:
                break  # truncated final record
            frames += 1
            total_bytes += incl_len
            ts = ts_sec + ts_frac / (1_000_000_000 if nanos else 1_000_000)
            first_ts = ts if first_ts is None else min(first_ts, ts)
            last_ts = ts if last_ts is None else max(last_ts, ts)
            if link_type in _DOT11_LINKTYPES:
                dot11 = _dot11_from(link_type, data)
                if dot11:
                    _parse_dot11(dot11, bssids, ssids)
            if frames >= _MAX_FRAMES:
                truncated = True
                break

    duration = (last_ts - first_ts) if (first_ts is not None and last_ts is not None) else 0.0
    return {
        "kind": "pcap",
        "link_type": link_type,
        "link_type_name": _LINKTYPES.get(link_type, f"type {link_type}"),
        "frames": frames,
        "bytes": total_bytes,
        "first": first_ts,
        "last": last_ts,
        "duration": round(duration, 3),
        "bssids": sorted(bssids),
        "ssids": sorted(ssids),
        "truncated": truncated,
    }
