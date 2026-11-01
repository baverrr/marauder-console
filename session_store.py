"""Local, on-disk store of console sessions for later review (Phase 3 PC-side analysis).

A *session* is one connect→disconnect span. While connected, the bridge records every command it sends
and every line it receives into an append-only NDJSON file, with a small ``meta.json`` kept alongside it.
Nothing here touches the serial port; it only persists what already flowed through the bridge, so saved
sessions can be browsed offline with the board unplugged.

Storage layout, under ``<data_dir>/sessions/``::

    <id>.ndjson   one JSON event per line: {"t": <iso>, "k": "command"|"line", "d": <text>}
    <id>.json     metadata: {"id", "started", "ended"|null, "port", "mock", "commands", "lines"}

Everything is local to the user's machine. Captures and transcripts can hold real identifiers, so the
store never sends anything anywhere — it only reads and writes these files.
"""

from __future__ import annotations

import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path

# The id shape the store itself mints (see ``SessionStore.start``). Used to reject anything else from a
# URL path, so a request can't walk out of the sessions directory.
_SAFE_ID = re.compile(r"^[0-9]{8}T[0-9]{6}_[0-9]{1,6}$")


def resolve_data_dir() -> Path:
    """Where to keep session files. The Tauri shell passes its per-OS app-data dir; otherwise fall back
    to the XDG data home (``~/.local/share/marauder-console``)."""
    env = os.environ.get("MARAUDER_CONSOLE_DATA_DIR")
    if env:
        return Path(env)
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return base / "marauder-console"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class SessionRecorder:
    """One in-progress session: appends events to its NDJSON file and keeps its ``meta.json`` current."""

    def __init__(self, directory: Path, session_id: str, meta: dict) -> None:
        self.id = session_id
        self._events_path = directory / f"{session_id}.ndjson"
        self._meta_path = directory / f"{session_id}.json"
        self._meta = meta
        self._commands = 0
        self._lines = 0
        self._write_meta()

    def _write_meta(self) -> None:
        self._meta_path.write_text(json.dumps(self._meta), encoding="utf-8")

    def log(self, kind: str, text: str) -> None:
        """Append one recorded event. ``kind`` is "command" (sent) or "line" (received)."""
        if kind == "command":
            self._commands += 1
        else:
            self._lines += 1
        with self._events_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"t": _now_iso(), "k": kind, "d": text}) + "\n")

    def finish(self) -> None:
        """Stamp the end time and final counts. A session with ``ended: null`` was never finished."""
        self._meta["ended"] = _now_iso()
        self._meta["commands"] = self._commands
        self._meta["lines"] = self._lines
        self._write_meta()


class SessionStore:
    """Creates recorders and reads back saved sessions from ``<data_dir>/sessions/``."""

    def __init__(self, data_dir: Path) -> None:
        self._dir = Path(data_dir) / "sessions"

    def start(self, *, port: str, mock: bool) -> SessionRecorder:
        self._dir.mkdir(parents=True, exist_ok=True)
        session_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%S_%f")
        meta = {
            "id": session_id,
            "started": _now_iso(),
            "ended": None,
            "port": port,
            "mock": mock,
            "commands": 0,
            "lines": 0,
        }
        return SessionRecorder(self._dir, session_id, meta)

    def list_sessions(self) -> list[dict]:
        """Metadata for every saved session, newest first."""
        if not self._dir.is_dir():
            return []
        out: list[dict] = []
        for meta_path in self._dir.glob("*.json"):
            try:
                out.append(json.loads(meta_path.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                continue  # skip a half-written or corrupt meta file rather than failing the listing
        out.sort(key=lambda m: m.get("started", ""), reverse=True)
        return out

    def read_session(self, session_id: str) -> dict | None:
        """One session's metadata plus its ordered events, or ``None`` if there is no such session.

        The requested id is matched against the names of files already in the sessions directory, and the
        paths that get opened come from that directory listing — never built from the id — so a crafted id
        (``..``, an absolute path) cannot escape the directory. The anchored ``_SAFE_ID`` check rejects
        obviously bad input up front."""
        if not _SAFE_ID.match(session_id) or not self._dir.is_dir():
            return None
        meta_path: Path | None = next((p for p in self._dir.glob("*.json") if p.stem == session_id), None)
        if meta_path is None:
            return None
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        events: list[dict] = []
        events_path = meta_path.with_suffix(".ndjson")  # derived from the listed path, not from the id
        if events_path.is_file():
            for line in events_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return {"meta": meta, "events": events}
