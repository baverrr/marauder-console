"""Tests for the advise-and-draft assistant plumbing.

The central guarantee of Phase 4 is that the assistant can *propose* a command but never *run* one. These
tests pin that: proposing enqueues into the staging area and does not touch the board (a transmitting
command does not set the running flag, and nothing is sent), and the transmit flag is set correctly.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from assistant import ProposalStore, command_transmits, has_control_chars
from bridge import create_app


@pytest.fixture
def client(tmp_path) -> Iterator[TestClient]:
    app = create_app(mock=True, data_dir=tmp_path)
    with TestClient(app) as c:
        yield c


def test_command_transmits_flags_only_emitting_commands() -> None:
    for cmd in ["attack -t deauth", "attack -t rickroll", "blespam -t all", "evilportal -c start",
                "karma -p 0", "spoofat -t 0", "pingscan", "join MyNet pw"]:
        assert command_transmits(cmd) is True, cmd
    for cmd in ["scanall", "sniffbeacon", "list -a", "info", "", "   "]:
        assert command_transmits(cmd) is False, cmd


def test_proposal_store_enqueues_and_dismisses() -> None:
    store = ProposalStore()
    a = store.propose("scanall", "see nearby APs")
    b = store.propose("attack -t deauth", "disrupt the lab AP")
    assert [p["id"] for p in store.list()] == [a["id"], b["id"]]
    assert a["transmits"] is False and b["transmits"] is True
    assert store.dismiss(a["id"]) is True
    assert [p["id"] for p in store.list()] == [b["id"]]
    assert store.dismiss(9999) is False
    store.clear()
    assert store.list() == []


def test_proposing_a_command_never_runs_it(client: TestClient) -> None:
    client.post("/api/connect")
    # Propose a streaming, transmitting command. If anything executed it, the board would report running.
    resp = client.post(
        "/api/assistant/proposals",
        json={"command": "attack -t deauth", "rationale": "lab test"},
    ).json()
    assert resp["ok"] is True and resp["proposal"]["transmits"] is True

    assert client.get("/api/status").json()["running"] is False  # nothing was executed
    listed = client.get("/api/assistant/proposals").json()["proposals"]
    assert any(p["command"] == "attack -t deauth" for p in listed)


def test_empty_proposal_rejected(client: TestClient) -> None:
    assert client.post("/api/assistant/proposals", json={"command": "   "}).status_code == 400


def test_dismiss_and_clear_endpoints(client: TestClient) -> None:
    pid = client.post("/api/assistant/proposals", json={"command": "info"}).json()["proposal"]["id"]
    assert client.delete(f"/api/assistant/proposals/{pid}").json()["ok"] is True
    client.post("/api/assistant/proposals", json={"command": "scanall"})
    assert client.delete("/api/assistant/proposals").json()["ok"] is True
    assert client.get("/api/assistant/proposals").json()["proposals"] == []


@pytest.mark.parametrize(
    "command", ["list\nattack -t deauth", "info\r\nattack -t beacon", "scanap\rx", "a\x00b"]
)
def test_multiline_or_control_char_proposal_rejected(client: TestClient, command: str) -> None:
    # The transmit flag only looks at the first word, so a hidden second line could pose as harmless.
    assert has_control_chars(command)
    with pytest.raises(ValueError):
        ProposalStore().propose(command)
    resp = client.post("/api/assistant/proposals", json={"command": command})
    assert resp.status_code == 400
    assert client.get("/api/assistant/proposals").json()["proposals"] == []


def test_proposal_store_is_thread_safe() -> None:
    # The chat tool loop stages proposals from a worker thread while the UI dismisses them; none may be
    # lost and ids must stay unique.
    import threading

    store = ProposalStore()
    keep = [store.propose("info")["id"] for _ in range(50)]

    def stage() -> None:
        for _ in range(200):
            store.propose("scanap")

    def churn() -> None:
        for _ in range(200):
            p = store.propose("list")
            store.dismiss(p["id"])

    threads = [threading.Thread(target=stage) for _ in range(4)] + [threading.Thread(target=churn)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    items = store.list()
    assert sum(p["command"] == "scanap" for p in items) == 800
    assert not any(p["command"] == "list" for p in items)
    assert set(keep) <= {p["id"] for p in items}
    assert len({p["id"] for p in items}) == len(items)
