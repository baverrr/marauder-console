"""Tests for the bundled firmware payload.

No hardware and no flashing: these only verify that the vendored binaries match the manifest (so a corrupt
or swapped file is caught before it ever reaches a board) and that the flash offsets are the expected
ESP32 four-file layout.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

FW = Path(__file__).parent / "firmware"


def test_manifest_matches_vendored_files() -> None:
    manifest = json.loads((FW / "manifest.json").read_text())
    assert manifest["chip"] == "esp32"
    assert manifest["upstream"]["license"] == "MIT"
    assert manifest["upstream"]["tag"] == "v1.20.0"

    board = manifest["boards"]["cyd_2432S028"]
    assert [f["offset"] for f in board["files"]] == ["0x1000", "0x8000", "0xe000", "0x10000"]

    for f in board["files"]:
        p = FW / f["path"]
        assert p.is_file(), f"missing {f['path']}"
        data = p.read_bytes()
        assert len(data) == f["bytes"]
        assert hashlib.sha256(data).hexdigest() == f["sha256"], f"sha256 mismatch for {f['path']}"


def test_upstream_license_is_present_and_mit() -> None:
    txt = (FW / "UPSTREAM-LICENSE.txt").read_text()
    assert "MIT License" in txt
    assert "Just Call Me Koko" in txt
