"""Tests for the assistant chat runner — the advise/draft tool loop.

These never hit the network: a fake Anthropic-style client scripts the tool_use → result → text flow. The
central guarantees are pinned here: the toolset exposes no way to execute a command, and the model's only
command-shaped action (``propose_command``) merely stages into the review area.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from assistant import ProposalStore
from assistant_runner import (
    ALL_TOOL_NAMES,
    READ_ONLY_TOOLS,
    ChatContext,
    _dispatch,
    _tool_schemas,
    run_chat,
)
from bridge import SerialManager, create_app


# --- Fake Anthropic client -------------------------------------------------------------------------
class _Block:
    def __init__(self, **kw) -> None:
        self.__dict__.update(kw)


class _Resp:
    def __init__(self, content, stop_reason) -> None:
        self.content = content
        self.stop_reason = stop_reason


class _Messages:
    def __init__(self, scripted) -> None:
        self._scripted = list(scripted)
        self.calls = 0

    def create(self, **_kw) -> _Resp:
        resp = self._scripted[self.calls]
        self.calls += 1
        return resp


class FakeClient:
    def __init__(self, scripted) -> None:
        self.messages = _Messages(scripted)


def _ctx() -> ChatContext:
    mgr = SerialManager(mock=True, port="mock://x", baud=115200)
    return ChatContext(manager=mgr, captures=None, proposals=ProposalStore(), tools_catalogue=[])


def test_toolset_has_no_execute_tool() -> None:
    names = {t["name"] for t in _tool_schemas()}
    assert names == ALL_TOOL_NAMES
    # The only non-read-only tool is the draft tool; nothing sends/runs/stops/transmits.
    assert names - READ_ONLY_TOOLS == {"propose_command"}
    for forbidden in ("send_command", "run_command", "command", "stop", "connect", "transmit", "attack"):
        assert forbidden not in names


def test_propose_command_tool_only_stages() -> None:
    ctx = _ctx()
    out = _dispatch("propose_command", {"command": "attack -t deauth", "rationale": "lab"}, ctx)
    assert out["staged"] is True and out["transmits"] is True
    assert [p["command"] for p in ctx.proposals.list()] == ["attack -t deauth"]
    # Dispatching the tool must not have run anything: a fresh mock manager is never "running".
    assert ctx.manager.status()["running"] is False


def test_propose_command_tool_rejects_multiline_command() -> None:
    # A command smuggling a second line (e.g. via a crafted SSID the model read) must not be staged.
    ctx = _ctx()
    out = _dispatch("propose_command", {"command": "list\nattack -t deauth"}, ctx)
    assert "error" in out
    assert ctx.proposals.list() == []


def test_run_chat_executes_readonly_tool_then_replies() -> None:
    ctx = _ctx()
    scripted = [
        _Resp([_Block(type="tool_use", id="t1", name="get_status", input={})], stop_reason="tool_use"),
        _Resp([_Block(type="text", text="You are not connected yet.")], stop_reason="end_turn"),
    ]
    result = run_chat(FakeClient(scripted), [{"role": "user", "content": "status?"}], ctx)
    assert "not connected" in result["reply"].lower()
    assert result["proposals_added"] == []


def test_run_chat_routes_propose_into_staging() -> None:
    ctx = _ctx()
    scripted = [
        _Resp(
            [_Block(type="tool_use", id="t1", name="propose_command",
                    input={"command": "scanall", "rationale": "find APs"})],
            stop_reason="tool_use",
        ),
        _Resp([_Block(type="text", text="I staged `scanall` for you to run.")], stop_reason="end_turn"),
    ]
    result = run_chat(FakeClient(scripted), [{"role": "user", "content": "find networks"}], ctx)
    assert len(result["proposals_added"]) == 1
    assert result["proposals_added"][0]["command"] == "scanall"
    assert [p["command"] for p in ctx.proposals.list()] == ["scanall"]


# --- Endpoint: key handling + no-key chat ----------------------------------------------------------
@pytest.fixture
def client(tmp_path, monkeypatch) -> Iterator[TestClient]:
    # Isolate from the real OS keychain and env so tests can't read (or leak) a real stored key.
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr("assistant_runner.KeyStore._keyring", lambda self: None)
    app = create_app(mock=True, data_dir=tmp_path)
    with TestClient(app) as c:
        yield c


def test_chat_requires_api_key(client: TestClient) -> None:
    r = client.post("/api/assistant/chat", json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 428
    assert r.json()["ok"] is False


def test_key_status_never_returns_the_value(client: TestClient) -> None:
    assert client.get("/api/assistant/key").json()["has_key"] is False
    body = client.post("/api/assistant/key", json={"key": "sk-ant-test"}).json()
    assert body == {"ok": True, "has_key": True}  # status only, never the key value
    assert client.get("/api/assistant/key").json()["has_key"] is True
    assert client.delete("/api/assistant/key").json()["has_key"] is False


def test_empty_key_rejected(client: TestClient) -> None:
    assert client.post("/api/assistant/key", json={"key": "  "}).status_code == 400
