"""Local capture/log library for the PC-side analysis views (Phase 3).

Marauder writes PCAPs, wardrive CSVs and logs to its SD card. The usual way to get them onto the PC is to
copy them into a *captures* folder; this module lists what is in that folder and summarises a chosen file —
a packet summary for ``.pcap`` (via :mod:`pcap_reader`), or a short text preview for CSV/log files.

Like the session store, it only ever reads files that are already in the captures directory: a requested
name is matched against the directory listing, and the path that gets opened comes from that listing, never
built from the request — so a crafted name cannot escape the folder. Nothing here touches the serial port.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from pathlib import Path

# Extensions the library surfaces, grouped by how they are summarised.
_PCAP_EXTS = {".pcap", ".pcapng", ".cap"}
_TEXT_EXTS = {".csv", ".log", ".txt", ".nmea"}
_KNOWN_EXTS = _PCAP_EXTS | _TEXT_EXTS

_TEXT_PREVIEW_LINES = 200
_TEXT_PREVIEW_BYTES = 64 * 1024  # cap how much of a text file we read for the preview


def resolve_captures_dir(data_dir: Path) -> Path:
    """Where capture files live. Overridable with ``MARAUDER_CONSOLE_CAPTURES_DIR``; otherwise a
    ``captures`` folder under the data dir."""
    env = os.environ.get("MARAUDER_CONSOLE_CAPTURES_DIR")
    return Path(env) if env else Path(data_dir) / "captures"


def _kind(suffix: str) -> str:
    return "pcap" if suffix in _PCAP_EXTS else "text"


class CaptureStore:
    """Lists and summarises files in the captures directory."""

    def __init__(self, directory: Path) -> None:
        self._dir = Path(directory)

    def list_captures(self) -> list[dict]:
        """Metadata for every recognised file in the captures dir (top level), newest first."""
        if not self._dir.is_dir():
            return []
        out: list[dict] = []
        for p in self._dir.iterdir():
            if not p.is_file() or p.suffix.lower() not in _KNOWN_EXTS:
                continue
            try:
                st = p.stat()
            except OSError:
                continue
            out.append(
                {
                    "name": p.name,
                    "size": st.st_size,
                    "modified": datetime.fromtimestamp(st.st_mtime, UTC).isoformat(timespec="seconds"),
                    "kind": _kind(p.suffix.lower()),
                }
            )
        out.sort(key=lambda m: m["modified"], reverse=True)
        return out

    def _match(self, name: str) -> Path | None:
        """The listed file whose name equals ``name`` (matched against the directory, not built from it)."""
        if not self._dir.is_dir():
            return None
        for p in self._dir.iterdir():
            if p.is_file() and p.name == name and p.suffix.lower() in _KNOWN_EXTS:
                return p
        return None

    def summarize(self, name: str) -> dict | None:
        """A packet summary for a pcap, or a text preview for CSV/log files; ``None`` if no such file."""
        path = self._match(name)
        if path is None:
            return None
        if path.suffix.lower() in _PCAP_EXTS:
            from pcap_reader import summarize_pcap

            try:
                summary = summarize_pcap(path)
            except ValueError:
                # Fixed, non-exception-derived message (raw exception text is kept out of the response).
                return {"kind": "error", "name": name, "error": "not a readable pcap file"}
            except OSError:
                return {"kind": "error", "name": name, "error": "could not read this file"}
            summary["name"] = name
            return summary
        return self._text_preview(path, name)

    def wardrive(self, name: str) -> dict | None:
        """Parse a Wigle wardrive CSV into located points for the map, or ``None`` if no such file."""
        path = self._match(name)
        if path is None or path.suffix.lower() != ".csv":
            return None
        from wigle_reader import parse_wigle

        try:
            data = parse_wigle(path)
        except Exception:  # noqa: BLE001 - untrusted file: any parse error (OSError, csv.Error, …) → fixed msg
            return {"kind": "error", "name": name, "error": "could not read this file"}
        data["name"] = name
        return data

    def _text_preview(self, path: Path, name: str) -> dict:
        try:
            with path.open("r", encoding="utf-8", errors="replace") as fh:
                blob = fh.read(_TEXT_PREVIEW_BYTES)
        except OSError:
            return {"kind": "error", "name": name, "error": "could not read this file"}
        lines = blob.splitlines()
        truncated = len(lines) > _TEXT_PREVIEW_LINES
        return {
            "kind": "text",
            "name": name,
            "preview": lines[:_TEXT_PREVIEW_LINES],
            "truncated": truncated,
        }
