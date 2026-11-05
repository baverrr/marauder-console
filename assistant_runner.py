"""The Claude assistant's chat runner (Phase 4, slice 2).

An advise-and-draft loop built on the Anthropic SDK's tool use. The model is given a **tightly scoped**
toolset:

* read-only tools that are auto-run and return live state or parsed files
  (``get_status``, ``tail_console``, ``list_tools``, ``list_captures``, ``summarize_pcap``,
  ``wardrive_points``), and
* one draft tool, ``propose_command``, which only *stages* a command into the review area.

There is deliberately **no tool that sends, runs, stops or transmits anything** — the model cannot touch
the serial port. The only command-shaped action it can take is to propose one for the human to run.

The Anthropic SDK and ``keyring`` are imported lazily (inside the functions that need them) so importing
this module — and running the tests, which inject a fake client — needs neither installed.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any

from assistant import ProposalStore, has_control_chars

MODEL_ENV = "MARAUDER_CONSOLE_CLAUDE_MODEL"
DEFAULT_MODEL = "claude-sonnet-5-5"
_MAX_TOOL_TURNS = 8  # cap the tool-use loop so a misbehaving model can't spin forever
_WARDRIVE_SAMPLE = 50  # cap located points returned to the model

SYSTEM_PROMPT = """You are the assistant inside Marauder Console, a control panel for an ESP32 Marauder \
board that the operator owns and is authorised to use. Marauder is a security-testing tool; assume \
authorised, lawful use on the operator's own equipment or an engagement they are cleared for.

What you do: explain what commands and output mean, plan an approach, interpret scans and captures, and \
DRAFT exact command syntax.

What you cannot do: you cannot run anything. You have no tool that sends, runs, stops or transmits a \
command, and the board's serial port is not reachable from here. The only way to put a command forward is \
the propose_command tool, which stages it in a review area for the operator to run themselves with the \
Run control. Never say or imply that you ran, started, stopped or will run a command — say you have \
"staged" or "proposed" it.

When you propose a command that transmits or sends packets (deauth, beacon/probe spam, AP or BLE spoofing, \
evil portal, karma, ping/arp/port scans, joining a network), say plainly that it transmits and that the \
operator must be authorised for the target; it will also require the per-session authorisation before it \
can run.

Ground your answers in the live state and the operator's files using the read-only tools before \
speculating. Be concise and practical."""


def _tool_schemas() -> list[dict]:
    """Anthropic tool definitions. Read-only tools plus the single draft tool — nothing that executes."""
    return [
        {
            "name": "get_status",
            "description": "Current bridge/board status: connected, running, port, baud, firmware, mock.",
            "input_schema": {"type": "object", "properties": {}},
        },
        {
            "name": "tail_console",
            "description": "The last N lines of live serial console output (default 50).",
            "input_schema": {
                "type": "object",
                "properties": {"n": {"type": "integer", "description": "How many trailing lines."}},
            },
        },
        {
            "name": "list_tools",
            "description": "The catalogue of Marauder commands this console knows (name, syntax, class).",
            "input_schema": {"type": "object", "properties": {}},
        },
        {
            "name": "list_captures",
            "description": "Capture/log files available in the capture library.",
            "input_schema": {"type": "object", "properties": {}},
        },
        {
            "name": "summarize_pcap",
            "description": "Read-only packet summary of a .pcap capture (frames, span, SSIDs, BSSIDs).",
            "input_schema": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"],
            },
        },
        {
            "name": "wardrive_points",
            "description": "Located access points from a Wigle wardrive CSV (count, bounds, a sample).",
            "input_schema": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"],
            },
        },
        {
            "name": "propose_command",
            "description": (
                "Stage a command for the operator to review and run. This does NOT run it — it only adds "
                "it to the review area. Use this to suggest any command."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Exact command line to stage."},
                    "rationale": {"type": "string", "description": "Why, in one sentence."},
                },
                "required": ["command"],
            },
        },
    ]


# The read-only tool names — everything except the draft tool. There is intentionally no execute tool.
READ_ONLY_TOOLS = {
    "get_status",
    "tail_console",
    "list_tools",
    "list_captures",
    "summarize_pcap",
    "wardrive_points",
}
ALL_TOOL_NAMES = READ_ONLY_TOOLS | {"propose_command"}


@dataclass
class ChatContext:
    """Everything the tools read or write. No handle here can send a command to the board."""

    manager: Any  # SerialManager — read-only use (status, recent lines)
    captures: Any  # CaptureStore — read-only
    proposals: ProposalStore  # propose_command enqueues here
    tools_catalogue: list[dict]  # the command catalogue, passed in from the UI (tools.ts)


def _dispatch(name: str, tool_input: dict, ctx: ChatContext) -> Any:
    if name == "get_status":
        return ctx.manager.status()
    if name == "tail_console":
        # The model sometimes sends "n" as text or junk; fall back to the default rather than failing the
        # whole chat with a ValueError. History holds at most 300 lines, so clamp to that.
        try:
            n = int(tool_input.get("n", 50) or 50)
        except (TypeError, ValueError):
            n = 50
        return {"lines": ctx.manager.recent_lines(max(1, min(n, 300)))}
    if name == "list_tools":
        return {"tools": ctx.tools_catalogue}
    if name == "list_captures":
        return {"captures": ctx.captures.list_captures()}
    if name == "summarize_pcap":
        data = ctx.captures.summarize(str(tool_input.get("name", "")))
        return data if data is not None else {"error": "no such capture"}
    if name == "wardrive_points":
        data = ctx.captures.wardrive(str(tool_input.get("name", "")))
        if data is None:
            return {"error": "no such wardrive csv"}
        if isinstance(data, dict) and isinstance(data.get("points"), list):
            data = dict(data)
            data["points"] = data["points"][:_WARDRIVE_SAMPLE]  # cap tokens
        return data
    if name == "propose_command":
        command = str(tool_input.get("command", "")).strip()
        if not command:
            return {"error": "empty command"}
        if has_control_chars(command):
            return {"error": "a command must be one line; propose each command separately"}
        p = ctx.proposals.propose(command, str(tool_input.get("rationale", "")))
        # Note the enqueue-only nature back to the model so it never claims execution.
        return {
            "staged": True,
            "id": p["id"],
            "transmits": p["transmits"],
            "note": "staged for review; not run",
        }
    return {"error": f"unknown tool {name}"}


def _field(block: Any, name: str, default: Any = None) -> Any:
    """Read ``name`` off a content block that may be an SDK object or a plain dict."""
    if isinstance(block, dict):
        return block.get(name, default)
    return getattr(block, name, default)


def _block_to_dict(block: Any) -> dict:
    """Normalise an SDK content block (or a fake) to a plain dict for the next request."""
    btype = _field(block, "type")
    if btype == "text":
        return {"type": "text", "text": _field(block, "text", "")}
    if btype == "tool_use":
        return {
            "type": "tool_use",
            "id": _field(block, "id"),
            "name": _field(block, "name"),
            "input": _field(block, "input", {}) or {},
        }
    return {"type": btype}


def run_chat(client: Any, messages: list[dict], ctx: ChatContext, *, model: str | None = None) -> dict:
    """Run the tool-use loop to completion and return the reply text plus which proposals were staged.

    ``client`` is anything exposing ``messages.create(...)`` like the Anthropic SDK (the tests pass a fake),
    so this function itself needs no network and no SDK import.
    """
    model = model or os.environ.get(MODEL_ENV) or DEFAULT_MODEL
    convo = list(messages)
    staged_ids_before = {p["id"] for p in ctx.proposals.list()}
    tools = _tool_schemas()

    reply_text = ""
    for _ in range(_MAX_TOOL_TURNS):
        resp = client.messages.create(
            model=model,
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            tools=tools,
            messages=convo,
        )
        content = list(getattr(resp, "content", []) or [])
        # Only resend text/tool_use blocks — passing back an unknown block type (e.g. "thinking") would
        # make the next messages.create reject the request.
        assistant_blocks = [_block_to_dict(b) for b in content if _field(b, "type") in ("text", "tool_use")]
        convo.append({"role": "assistant", "content": assistant_blocks})

        tool_uses = [b for b in content if _field(b, "type") == "tool_use"]
        texts = [_field(b, "text", "") for b in content if _field(b, "type") == "text"]
        if texts:
            reply_text = "\n".join(t for t in texts if t)

        if getattr(resp, "stop_reason", None) != "tool_use" or not tool_uses:
            break

        results = []
        for tu in tool_uses:
            name = _field(tu, "name")
            tu_id = _field(tu, "id")
            tu_input = _field(tu, "input", {})
            if not isinstance(tu_input, dict):  # the model occasionally returns a non-object input
                tu_input = {}
            result = _dispatch(name, tu_input, ctx)
            results.append(
                {"type": "tool_result", "tool_use_id": tu_id, "content": json.dumps(result)}
            )
        convo.append({"role": "user", "content": results})

    if not reply_text:
        # Loop exhausted while still calling tools, or an empty response — don't return a blank bubble.
        reply_text = "I staged what I could; I hit my tool-call limit before writing a summary."
    added = [p for p in ctx.proposals.list() if p["id"] not in staged_ids_before]
    return {"reply": reply_text, "proposals_added": added}


class KeyStore:
    """Stores the Anthropic API key in the OS keychain (via ``keyring``), with graceful fallbacks.

    Lookup order for the live key: the ``ANTHROPIC_API_KEY`` environment variable, then the OS keychain,
    then an in-process value set this session. The key is never written to the repo, a file, or a log, and
    is never returned to the UI — only whether one is set.
    """

    SERVICE = "marauder-console"
    ACCOUNT = "anthropic-api-key"

    def __init__(self) -> None:
        self._mem: str | None = None

    def _keyring(self) -> Any | None:
        try:
            import keyring  # lazy: the bridge runs fine without it installed

            return keyring
        except Exception:  # noqa: BLE001 - no backend / not installed
            return None

    def set(self, key: str) -> None:
        key = key.strip()
        self._mem = key or None
        kr = self._keyring()
        if kr is not None and key:
            try:
                kr.set_password(self.SERVICE, self.ACCOUNT, key)
            except Exception:  # noqa: BLE001 - keychain locked/unavailable; in-memory still works
                pass

    def get(self) -> str | None:
        env = os.environ.get("ANTHROPIC_API_KEY")
        if env:
            return env
        kr = self._keyring()
        if kr is not None:
            try:
                stored = kr.get_password(self.SERVICE, self.ACCOUNT)
                if stored:
                    return stored
            except Exception:  # noqa: BLE001
                pass
        return self._mem

    def clear(self) -> None:
        self._mem = None
        kr = self._keyring()
        if kr is not None:
            try:
                kr.delete_password(self.SERVICE, self.ACCOUNT)
            except Exception:  # noqa: BLE001 - nothing stored / unavailable
                pass

    def has(self) -> bool:
        return bool(self.get())


def build_client(api_key: str) -> Any:
    """Construct the real Anthropic client (imported lazily so the dep is only needed when chatting)."""
    import anthropic

    return anthropic.Anthropic(api_key=api_key)
