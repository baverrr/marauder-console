"""Advise-and-draft assistant plumbing (Phase 4).

The Claude assistant may read state and *propose* commands, but it never runs them. A proposal is only ever
enqueued here, into a staging area; the human reviews it and runs it with the normal Run control, where a
transmitting command still has to clear the per-session authorisation. This module holds that staging area
and the transmit check. The LLM runner that calls ``ProposalStore.propose`` (its ``propose_command`` tool)
is added in a later slice — and it, too, can only ever enqueue here.

There is deliberately no path from a proposal to the serial port in this module: staging and execution are
separate, so nothing the assistant does can transmit or run a command on its own.
"""

from __future__ import annotations

import itertools
from datetime import UTC, datetime

# Command verbs that put energy on the air or send packets. Proposals using them are flagged so the human
# sees the risk before running; the verb of an `attack -t <type>` is "attack", which covers every variant.
_TRANSMIT_PREFIXES = (
    "attack",
    "blespam",
    "spoofat",
    "evilportal",
    "karma",
    "pingscan",
    "arpscan",
    "portscan",
    "join",
)


def command_transmits(command: str) -> bool:
    """True if ``command`` would transmit / send packets (used to flag a proposal as risky)."""
    stripped = command.strip()
    if not stripped:
        return False
    return stripped.split()[0].lower().startswith(_TRANSMIT_PREFIXES)


class ProposalStore:
    """In-memory staging area of commands the assistant has proposed. Enqueue-only; never executes."""

    def __init__(self) -> None:
        self._items: list[dict] = []
        self._ids = itertools.count(1)

    def propose(self, command: str, rationale: str = "") -> dict:
        """Stage a proposed command. This only records it for human review — it does not run anything."""
        command = command.strip()
        item = {
            "id": next(self._ids),
            "command": command,
            "rationale": rationale.strip(),
            "transmits": command_transmits(command),
            "created": datetime.now(UTC).isoformat(timespec="seconds"),
        }
        self._items.append(item)
        return item

    def list(self) -> list[dict]:
        return list(self._items)

    def dismiss(self, proposal_id: int) -> bool:
        before = len(self._items)
        self._items = [p for p in self._items if p["id"] != proposal_id]
        return len(self._items) != before

    def clear(self) -> None:
        self._items.clear()
