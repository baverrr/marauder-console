"""Parser for Wigle-format wardrive CSV logs (Phase 3 PC-side analysis, wardrive map).

Marauder's ``wardrive`` writes a Wigle CSV: a ``WigleWifi-1.x`` pre-header line, then a column header
(``MAC,SSID,AuthMode,FirstSeen,Channel,RSSI,CurrentLatitude,CurrentLongitude,…``), then one row per
observation. This turns such a file into a list of located points for the map view.

Rows without a usable GPS fix (latitude and longitude both 0, unparseable, or out of range) are dropped —
the board writes 0,0 when it has no fix. Read-only; the file is one the user already copied into the
captures folder.
"""

from __future__ import annotations

import csv
import math
from pathlib import Path

_MAX_POINTS = 50_000


def _to_float(value: str) -> float | None:
    """A finite float, or None. ``float()`` accepts "nan" and "inf", which JSON can't carry, so those are
    treated as unparseable rather than reaching the API response (and failing it with a 500)."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _cell(row: list[str], cols: dict[str, int], name: str, default: str = "") -> str:
    i = cols.get(name)
    return row[i].strip() if i is not None and i < len(row) else default


def parse_wigle(path: str | Path) -> dict:
    """Return ``{"points": [...], "count": n, "bounds": {...} | None}`` for a Wigle CSV.

    Each point is ``{mac, ssid, auth, channel, rssi, lat, lon}``. ``bounds`` spans the located points, or
    is ``None`` when none have a fix."""
    points: list[dict] = []
    truncated = False
    with open(path, encoding="utf-8", errors="replace", newline="") as fh:
        reader = csv.reader(fh)
        cols: dict[str, int] | None = None
        for row in reader:
            if not row:
                continue
            if cols is None:
                # The column header is the row whose first cell is "MAC"; skip the WigleWifi pre-header.
                if row[0].strip().upper() == "MAC":
                    cols = {name.strip(): i for i, name in enumerate(row)}
                continue

            lat = _to_float(_cell(row, cols, "CurrentLatitude"))
            lon = _to_float(_cell(row, cols, "CurrentLongitude"))
            if lat is None or lon is None or (lat == 0.0 and lon == 0.0):
                continue  # no GPS fix for this observation
            if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
                continue  # not a real coordinate (a corrupt row); it would also wreck the map bounds
            points.append(
                {
                    "mac": _cell(row, cols, "MAC"),
                    "ssid": _cell(row, cols, "SSID"),
                    "auth": _cell(row, cols, "AuthMode"),
                    "channel": _cell(row, cols, "Channel"),
                    "rssi": _to_float(_cell(row, cols, "RSSI")),
                    "lat": lat,
                    "lon": lon,
                }
            )
            if len(points) >= _MAX_POINTS:
                truncated = True
                break

    bounds = None
    if points:
        lats = [p["lat"] for p in points]
        lons = [p["lon"] for p in points]
        bounds = {
            "min_lat": min(lats),
            "max_lat": max(lats),
            "min_lon": min(lons),
            "max_lon": max(lons),
        }
    return {
        "kind": "wardrive",
        "points": points,
        "count": len(points),
        "bounds": bounds,
        "truncated": truncated,
    }
